import pool from '../db';

export interface QuoteData {
  ticker: string;
  price: number;
  previousClose: number;
  change1d: number;
  marketCap?: number;
  week52High?: number;
  week52Low?: number;
  volume?: number;
  currency: string;
  name?: string;
  lastUpdated: string;
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
  enterpriseToEbitda?: number;
  enterpriseToRevenue?: number;
  week52High?: number;
  week52Low?: number;
  sector?: string;
  industry?: string;
  shortName?: string;
  longName?: string;
}

/* ─── Custom Yahoo Finance HTTP client ────────────────────────────── */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

type CrumbState = { crumb: string; cookies: string; expiry: number } | null;
let _crumb: CrumbState = null;
let _crumbPromise: Promise<{ crumb: string; cookies: string }> | null = null;

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function _fetchCrumb(): Promise<{ crumb: string; cookies: string }> {
  // Collect cookies from finance.yahoo.com
  let cookies = '';
  try {
    const homeRes = await fetch('https://finance.yahoo.com/', {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    // Node 18+ supports getSetCookie() for multiple Set-Cookie headers
    const setCookies: string[] = (homeRes.headers as any).getSetCookie?.() ??
      [homeRes.headers.get('set-cookie') ?? ''];
    cookies = setCookies
      .map((c: string) => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  } catch {
    // If we can't get cookies, try without — Yahoo sometimes works
  }

  // Fetch crumb with retry + exponential backoff for 429
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * Math.pow(2, attempt - 1), 16000));
    try {
      const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
          'User-Agent': UA,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': cookies,
          'Origin': 'https://finance.yahoo.com',
          'Referer': 'https://finance.yahoo.com/',
        },
      });
      if (res.status === 429) continue;
      if (res.status === 200) {
        const crumb = (await res.text()).trim();
        if (crumb) {
          _crumb = { crumb, cookies, expiry: Date.now() + 20 * 60 * 1000 };
          return { crumb, cookies };
        }
      }
    } catch { /* retry */ }
  }
  throw new Error('Failed to obtain Yahoo Finance crumb after retries');
}

async function ensureCrumb(): Promise<{ crumb: string; cookies: string }> {
  if (_crumb && Date.now() < _crumb.expiry) return _crumb;
  // Deduplicate concurrent crumb requests
  if (!_crumbPromise) {
    _crumbPromise = _fetchCrumb().finally(() => { _crumbPromise = null; });
  }
  return _crumbPromise;
}

async function yahooV7Quote(ticker: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { crumb, cookies } = await ensureCrumb();
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&crumb=${encodeURIComponent(crumb)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': cookies,
          'Origin': 'https://finance.yahoo.com',
          'Referer': `https://finance.yahoo.com/quote/${ticker}/`,
        },
      });
      if (res.status === 401 || res.status === 403) {
        // Crumb expired — reset and retry
        _crumb = null;
        continue;
      }
      if (res.status === 429) {
        await sleep(2000 * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) throw new Error(`Yahoo v7 API status ${res.status}`);
      const json = await res.json() as any;
      return json?.quoteResponse?.result?.[0] ?? null;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

// v8 chart API — no crumb needed, reliable for price data.
// Tries query1 then query2 host for resilience against per-host rate limiting.
async function yahooV8Chart(ticker: string): Promise<any> {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr: unknown = null;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d&includePrePost=false`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://finance.yahoo.com',
          'Referer': `https://finance.yahoo.com/quote/${ticker}/`,
        },
      });
      if (!res.ok) { lastErr = new Error(`Yahoo v8 chart API status ${res.status}`); continue; }
      const json = await res.json() as any;
      return json?.chart?.result?.[0]?.meta ?? null;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('Yahoo v8 chart API failed');
}

// v10 quoteSummary — fundamentals (PE, EV/EBITDA, margins). Needs crumb; best-effort.
async function yahooV10Summary(ticker: string): Promise<any> {
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,price,assetProfile';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { crumb, cookies } = await ensureCrumb();
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Cookie': cookies,
          'Origin': 'https://finance.yahoo.com',
          'Referer': `https://finance.yahoo.com/quote/${ticker}/`,
        },
      });
      if (res.status === 401 || res.status === 403) { _crumb = null; continue; }
      if (!res.ok) return null;
      const json = await res.json() as any;
      return json?.quoteSummary?.result?.[0] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

// Unwrap Yahoo's { raw, fmt } number objects (v10) or plain numbers.
function rawNum(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  if (typeof v === 'object' && typeof v.raw === 'number') return isFinite(v.raw) ? v.raw : undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

/* ─── Public API ──────────────────────────────────────────────────── */

export async function fetchQuote(ticker: string): Promise<QuoteData> {
  // v8 chart is the reliable base (no crumb required). v7 quote enriches when the
  // crumb flow works, but a crumb failure must never break adding/refreshing a ticker.
  const meta = await yahooV8Chart(ticker);
  if (!meta || meta.regularMarketPrice == null) {
    throw new Error(`No market data for ticker "${ticker}"`);
  }

  let q: any = null;
  try { q = await yahooV7Quote(ticker); } catch { /* enrichment optional */ }

  const price: number = q?.regularMarketPrice ?? meta.regularMarketPrice ?? 0;
  const prev: number  = q?.regularMarketPreviousClose ?? meta.previousClose ?? meta.chartPreviousClose ?? price;
  const change = prev !== 0 ? ((price - prev) / prev) * 100 : 0;
  return {
    ticker,
    price,
    previousClose: prev,
    change1d: change,
    marketCap:  q?.marketCap ?? meta.marketCap ?? undefined,
    week52High: q?.fiftyTwoWeekHigh ?? meta.fiftyTwoWeekHigh ?? undefined,
    week52Low:  q?.fiftyTwoWeekLow  ?? meta.fiftyTwoWeekLow  ?? undefined,
    volume:     q?.regularMarketVolume ?? undefined,
    currency:   q?.currency ?? meta.currency ?? 'USD',
    name:       q?.longName ?? q?.shortName ?? meta.longName ?? meta.shortName ?? undefined,
    lastUpdated: new Date().toISOString(),
  };
}

export async function fetchMultipleQuotes(tickers: string[]): Promise<QuoteData[]> {
  const results: QuoteData[] = [];
  const batchSize = 10;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fetchQuote));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
    if (i + batchSize < tickers.length) await sleep(500); // gentle rate-limiting
  }
  return results;
}

export async function refreshAllCompanyPrices(): Promise<{ updated: number; errors: string[] }> {
  const { rows: companies } = await pool.query(
    `SELECT id, ticker, entry_price, entry_date FROM companies WHERE ticker IS NOT NULL AND ticker != ''`
  );
  if (companies.length === 0) return { updated: 0, errors: [] };

  const tickers = companies.map((c: any) => c.ticker as string);
  const quotes  = await fetchMultipleQuotes(tickers);
  const quoteMap = new Map(quotes.map(q => [q.ticker.toUpperCase(), q]));

  let updated = 0;
  const errors: string[] = [];

  for (const company of companies) {
    const quote = quoteMap.get((company.ticker as string).toUpperCase());
    if (!quote) { errors.push(`No quote for ${company.ticker}`); continue; }

    try {
      await pool.query(
        `UPDATE companies SET
          current_price = $1, price_change_1d = $2,
          week_52_high = $3, week_52_low = $4,
          market_cap = $5, last_price_update = NOW(), updated_at = NOW()
         WHERE id = $6`,
        [quote.price, quote.change1d, quote.week52High ?? null,
         quote.week52Low ?? null, quote.marketCap ?? null, company.id as string]
      );

      await pool.query(
        `INSERT INTO price_snapshots (company_id, price, market_cap, source, snapshot_date)
         VALUES ($1, $2, $3, 'yahoo', CURRENT_DATE)
         ON CONFLICT (company_id, snapshot_date) DO UPDATE SET
           price = EXCLUDED.price, market_cap = EXCLUDED.market_cap`,
        [company.id as string, quote.price, quote.marketCap ?? null]
      );

      // Back-fill fundamentals only if currently null
      try {
        const funds = await fetchFundamentals(company.ticker as string).catch(() => null);
        if (funds) {
          await pool.query(
            `UPDATE companies SET
              pe_ratio  = COALESCE(pe_ratio,  $1),
              ev_ebitda = COALESCE(ev_ebitda, $2),
              sector    = COALESCE(NULLIF(sector,''), $3)
             WHERE id = $4`,
            [funds.trailingPE ?? null, funds.enterpriseToEbitda ?? null,
             funds.sector ?? null, company.id as string]
          );
        }
      } catch { /* non-fatal */ }

      updated++;
    } catch (err) {
      errors.push(`Failed to update ${company.ticker}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { updated, errors };
}

export async function fetchFundamentals(ticker: string): Promise<FundamentalsData> {
  // Reliable price base from v8 chart; never hard-fail for a valid ticker.
  const meta = await yahooV8Chart(ticker);
  if (!meta || meta.regularMarketPrice == null) {
    throw new Error(`No market data for ticker "${ticker}"`);
  }

  const data: FundamentalsData = {
    ticker,
    name:      meta.longName ?? meta.shortName ?? undefined,
    price:     meta.regularMarketPrice ?? undefined,
    currency:  meta.currency ?? undefined,
    marketCap: meta.marketCap ?? undefined,
    week52High: meta.fiftyTwoWeekHigh ?? undefined,
    week52Low:  meta.fiftyTwoWeekLow  ?? undefined,
  };

  // Enrich with v7 quote (fast, single object).
  let q: any = null;
  try { q = await yahooV7Quote(ticker); } catch { /* optional */ }
  if (q) {
    data.name                = q.longName ?? q.shortName ?? data.name;
    data.price               = q.regularMarketPrice ?? data.price;
    data.currency            = q.currency ?? data.currency;
    data.marketCap           = q.marketCap ?? data.marketCap;
    data.trailingPE          = rawNum(q.trailingPE) ?? data.trailingPE;
    data.forwardPE           = rawNum(q.forwardPE) ?? data.forwardPE;
    data.priceToBook         = rawNum(q.priceToBook) ?? data.priceToBook;
    data.enterpriseToEbitda  = rawNum(q.enterpriseToEbitda) ?? data.enterpriseToEbitda;
    data.enterpriseToRevenue = rawNum(q.enterpriseToRevenue) ?? data.enterpriseToRevenue;
    data.week52High          = q.fiftyTwoWeekHigh ?? data.week52High;
    data.week52Low           = q.fiftyTwoWeekLow ?? data.week52Low;
    data.sector              = q.sector ?? data.sector;
    data.industry            = q.industry ?? data.industry;
  }

  // If fundamentals still missing (v7 blocked), try v10 quoteSummary.
  if (data.trailingPE == null || data.enterpriseToEbitda == null || data.sector == null) {
    const s = await yahooV10Summary(ticker);
    if (s) {
      const sd = s.summaryDetail ?? {};
      const ks = s.defaultKeyStatistics ?? {};
      const prof = s.assetProfile ?? {};
      data.trailingPE          = data.trailingPE          ?? rawNum(sd.trailingPE);
      data.forwardPE           = data.forwardPE           ?? rawNum(sd.forwardPE) ?? rawNum(ks.forwardPE);
      data.priceToBook         = data.priceToBook         ?? rawNum(ks.priceToBook);
      data.enterpriseToEbitda  = data.enterpriseToEbitda  ?? rawNum(ks.enterpriseToEbitda);
      data.enterpriseToRevenue = data.enterpriseToRevenue ?? rawNum(ks.enterpriseToRevenue);
      data.marketCap           = data.marketCap           ?? rawNum(sd.marketCap);
      data.sector              = data.sector              ?? prof.sector ?? undefined;
      data.industry            = data.industry            ?? prof.industry ?? undefined;
    }
  }

  return data;
}

export function calculateCAGR(entryPrice: number, currentPrice: number, entryDate: string): number {
  const years = (Date.now() - new Date(entryDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (years <= 0) return 0;
  return (Math.pow(currentPrice / entryPrice, 1 / years) - 1) * 100;
}

export function calculateUpside(currentPrice: number, targetPrice: number): number {
  return ((targetPrice - currentPrice) / currentPrice) * 100;
}
