import axios from 'axios';
import {
  SheetRef, extractPubKey, csvUrl, parseGrid, fetchTabs, cellNum, extractGidsInOrder,
} from './modelCases';

/** Fetch sheet gids in document order from the pubhtml/htmlview (no named tabs needed). */
async function fetchOrderedGids(ref: SheetRef): Promise<string[]> {
  const url = ref.kind === 'published'
    ? `https://docs.google.com/spreadsheets/d/e/${ref.key}/pubhtml`
    : `https://docs.google.com/spreadsheets/d/${ref.key}/htmlview`;
  try {
    const res = await axios.get<string>(url, { timeout: 20000, headers: { 'User-Agent': UA } });
    return extractGidsInOrder(res.data as string);
  } catch { return []; }
}

/**
 * Full model parser for the standard template (tabs: 1.Income Statement,
 * 2.Flujos de caja, 3.Retornos Capital, 4.Valoración, 4.1 Valoración por casos…).
 *
 * It extracts:
 *  - KPI time-series (Sales growth, margins, EPS, FCF, ROIC, Net Debt/EBITDA…)
 *  - The "4.Valoración" target-price table (PER ex Cash / EV·FCF / EV·EBITDA / EV·EBIT
 *    / Promedio) with annualized return + 5y CAGR per method.
 *  - The "4.1 Valoración por casos" inputs (best/base/worst projection drivers).
 */

const UA = 'Mozilla/5.0 (compatible; TizaResearch/1.0)';
const norm = (s: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function toNum(s: string | undefined): number | null {
  if (s == null) return null;
  let c = String(s).replace(/[%€$£\s]/g, '').trim();
  if (!c || c === '-' || c === 'N/A') return null;
  const lc = c.lastIndexOf(','), ld = c.lastIndexOf('.');
  if (lc !== -1 && lc > ld) c = c.replace(/\./g, '').replace(',', '.');
  else c = c.replace(/,/g, '');
  const n = parseFloat(c);
  return isNaN(n) ? null : n;
}

async function fetchCsv(ref: SheetRef, gid: string): Promise<string[][] | null> {
  try {
    const res = await axios.get<string>(csvUrl(ref, gid), {
      timeout: 15000, responseType: 'text', headers: { 'User-Agent': UA },
    });
    return parseGrid(res.data);
  } catch { return null; }
}

/** Find the row whose first cell matches `label` (normalized, substring). */
function findRow(grid: string[][], label: string): string[] | null {
  const want = norm(label);
  for (const row of grid) {
    if (norm(row[0] ?? '').includes(want)) return row;
  }
  return null;
}

/** Locate the header row carrying year tokens (2024, 2025e…) → map year→colIndex. */
function yearHeader(grid: string[][]): { rowIdx: number; cols: { year: string; idx: number }[] } | null {
  const yr = /^(19|20)\d{2}e?$/i;
  for (let i = 0; i < Math.min(grid.length, 8); i++) {
    const cols: { year: string; idx: number }[] = [];
    grid[i].forEach((c, idx) => { if (yr.test(c.trim())) cols.push({ year: c.trim(), idx }); });
    if (cols.length >= 3) return { rowIdx: i, cols };
  }
  return null;
}

/** A labeled KPI time-series: label + {year:value} map. */
export interface KpiSeries { label: string; values: { year: string; value: number | null }[]; isPct?: boolean; }

function seriesFor(grid: string[][], label: string, isPct = false): KpiSeries | null {
  const hdr = yearHeader(grid);
  const row = findRow(grid, label);
  if (!hdr || !row) return null;
  return {
    label,
    isPct,
    values: hdr.cols.map(({ year, idx }) => ({ year, value: toNum(row[idx]) })),
  };
}

export interface TargetMethod {
  method: string;                 // "PER ex Cash", "EV / FCF", "EV / EBITDA", "EV / EBIT", "Promedio"
  targetsByYear: { year: string; value: number | null }[];
  annualizedReturn: number | null; // col "Retorno Anualizado"
  cagr5y: number | null;           // col "CAGR 5 años"
}

export interface ModelFull {
  currentPrice: number | null;     // "Precio por acción actual"
  targetTable: TargetMethod[];     // 4.Valoración rows 24-28
  kpis: KpiSeries[];               // selected KPI series for the KPIs tab
  // Headline single-values surfaced to the cartera table:
  evPer: number | null;            // PER ex Cash (NTM/objetivo)
  evFcf: number | null;            // EV / FCF (NTM/objetivo)
  parsedAt: string;
}

/** Parse the "4.Valoración" tab into the target-price table + headline multiples. */
function parseValuationTab(grid: string[][]): {
  currentPrice: number | null; targetTable: TargetMethod[]; evPer: number | null; evFcf: number | null;
} {
  const currentPrice = toNum(findRow(grid, 'precio por accion actual')?.[1]);

  // The "Precio objetivo" sub-table: a header row "Precio objetivo | 2025 | … | Retorno Anualizado"
  // then method rows. Find that header to map year columns and the return/CAGR columns.
  let hdrIdx = -1, retCol = -1, cagrCol = -1;
  const yearCols: { year: string; idx: number }[] = [];
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (norm(row[0] ?? '').includes('precio objetivo')) {
      row.forEach((c, idx) => {
        const cn = norm(c);
        if (/^(19|20)\d{2}e?$/.test(c.trim())) yearCols.push({ year: c.trim(), idx });
        if (cn.includes('retorno anualizado') || cn.includes('retorno')) retCol = idx;
        if (cn.includes('cagr')) cagrCol = idx;
      });
      if (yearCols.length >= 2) { hdrIdx = i; break; }
      yearCols.length = 0;
    }
  }

  const methods = ['per ex cash', 'ev / fcf', 'ev / ebitda', 'ev / ebit', 'promedio'];
  const targetTable: TargetMethod[] = [];
  if (hdrIdx >= 0) {
    for (let i = hdrIdx + 1; i < grid.length; i++) {
      const row = grid[i];
      const label = norm(row[0] ?? '');
      if (!label) continue;
      const match = methods.find(m => label === m || label.includes(m));
      if (!match) {
        // stop once we've passed the block (a non-method, non-empty label after collecting some)
        if (targetTable.length >= methods.length) break;
        continue;
      }
      targetTable.push({
        method: (row[0] ?? '').trim(),
        targetsByYear: yearCols.map(({ year, idx }) => ({ year, value: toNum(row[idx]) })),
        annualizedReturn: retCol >= 0 ? toNum(row[retCol]) : null,
        cagr5y: cagrCol >= 0 ? toNum(row[cagrCol]) : null,
      });
      if (targetTable.length >= methods.length) break;
    }
  }

  // Headline multiples come from the "Múltiplos de valoración" block: PER / EV·FCF
  // (use the "Objetivo" column when present, else NTM).
  const perRow = findRow(grid, 'per');
  const evFcfRow = findRow(grid, 'ev / fcf');
  // columns there are LTM | NTM | Objetivo (B|C|D). Prefer Objetivo (idx 3), else NTM (idx 2).
  const pick3 = (row: string[] | null) => row ? (toNum(row[3]) ?? toNum(row[2]) ?? toNum(row[1])) : null;
  const evPer = pick3(perRow);
  const evFcf = pick3(evFcfRow);

  return { currentPrice, targetTable, evPer, evFcf };
}

export async function parseFullModel(modelUrl: string): Promise<ModelFull> {
  const ref = extractPubKey(modelUrl);
  let tabs: { name: string; gid: string }[] = [];
  try { tabs = await fetchTabs(ref); } catch { /* no named tabs */ }

  const findGid = (...needles: string[]) => {
    for (const n of needles) {
      const t = tabs.find(t => norm(t.name).includes(n));
      if (t) return t.gid;
    }
    return undefined;
  };
  let incomeGid = findGid('income statement', '1.income', 'income');
  let cashGid   = findGid('flujos de caja', 'flujos', 'cash');
  let retGid    = findGid('retornos capital', 'retornos', 'capital');
  let valGid    = findGid('4.valoracion', 'valoracion');

  // Fallback: newer pubhtml exposes no named tabs — only bare gids in document
  // order. The template order is fixed, so map by position (0..3).
  if (!incomeGid || !valGid) {
    const ordered = await fetchOrderedGids(ref);
    incomeGid = incomeGid ?? ordered[0];
    cashGid   = cashGid   ?? ordered[1];
    retGid    = retGid    ?? ordered[2];
    valGid    = valGid    ?? ordered[3];
  }

  const [income, cash, ret, val] = await Promise.all([
    incomeGid ? fetchCsv(ref, incomeGid) : null,
    cashGid ? fetchCsv(ref, cashGid) : null,
    retGid ? fetchCsv(ref, retGid) : null,
    valGid ? fetchCsv(ref, valGid) : null,
  ]);

  const kpis: KpiSeries[] = [];
  const add = (s: KpiSeries | null) => { if (s) kpis.push(s); };
  if (income) {
    add(seriesFor(income, 'Sales'));
    add(seriesFor(income, 'Y/Y Growth %', true));
    add(seriesFor(income, 'EBITDA margin %', true));
    add(seriesFor(income, 'EBIT margin %', true));
    add(seriesFor(income, 'Margen beneficio neto', true));
    add(seriesFor(income, 'EPS'));
  }
  if (cash) {
    add(seriesFor(cash, 'Free Cash Flow'));
    add(seriesFor(cash, 'FCF / Ventas', true));
    add(seriesFor(cash, 'Conversión en Caja', true));
  }
  if (ret) {
    add(seriesFor(ret, 'ROE', true));
    add(seriesFor(ret, 'ROIC (EBIT (1-t) / Invested Capital)', true));
    add(seriesFor(ret, 'Invested Capital'));
  }
  if (val) {
    add(seriesFor(val, 'Net Debt'));
    add(seriesFor(val, 'Dueda neta / EBITDA'));
    add(seriesFor(val, 'FCF Yield', true));
  }

  const v = val ? parseValuationTab(val) : { currentPrice: null, targetTable: [], evPer: null, evFcf: null };

  return {
    currentPrice: v.currentPrice,
    targetTable: v.targetTable,
    kpis,
    evPer: v.evPer,
    evFcf: v.evFcf,
    parsedAt: new Date().toISOString(),
  };
}
