import pool from '../db';

export interface QuoteData {
  ticker: string;
  price: number;
  previousClose: number;
  change1d: number;         // % change
  marketCap?: number;
  week52High?: number;
  week52Low?: number;
  volume?: number;
  currency: string;
  name?: string;
  lastUpdated: string;
}

// yahoo-finance2 is ESM-only (exports via package.json "exports" → ESM only).
// Dynamic import returns a module namespace; default export is the YahooFinance CLASS
// (createYahooFinance returns the class, not an instance). We must call new.
let _yahooFinanceInstance: any = null;
async function getYahooFinance(): Promise<any> {
  if (_yahooFinanceInstance) return _yahooFinanceInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await (Function('return import("yahoo-finance2")')() as Promise<any>);
  const YFClass = mod.default ?? mod;
  // YFClass is the class; instance methods (quote, autoc) live on the prototype
  _yahooFinanceInstance = typeof YFClass === 'function' ? new YFClass() : YFClass;
  return _yahooFinanceInstance;
}

export async function fetchQuote(ticker: string): Promise<QuoteData> {
  const yahooFinance = await getYahooFinance();
  const quote = await yahooFinance.quote(ticker);

  const price: number = quote.regularMarketPrice ?? 0;
  const previousClose: number = quote.regularMarketPreviousClose ?? price;
  const change1d = previousClose !== 0
    ? ((price - previousClose) / previousClose) * 100
    : 0;

  return {
    ticker,
    price,
    previousClose,
    change1d,
    marketCap: quote.marketCap ?? undefined,
    week52High: quote.fiftyTwoWeekHigh ?? undefined,
    week52Low: quote.fiftyTwoWeekLow ?? undefined,
    volume: quote.regularMarketVolume ?? undefined,
    currency: quote.currency ?? 'USD',
    name: quote.longName ?? quote.shortName ?? undefined,
    lastUpdated: new Date().toISOString(),
  };
}

export async function fetchMultipleQuotes(tickers: string[]): Promise<QuoteData[]> {
  const results: QuoteData[] = [];

  // Fetch in batches of 10 to avoid rate limits
  const batchSize = 10;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((ticker) => fetchQuote(ticker))
    );
    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      }
    }
  }

  return results;
}

export async function refreshAllCompanyPrices(): Promise<{ updated: number; errors: string[] }> {
  // Get all companies that have tickers
  const companiesResult = await pool.query(
    `SELECT id, ticker, entry_price, entry_date FROM companies WHERE ticker IS NOT NULL AND ticker != ''`
  );

  const companies = companiesResult.rows;
  if (companies.length === 0) {
    return { updated: 0, errors: [] };
  }

  const tickers = companies.map((c: any) => c.ticker as string);
  const quotes = await fetchMultipleQuotes(tickers);

  const quoteMap = new Map<string, QuoteData>();
  for (const quote of quotes) {
    quoteMap.set(quote.ticker.toUpperCase(), quote);
  }

  let updated = 0;
  const errors: string[] = [];

  for (const company of companies) {
    const quote = quoteMap.get((company.ticker as string).toUpperCase());
    if (!quote) {
      errors.push(`No quote for ${company.ticker as string}`);
      continue;
    }

    try {
      await pool.query(
        `UPDATE companies SET
          current_price = $1,
          price_change_1d = $2,
          week_52_high = $3,
          week_52_low = $4,
          market_cap = $5,
          last_price_update = NOW(),
          updated_at = NOW()
        WHERE id = $6`,
        [
          quote.price,
          quote.change1d,
          quote.week52High ?? null,
          quote.week52Low ?? null,
          quote.marketCap ?? null,
          company.id as string,
        ]
      );

      // Take a price snapshot for today (upsert)
      await pool.query(
        `INSERT INTO price_snapshots (company_id, price, market_cap, source, snapshot_date)
         VALUES ($1, $2, $3, 'yahoo', CURRENT_DATE)
         ON CONFLICT (company_id, snapshot_date) DO UPDATE SET
           price = EXCLUDED.price,
           market_cap = EXCLUDED.market_cap`,
        [company.id as string, quote.price, quote.marketCap ?? null]
      );

      // Update fundamentals (pe_ratio, ev_ebitda, sector) only if currently null/empty
      try {
        const funds = await fetchFundamentals(company.ticker as string).catch(() => null);
        if (funds) {
          await pool.query(
            `UPDATE companies SET
              pe_ratio   = COALESCE(pe_ratio,   $1),
              ev_ebitda  = COALESCE(ev_ebitda,  $2),
              sector     = COALESCE(NULLIF(sector,''), $3)
             WHERE id = $4`,
            [
              funds.trailingPE   ?? null,
              funds.enterpriseToEbitda ?? null,
              funds.sector       ?? null,
              company.id as string,
            ]
          );
        }
      } catch (_) { /* non-fatal */ }

      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to update ${company.ticker as string}: ${msg}`);
    }
  }

  return { updated, errors };
}

export interface FundamentalsData {
  ticker: string;
  name?: string;
  price?: number;
  currency?: string;
  marketCap?: number;
  trailingPE?: number;
  forwardPE?: number;
  priceToBook?: number;
  enterpriseToEbitda?: number;   // EV/EBITDA
  enterpriseToRevenue?: number;  // EV/Revenue
  week52High?: number;
  week52Low?: number;
  sector?: string;
  industry?: string;
  shortName?: string;
  longName?: string;
}

export async function fetchFundamentals(ticker: string): Promise<FundamentalsData> {
  const yahooFinance = await getYahooFinance();
  // This version of yahoo-finance2 only has `quote` and `autoc` modules.
  // The v7 quote API returns enough fields for our needs (PE, EV/EBITDA, sector, etc.)
  const q = await yahooFinance.quote(ticker);

  return {
    ticker,
    name: q?.longName ?? q?.shortName ?? undefined,
    price: q?.regularMarketPrice ?? undefined,
    currency: q?.currency ?? undefined,
    marketCap: q?.marketCap ?? undefined,
    trailingPE: q?.trailingPE ?? undefined,
    forwardPE: q?.forwardPE ?? undefined,
    priceToBook: q?.priceToBook ?? undefined,
    enterpriseToEbitda: q?.enterpriseToEbitda ?? undefined,
    enterpriseToRevenue: q?.enterpriseToRevenue ?? undefined,
    week52High: q?.fiftyTwoWeekHigh ?? undefined,
    week52Low: q?.fiftyTwoWeekLow ?? undefined,
    sector: q?.sector ?? undefined,
    industry: q?.industry ?? undefined,
  };
}

export function calculateCAGR(entryPrice: number, currentPrice: number, entryDate: string): number {
  const years = (Date.now() - new Date(entryDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (years <= 0) return 0;
  return (Math.pow(currentPrice / entryPrice, 1 / years) - 1) * 100;
}

export function calculateUpside(currentPrice: number, targetPrice: number): number {
  return ((targetPrice - currentPrice) / currentPrice) * 100;
}
