import pool from '../db';

// yahoo-finance2 is ESM-only, so we use dynamic import in a CJS context
let _yahooFinanceInstance: any = null;
async function getYahooFinance(): Promise<any> {
  if (_yahooFinanceInstance) return _yahooFinanceInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await (Function('return import("yahoo-finance2")')() as Promise<any>);
  const YFClass = mod.default ?? mod;
  _yahooFinanceInstance = new YFClass();
  return _yahooFinanceInstance;
}

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
  position_size?: number;  // weight %
  pe_ratio?: number;
  ev_ebitda?: number;
  conviction?: number;
  upside?: number;         // calculated
  total_return?: number;   // calculated % from entry_price to current_price
  cagr?: number;           // calculated annualized return
  status: string;
}

// Get active portfolio positions with calculations
export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const result = await pool.query(
    `SELECT id, name, ticker, sector, currency, entry_price, entry_date,
            current_price, target_price, position_size, pe_ratio, ev_ebitda, conviction, status
     FROM companies
     WHERE status = 'active'
     ORDER BY position_size DESC NULLS LAST`
  );

  const rows = result.rows;
  const positions: PortfolioPosition[] = rows.map((r: any) => {
    const entryPrice = r.entry_price ? parseFloat(r.entry_price) : undefined;
    const currentPrice = r.current_price ? parseFloat(r.current_price) : undefined;
    const targetPrice = r.target_price ? parseFloat(r.target_price) : undefined;
    const entryDate = r.entry_date ? String(r.entry_date).slice(0, 10) : undefined;

    let totalReturn: number | undefined;
    let cagr: number | undefined;
    let upside: number | undefined;

    if (entryPrice && currentPrice && entryPrice > 0) {
      totalReturn = ((currentPrice - entryPrice) / entryPrice) * 100;
    }
    if (entryPrice && currentPrice && entryDate) {
      const years = (Date.now() - new Date(entryDate).getTime()) / (365.25 * 24 * 3600 * 1000);
      if (years > 0.01) {
        cagr = (Math.pow(currentPrice / entryPrice, 1 / years) - 1) * 100;
      }
    }
    if (currentPrice && targetPrice && currentPrice > 0) {
      upside = ((targetPrice - currentPrice) / currentPrice) * 100;
    }

    return {
      id: r.id,
      name: r.name,
      ticker: r.ticker,
      sector: r.sector,
      currency: r.currency,
      entry_price: entryPrice,
      entry_date: entryDate,
      current_price: currentPrice,
      target_price: targetPrice,
      position_size: r.position_size ? parseFloat(r.position_size) : undefined,
      pe_ratio: r.pe_ratio ? parseFloat(r.pe_ratio) : undefined,
      ev_ebitda: r.ev_ebitda ? parseFloat(r.ev_ebitda) : undefined,
      conviction: r.conviction,
      upside,
      total_return: totalReturn,
      cagr,
      status: r.status,
    };
  });

  // Compute weighted aggregates (only for positions with data)
  const withWeight = positions.filter(p => p.position_size && p.position_size > 0);
  const totalWeight = withWeight.reduce((s, p) => s + (p.position_size ?? 0), 0);

  let weightedPe: number | null = null;
  let weightedEvEbitda: number | null = null;
  let weightedUpside: number | null = null;
  let weightedCagr: number | null = null;
  let weightedReturn: number | null = null;

  if (totalWeight > 0) {
    const peItems = withWeight.filter(p => p.pe_ratio != null);
    if (peItems.length) {
      const wt = peItems.reduce((s, p) => s + (p.position_size ?? 0), 0);
      weightedPe = peItems.reduce((s, p) => s + (p.pe_ratio! * (p.position_size ?? 0)), 0) / wt;
    }
    const evItems = withWeight.filter(p => p.ev_ebitda != null);
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

  return {
    total_invested: null,
    total_current_value: null,
    total_return_pct: weightedReturn,
    total_return_abs: null,
    weighted_pe: weightedPe,
    weighted_ev_ebitda: weightedEvEbitda,
    weighted_upside: weightedUpside,
    weighted_cagr: weightedCagr,
    positions,
  };
}

// Get benchmark historical data (monthly)
async function getBenchmarkHistory(ticker: string, fromDate: string): Promise<Map<string, number>> {
  // Returns map of "YYYY-MM-DD" -> price for month-end dates
  try {
    const yahooFinance = await getYahooFinance();
    const history = await yahooFinance.historical(ticker, {
      period1: fromDate,
      interval: '1mo',
    });
    const map = new Map<string, number>();
    for (const item of history) {
      const date = new Date(item.date).toISOString().slice(0, 10);
      map.set(date, item.adjClose ?? item.close);
    }
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
