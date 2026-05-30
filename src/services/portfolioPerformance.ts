import pool from '../db';

// Note: yahoo-finance2 v2.14.0 only ships quote+autoc; no historical module.
// Benchmark history is fetched via the Yahoo Finance v8 chart API directly.
const BENCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export interface PeriodReturn {
  period: string;        // "Q1 2025" or "2025-01" for monthly
  period_type: 'monthly' | 'quarterly';
  period_start: string;  // ISO date
  period_end: string;    // ISO date
  portfolio_return: number;      // %
  msci_world_return: number | null;
  sp500_return: number | null;
  vs_msci: number | null;
  vs_sp500: number | null;
  // detail
  positions_count: number;
}

export interface PortfolioSummary {
  total_invested: number | null;   // sum of position_size * entry_price (if available)
  total_current_value: number | null;
  total_return_pct: number | null;  // weighted avg
  total_return_abs: number | null;
  weighted_pe: number | null;
  weighted_ev_ebitda: number | null;
  weighted_upside: number | null;
  weighted_cagr: number | null;
  ytd_portfolio?: number;          // sum of ytd_contributions (pp)
  positions: PortfolioPosition[];
}

export interface PortfolioPosition {
  id: string;
  name: string;
  ticker?: string;
  sector?: string;
  currency: string;
  entry_price?: number;
  entry_date?: string;
  current_price?: number;
  target_price?: number;
  shares?: number;          // "Cantidad" from the year sheet
  market_value?: number;    // shares × current_price, converted to USD
  position_size?: number;   // weight % — computed from market_value / total
  pe_ratio?: number;
  ev_ebitda?: number;
  conviction?: number;
  upside?: number;          // calculated
  total_return?: number;    // from the model (model_return), N/A if no model
  cagr?: number;            // from the model (model_cagr), N/A if no model
  has_model?: boolean;      // whether return/CAGR come from a parsed model
  ytd_return?: number;      // YTD return %
  ytd_contribution?: number; // YTD contribution in pp
  status: string;
  is_cash?: boolean;
}

// Minimal FX → USD conversion. Rates are refreshed lazily and cached for the
// process lifetime; falls back to rough static rates if the API is unreachable.
const FX_FALLBACK: Record<string, number> = {
  USD: 1, EUR: 1.08, GBP: 1.27, CHF: 1.12, JPY: 0.0064, SEK: 0.095, DKK: 0.145, NOK: 0.092, CAD: 0.73,
};
let _fx: { rates: Record<string, number>; expiry: number } | null = null;

async function getFxToUsd(): Promise<Record<string, number>> {
  if (_fx && Date.now() < _fx.expiry) return _fx.rates;
  try {
    // exchangerate.host: base USD → how many units per USD; invert to "USD per unit".
    const res = await fetch('https://api.exchangerate.host/latest?base=USD');
    if (res.ok) {
      const json = await res.json() as any;
      const perUsd = json?.rates ?? {};
      const rates: Record<string, number> = { USD: 1 };
      for (const [cur, v] of Object.entries(perUsd)) {
        const n = Number(v);
        if (n > 0) rates[cur] = 1 / n;
      }
      _fx = { rates: { ...FX_FALLBACK, ...rates }, expiry: Date.now() + 6 * 3600 * 1000 };
      return _fx.rates;
    }
  } catch { /* fall back */ }
  _fx = { rates: FX_FALLBACK, expiry: Date.now() + 3600 * 1000 };
  return _fx.rates;
}

function toUsd(amount: number, currency: string | undefined, fx: Record<string, number>): number {
  const rate = fx[(currency ?? 'USD').toUpperCase()] ?? 1;
  return amount * rate;
}

const CASH_NAME_PATTERNS = ['cash', 'liquidez', 'efectivo', 'cash and', 'treasury'];

function isCashPosition(pos: PortfolioPosition): boolean {
  const nameLower = pos.name?.toLowerCase() ?? '';
  if (CASH_NAME_PATTERNS.some(p => nameLower.includes(p))) return true;
  if (
    pos.ticker == null &&
    pos.pe_ratio == null &&
    pos.ev_ebitda == null &&
    pos.entry_price == null
  ) return true;
  return false;
}

// Get active portfolio positions with calculations
export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const result = await pool.query(
    `SELECT id, name, ticker, sector, currency, entry_price, entry_date,
            current_price, target_price, position_size, shares,
            model_return, model_cagr, pe_ratio, ev_ebitda, conviction, status
     FROM companies
     WHERE status = 'active'
     ORDER BY position_size DESC NULLS LAST`
  );

  const fx = await getFxToUsd();
  const rows = result.rows;
  const positions: PortfolioPosition[] = rows.map((r: any) => {
    const entryPrice = r.entry_price != null ? Number(r.entry_price) : undefined;
    const currentPrice = r.current_price != null ? Number(r.current_price) : undefined;
    const targetPrice = r.target_price != null ? Number(r.target_price) : undefined;
    const entryDate = r.entry_date ? String(r.entry_date).slice(0, 10) : undefined;
    const shares = r.shares != null ? Number(r.shares) : undefined;

    // Market value in USD = shares × current price (converted from listing currency).
    let marketValue: number | undefined;
    if (shares != null && currentPrice != null) {
      marketValue = toUsd(shares * currentPrice, r.currency, fx);
    }

    let upside: number | undefined;
    if (currentPrice && targetPrice && currentPrice > 0) {
      upside = ((targetPrice - currentPrice) / currentPrice) * 100;
    }

    // Return & CAGR come from the valuation-by-cases model (chosen cells), not from
    // price math. They stay undefined (→ N/A in the UI) when no model is parsed.
    const modelReturn = r.model_return != null ? Number(r.model_return) : undefined;
    const modelCagr   = r.model_cagr   != null ? Number(r.model_cagr)   : undefined;

    const pos: PortfolioPosition = {
      id: r.id,
      name: r.name,
      ticker: r.ticker,
      sector: r.sector,
      currency: r.currency,
      entry_price: entryPrice,
      entry_date: entryDate,
      current_price: currentPrice,
      target_price: targetPrice,
      shares,
      market_value: marketValue,
      position_size: r.position_size != null ? Number(r.position_size) : undefined,
      pe_ratio: r.pe_ratio != null ? Number(r.pe_ratio) : undefined,
      ev_ebitda: r.ev_ebitda != null ? Number(r.ev_ebitda) : undefined,
      conviction: r.conviction,
      upside,
      total_return: modelReturn,
      cagr: modelCagr,
      has_model: modelReturn != null || modelCagr != null,
      status: r.status,
    };
    pos.is_cash = isCashPosition(pos);
    return pos;
  });

  // Compute weight from market value: weight% = position value / total portfolio value.
  // Only override when we have real market values; otherwise keep any sheet-provided weight.
  const totalMarketValue = positions.reduce((s, p) => s + (p.market_value ?? 0), 0);
  if (totalMarketValue > 0) {
    for (const p of positions) {
      if (p.market_value != null) {
        p.position_size = (p.market_value / totalMarketValue) * 100;
      }
    }
  }

  // Compute YTD returns using Jan 1 price snapshots
  const companyIds = rows.map((r: any) => r.id);
  const jan1Date = `${new Date().getFullYear()}-01-01`;
  const ytdResult = await pool.query(
    `SELECT company_id, price FROM price_snapshots
     WHERE snapshot_date = $1 AND company_id = ANY($2)`,
    [jan1Date, companyIds]
  );
  const jan1PriceMap = new Map<string, number>();
  for (const row of ytdResult.rows) {
    jan1PriceMap.set(row.company_id, parseFloat(row.price));
  }

  for (const pos of positions) {
    const jan1Price = jan1PriceMap.get(pos.id);
    if (jan1Price && pos.current_price && jan1Price > 0) {
      pos.ytd_return = ((pos.current_price - jan1Price) / jan1Price) * 100;
      pos.ytd_contribution = ((pos.position_size ?? 0) / 100) * (pos.ytd_return / 100) * 100;
    }
  }

  // Compute weighted aggregates (only for positions with data)
  const withWeight = positions.filter(p => p.position_size && p.position_size > 0);
  const totalWeight = withWeight.reduce((s, p) => s + (p.position_size ?? 0), 0);

  let weightedPe: number | null = null;
  let weightedEvEbitda: number | null = null;
  let weightedUpside: number | null = null;
  let weightedCagr: number | null = null;
  let weightedReturn: number | null = null;

  if (totalWeight > 0) {
    const peItems = withWeight.filter(p => p.pe_ratio != null && !p.is_cash);
    if (peItems.length) {
      const wt = peItems.reduce((s, p) => s + (p.position_size ?? 0), 0);
      weightedPe = peItems.reduce((s, p) => s + (p.pe_ratio! * (p.position_size ?? 0)), 0) / wt;
    }
    const evItems = withWeight.filter(p => p.ev_ebitda != null && !p.is_cash);
    if (evItems.length) {
      const wt = evItems.reduce((s, p) => s + (p.position_size ?? 0), 0);
      weightedEvEbitda = evItems.reduce((s, p) => s + (p.ev_ebitda! * (p.position_size ?? 0)), 0) / wt;
    }
    const upsideItems = withWeight.filter(p => p.upside != null);
    if (upsideItems.length) {
      const wt = upsideItems.reduce((s, p) => s + (p.position_size ?? 0), 0);
      weightedUpside = upsideItems.reduce((s, p) => s + (p.upside! * (p.position_size ?? 0)), 0) / wt;
    }
    const cagrItems = withWeight.filter(p => p.cagr != null);
    if (cagrItems.length) {
      const wt = cagrItems.reduce((s, p) => s + (p.position_size ?? 0), 0);
      weightedCagr = cagrItems.reduce((s, p) => s + (p.cagr! * (p.position_size ?? 0)), 0) / wt;
    }
    const retItems = withWeight.filter(p => p.total_return != null);
    if (retItems.length) {
      const wt = retItems.reduce((s, p) => s + (p.position_size ?? 0), 0);
      weightedReturn = retItems.reduce((s, p) => s + (p.total_return! * (p.position_size ?? 0)), 0) / wt;
    }
  }

  // Compute overall YTD portfolio return (sum of ytd_contributions)
  const ytdContributions = positions
    .filter(p => p.ytd_contribution !== undefined)
    .map(p => p.ytd_contribution!);
  const ytdPortfolio = ytdContributions.length > 0
    ? ytdContributions.reduce((a, b) => a + b, 0)
    : undefined;

  return {
    total_invested: null,
    total_current_value: null,
    total_return_pct: weightedReturn,
    total_return_abs: null,
    weighted_pe: weightedPe,
    weighted_ev_ebitda: weightedEvEbitda,
    weighted_upside: weightedUpside,
    weighted_cagr: weightedCagr,
    ytd_portfolio: ytdPortfolio,
    positions,
  };
}

// Get benchmark historical data (monthly) via Yahoo Finance v8 chart API
async function getBenchmarkHistory(ticker: string, fromDate: string): Promise<Map<string, number>> {
  try {
    const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1mo&period1=${period1}&period2=9999999999&includePrePost=false`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': BENCH_UA,
        'Accept': 'application/json',
        'Origin': 'https://finance.yahoo.com',
        'Referer': `https://finance.yahoo.com/quote/${ticker}/`,
      },
    });
    if (!res.ok) return new Map();
    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const closes: number[]     = result?.indicators?.adjclose?.[0]?.adjclose ?? result?.indicators?.quote?.[0]?.close ?? [];
    const map = new Map<string, number>();
    timestamps.forEach((ts, i) => {
      if (closes[i] != null) {
        map.set(new Date(ts * 1000).toISOString().slice(0, 10), closes[i]);
      }
    });
    return map;
  } catch (err) {
    console.error(`Failed to fetch benchmark ${ticker}:`, err);
    return new Map();
  }
}

function findClosestPrice(
  priceMap: Map<string, number>,
  targetDate: string,
  fallbackPrice: number,
  entryDate: string
): number | null {
  // Get all dates in map, sorted
  const dates = Array.from(priceMap.keys()).sort();
  if (dates.length === 0) return null;

  // If target date is before entry date, return entry price (position wasn't held yet)
  if (targetDate < entryDate) return fallbackPrice;

  // Find closest date <= targetDate
  let best: string | null = null;
  for (const d of dates) {
    if (d <= targetDate) best = d;
    else break;
  }
  if (best) return priceMap.get(best) ?? null;
  return priceMap.get(dates[0]) ?? null;
}

function calcBenchmarkReturn(
  priceMap: Map<string, number>,
  startDate: string,
  endDate: string
): number | null {
  const dates = Array.from(priceMap.keys()).sort();

  let startPrice: number | null = null;
  let endPrice: number | null = null;

  // Find closest price on or before startDate
  for (const d of dates) {
    if (d <= startDate) startPrice = priceMap.get(d) ?? null;
  }
  // Find closest price on or before endDate
  for (const d of dates) {
    if (d <= endDate) endPrice = priceMap.get(d) ?? null;
  }

  if (!startPrice || !endPrice || startPrice === 0) return null;
  return parseFloat((((endPrice - startPrice) / startPrice) * 100).toFixed(2));
}

export async function getPeriodReturns(): Promise<PeriodReturn[]> {
  // Get portfolio positions
  const posResult = await pool.query(
    `SELECT id, ticker, position_size, entry_price, entry_date
     FROM companies
     WHERE status = 'active' AND entry_date IS NOT NULL AND entry_price IS NOT NULL AND position_size IS NOT NULL`
  );

  if (posResult.rows.length === 0) return [];

  // Find earliest entry date
  const earliestDate = posResult.rows.reduce((min: string, r: any) => {
    const d = String(r.entry_date).slice(0, 10);
    return d < min ? d : min;
  }, String(posResult.rows[0].entry_date).slice(0, 10));

  // Get price snapshots for these companies
  const companyIds = posResult.rows.map((r: any) => r.id);
  const snapshotResult = await pool.query(
    `SELECT company_id, snapshot_date, price
     FROM price_snapshots
     WHERE company_id = ANY($1) AND snapshot_date >= $2
     ORDER BY snapshot_date ASC`,
    [companyIds, earliestDate]
  );

  // Also get current prices as latest data point
  const currentResult = await pool.query(
    `SELECT id as company_id, current_price as price, CURRENT_DATE as snapshot_date
     FROM companies
     WHERE id = ANY($1) AND current_price IS NOT NULL`,
    [companyIds]
  );

  // Build price map: company_id -> date -> price
  const priceMap = new Map<string, Map<string, number>>();
  for (const row of [...snapshotResult.rows, ...currentResult.rows]) {
    const date = String(row.snapshot_date).slice(0, 10);
    const price = parseFloat(row.price);
    if (!priceMap.has(row.company_id)) priceMap.set(row.company_id, new Map());
    priceMap.get(row.company_id)!.set(date, price);
  }

  // Generate period end dates (monthly) from earliestDate to now
  const periods: { label: string; type: 'monthly' | 'quarterly'; start: string; end: string }[] = [];
  const now = new Date();
  const start = new Date(earliestDate);
  let current = new Date(start.getFullYear(), start.getMonth(), 1);

  while (current <= now) {
    const year = current.getFullYear();
    const month = current.getMonth(); // 0-indexed
    const lastDay = new Date(year, month + 1, 0);
    const endDate = lastDay > now ? now : lastDay;
    const endStr = endDate.toISOString().slice(0, 10);
    const startStr = new Date(year, month, 1).toISOString().slice(0, 10);

    // Monthly
    const monthLabel = current.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });
    periods.push({ label: monthLabel, type: 'monthly', start: startStr, end: endStr });

    // Quarterly (add at end of each quarter)
    if ([2, 5, 8, 11].includes(month)) {
      const qNum = Math.floor(month / 3) + 1;
      const qStart = new Date(year, month - 2, 1).toISOString().slice(0, 10);
      periods.push({ label: `Q${qNum} ${year}`, type: 'quarterly', start: qStart, end: endStr });
    }

    current = new Date(year, month + 1, 1);
  }

  // Fetch benchmarks (monthly)
  const [msciMap, sp500Map] = await Promise.all([
    getBenchmarkHistory('IWDA.L', earliestDate),
    getBenchmarkHistory('^GSPC', earliestDate),
  ]);

  // For each period, calculate portfolio return
  const results: PeriodReturn[] = [];

  for (const period of periods) {
    const posReturns: { return: number; weight: number }[] = [];

    for (const pos of posResult.rows) {
      const posWeight = parseFloat(pos.position_size);
      const entryPrice = parseFloat(pos.entry_price);
      const entryDate = String(pos.entry_date).slice(0, 10);
      const pricesForComp = priceMap.get(pos.id);
      if (!pricesForComp) continue;

      // Find price at start and end of period
      // Price at period start = closest price on or before period.start (but not before entry_date)
      const startPrice = findClosestPrice(pricesForComp, period.start, entryPrice, entryDate);
      const endPrice = findClosestPrice(pricesForComp, period.end, entryPrice, entryDate);

      if (startPrice && endPrice && startPrice > 0) {
        const ret = ((endPrice - startPrice) / startPrice) * 100;
        posReturns.push({ return: ret, weight: posWeight });
      }
    }

    if (posReturns.length === 0) continue;

    const totalWeight = posReturns.reduce((s, p) => s + p.weight, 0);
    const portfolioReturn = totalWeight > 0
      ? posReturns.reduce((s, p) => s + p.return * p.weight, 0) / totalWeight
      : 0;

    // Benchmark returns
    const msciReturn = calcBenchmarkReturn(msciMap, period.start, period.end);
    const sp500Return = calcBenchmarkReturn(sp500Map, period.start, period.end);

    results.push({
      period: period.label,
      period_type: period.type,
      period_start: period.start,
      period_end: period.end,
      portfolio_return: parseFloat(portfolioReturn.toFixed(2)),
      msci_world_return: msciReturn,
      sp500_return: sp500Return,
      vs_msci: msciReturn != null ? parseFloat((portfolioReturn - msciReturn).toFixed(2)) : null,
      vs_sp500: sp500Return != null ? parseFloat((portfolioReturn - sp500Return).toFixed(2)) : null,
      positions_count: posReturns.length,
    });
  }

  return results.reverse(); // most recent first
}
