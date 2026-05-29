import axios from 'axios';

export interface ModelKpis {
  pe_2024?: number;
  pe_2025e?: number;
  ev_ebitda_2024?: number;
  ev_ebitda_2025e?: number;
  ev_fcf_2024?: number;
  ev_fcf_2025e?: number;
  fcf_margin_2024?: number;    // as decimal (0.24 = 24%)
  fcf_margin_2025e?: number;
  ebit_margin_2024?: number;   // as decimal
  ebit_margin_2025e?: number;
  revenue_cagr_5y?: number;    // projected 5Y CAGR as decimal
  eps_2024?: number;
  eps_2025e?: number;
  roe_2024?: number;           // as decimal
  roic_2024?: number;          // as decimal
  target_price_base?: number;  // from valuation sheet base case
  target_price_bull?: number;
  target_price_bear?: number;
  parsed_at: string;
}

/**
 * Extract pubkey from a pubhtml URL.
 * Supports: https://docs.google.com/spreadsheets/d/e/PUBKEY/pubhtml
 */
function extractPubKey(url: string): string {
  const match = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Invalid published Google Sheets URL (expected /d/e/PUBKEY format)');
  return match[1];
}

/**
 * Build CSV URL for a given sheet GID from the pub base URL.
 */
function buildCsvUrl(pubKey: string, gid?: number): string {
  const base = `https://docs.google.com/spreadsheets/d/e/${pubKey}/pub`;
  if (gid === undefined) return `${base}?output=csv`;
  return `${base}?gid=${gid}&single=true&output=csv`;
}

/**
 * Fetch a CSV from a URL. Returns null on failure.
 */
async function fetchCsv(url: string): Promise<string | null> {
  try {
    const response = await axios.get<string>(url, {
      timeout: 15000,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return response.data;
  } catch {
    return null;
  }
}

/**
 * Parse CSV text into a 2D array of strings (rows of cells).
 */
function parseCsvRaw(text: string): string[][] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const result: string[][] = [];
  for (const line of lines) {
    const cells = parseRow(line);
    result.push(cells.map(c => c.trim()));
  }
  return result;
}

function parseRow(line: string): string[] {
  const cells: string[] = [];
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(current); current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * Find the header row: the row where a cell looks like a year (e.g. "2023", "2024", "2025e").
 * Returns { rowIndex, colMap } where colMap maps year string -> column index.
 */
function findHeaderRow(rows: string[][]): { rowIndex: number; colMap: Map<string, number> } | null {
  const yearPattern = /^(20\d{2}e?|19\d{2}e?)$/i;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const colMap = new Map<string, number>();
    for (let j = 0; j < row.length; j++) {
      const cell = row[j].trim();
      if (yearPattern.test(cell)) {
        colMap.set(cell.toLowerCase(), j);
      }
    }
    if (colMap.size >= 3) {
      return { rowIndex: i, colMap };
    }
  }
  return null;
}

/**
 * Find a data row by label (case-insensitive, trimmed prefix match).
 */
function findRow(rows: string[][], pattern: string, startAfter = 0): number {
  const lower = pattern.toLowerCase();
  for (let i = startAfter; i < rows.length; i++) {
    const label = rows[i][0]?.trim().toLowerCase() ?? '';
    if (label.includes(lower)) return i;
  }
  return -1;
}

/**
 * Parse a numeric value from a cell string.
 * Handles %, commas, currency symbols.
 */
function parseNum(cell: string): number | undefined {
  if (!cell || cell.trim() === '' || cell.trim() === '-' || cell.trim() === 'N/A') return undefined;
  const cleaned = cell.replace(/[%€$£,\s]/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? undefined : n;
}

/**
 * Get value from a row at the column for a given year key.
 */
function getYearValue(rows: string[][], rowIndex: number, colMap: Map<string, number>, yearKey: string): number | undefined {
  const col = colMap.get(yearKey);
  if (col === undefined) return undefined;
  const row = rows[rowIndex];
  if (!row) return undefined;
  return parseNum(row[col]);
}

/**
 * Convert percentage to decimal (e.g. 24.5 -> 0.245).
 * If the value is already a small decimal (< 2), assume it's already in decimal form.
 */
function pctToDecimal(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  // If absolute value > 2, assume it's a percentage and divide by 100
  return Math.abs(v) > 2 ? v / 100 : v;
}

interface SheetData {
  name: string;
  rows: string[][];
  headerRow: { rowIndex: number; colMap: Map<string, number> } | null;
}

/**
 * Try to identify the sheet by checking for expected row labels.
 */
function identifySheet(rows: string[][]): 'income_statement' | 'cash_flow' | 'valuation' | 'unknown' {
  const allLabels = rows.map(r => r[0]?.trim().toLowerCase() ?? '');
  const hasEv = allLabels.some(l => l.includes('ev / ebitda') || l.includes('ev/ebitda'));
  const hasEps = allLabels.some(l => l === 'eps' || l.startsWith('eps '));
  const hasEbitMargin = allLabels.some(l => l.includes('ebit margin') || l.includes('ebit margin %'));
  const hasEvFcf = allLabels.some(l => l.includes('ev / fcf') || l.includes('ev/fcf'));
  const hasFcfMargin = allLabels.some(l => l.includes('fcf / ventas') || l.includes('fcf margin'));
  const hasRoic = allLabels.some(l => l === 'roic' || l.startsWith('roic '));
  const hasPer = allLabels.some(l => l.includes('per ex cash') || l.includes('per '));
  const hasVentas = allLabels.some(l => l === 'ventas' || l === 'revenue');

  if (hasEvFcf || hasFcfMargin || hasRoic) return 'cash_flow';
  if (hasPer && hasVentas) return 'valuation';
  if (hasEv || hasEps || hasEbitMargin) return 'income_statement';
  return 'unknown';
}

/**
 * Parse Income Statement sheet for KPIs.
 */
function parseIncomeStatement(data: SheetData, kpis: Partial<ModelKpis>): void {
  const { rows, headerRow } = data;
  if (!headerRow) return;

  const { rowIndex: hIdx, colMap } = headerRow;

  // Normalize year keys: "2025e" or "2025" for 2025e
  const year2024Key = colMap.has('2024') ? '2024' : undefined;
  const year2025Key = colMap.has('2025e') ? '2025e' : (colMap.has('2025') ? '2025' : undefined);

  // EV / EBITDA
  const evEbitdaRow = findRow(rows, 'ev / ebitda', hIdx);
  if (evEbitdaRow >= 0) {
    if (year2024Key) kpis.ev_ebitda_2024 = getYearValue(rows, evEbitdaRow, colMap, year2024Key);
    if (year2025Key) kpis.ev_ebitda_2025e = getYearValue(rows, evEbitdaRow, colMap, year2025Key);
  }

  // EPS
  const epsRow = findRow(rows, 'eps', hIdx);
  if (epsRow >= 0) {
    if (year2024Key) kpis.eps_2024 = getYearValue(rows, epsRow, colMap, year2024Key);
    if (year2025Key) kpis.eps_2025e = getYearValue(rows, epsRow, colMap, year2025Key);
  }

  // EBIT margin
  const ebitMarginRow = findRow(rows, 'ebit margin', hIdx);
  if (ebitMarginRow >= 0) {
    if (year2024Key) kpis.ebit_margin_2024 = pctToDecimal(getYearValue(rows, ebitMarginRow, colMap, year2024Key));
    if (year2025Key) kpis.ebit_margin_2025e = pctToDecimal(getYearValue(rows, ebitMarginRow, colMap, year2025Key));
  }
}

/**
 * Parse Cash Flow sheet for KPIs.
 */
function parseCashFlow(data: SheetData, kpis: Partial<ModelKpis>): void {
  const { rows, headerRow } = data;
  if (!headerRow) return;

  const { rowIndex: hIdx, colMap } = headerRow;

  const year2024Key = colMap.has('2024') ? '2024' : undefined;
  const year2025Key = colMap.has('2025e') ? '2025e' : (colMap.has('2025') ? '2025' : undefined);

  // EV / FCF
  const evFcfRow = findRow(rows, 'ev / fcf', hIdx);
  if (evFcfRow >= 0) {
    if (year2024Key) kpis.ev_fcf_2024 = getYearValue(rows, evFcfRow, colMap, year2024Key);
    if (year2025Key) kpis.ev_fcf_2025e = getYearValue(rows, evFcfRow, colMap, year2025Key);
  }

  // FCF / Ventas (FCF Margin)
  const fcfMarginRow = findRow(rows, 'fcf / ventas', hIdx);
  if (fcfMarginRow >= 0) {
    if (year2024Key) kpis.fcf_margin_2024 = pctToDecimal(getYearValue(rows, fcfMarginRow, colMap, year2024Key));
    if (year2025Key) kpis.fcf_margin_2025e = pctToDecimal(getYearValue(rows, fcfMarginRow, colMap, year2025Key));
  }

  // ROIC
  const roicRow = findRow(rows, 'roic', hIdx);
  if (roicRow >= 0) {
    if (year2024Key) kpis.roic_2024 = pctToDecimal(getYearValue(rows, roicRow, colMap, year2024Key));
  }
}

/**
 * Parse Valuation sheet for target prices and PER.
 */
function parseValuation(data: SheetData, kpis: Partial<ModelKpis>): void {
  const { rows, headerRow } = data;
  if (!headerRow) return;

  const { rowIndex: hIdx, colMap } = headerRow;

  const year2024Key = colMap.has('2024') ? '2024' : undefined;
  const year2025Key = colMap.has('2025e') ? '2025e' : (colMap.has('2025') ? '2025' : undefined);

  // PER ex Cash
  const perRow = findRow(rows, 'per ex cash', hIdx);
  if (perRow >= 0) {
    if (year2024Key) kpis.pe_2024 = getYearValue(rows, perRow, colMap, year2024Key);
    if (year2025Key) kpis.pe_2025e = getYearValue(rows, perRow, colMap, year2025Key);
  }

  // Revenue CAGR: find "Ventas" row and compute CAGR from 2024 to 2029e (5Y)
  const ventasRow = findRow(rows, 'ventas', hIdx);
  if (ventasRow >= 0 && year2024Key) {
    const v2024 = getYearValue(rows, ventasRow, colMap, year2024Key);
    // Try to find a 5-year forward year (2029e or 2029)
    const v2029 = getYearValue(rows, ventasRow, colMap, '2029e') ??
                  getYearValue(rows, ventasRow, colMap, '2029');
    if (v2024 && v2029 && v2024 > 0) {
      kpis.revenue_cagr_5y = Math.pow(v2029 / v2024, 1 / 5) - 1;
    }
  }

  // Target prices: look for rows with price-like values below the header
  // The valuation template has grouped rows: bull (optimistic), base, bear
  // Heuristic: find rows after "PER ex Cash" that have numeric values and no label (or scenario labels)
  // We look for 3 consecutive price rows
  const scenarioLabels = ['bull', 'base', 'bear', 'optimista', 'base', 'pesimista', 'optimistic', 'pessimistic'];
  const priceRows: number[] = [];

  // Search for rows with scenario labels after the header
  for (let i = hIdx + 1; i < rows.length && priceRows.length < 3; i++) {
    const label = rows[i][0]?.trim().toLowerCase() ?? '';
    if (scenarioLabels.some(sl => label.includes(sl))) {
      priceRows.push(i);
    }
  }

  // If we found 3 scenario rows (bull/base/bear or similar)
  if (priceRows.length >= 3) {
    // Try to get a single price value (first non-empty numeric in each scenario row)
    const getScenarioPrice = (rowIdx: number): number | undefined => {
      const row = rows[rowIdx];
      for (let c = 1; c < row.length; c++) {
        const v = parseNum(row[c]);
        if (v !== undefined && v > 0) return v;
      }
      return undefined;
    };
    // Identify which is bull/base/bear by label
    const labelOf = (rowIdx: number) => rows[rowIdx][0]?.trim().toLowerCase() ?? '';
    for (const rowIdx of priceRows) {
      const lbl = labelOf(rowIdx);
      const price = getScenarioPrice(rowIdx);
      if (lbl.includes('bull') || lbl.includes('optimist') || lbl.includes('optimista')) {
        kpis.target_price_bull = price;
      } else if (lbl.includes('bear') || lbl.includes('pesimist') || lbl.includes('pessimist')) {
        kpis.target_price_bear = price;
      } else {
        // default to base
        kpis.target_price_base = price;
      }
    }
  } else if (priceRows.length === 0) {
    // Fallback: look for 3 rows in a block that have no label and have numeric values
    // Take blocks of 3 and assign bull/base/bear
    const numericRows: number[] = [];
    for (let i = hIdx + 1; i < rows.length && numericRows.length < 6; i++) {
      const row = rows[i];
      const label = row[0]?.trim() ?? '';
      // Skip rows with long labels (likely metric rows)
      if (label.length > 20) continue;
      const firstVal = parseNum(row[1] ?? '');
      if (firstVal !== undefined && firstVal > 0) {
        numericRows.push(i);
      }
    }
    if (numericRows.length >= 3) {
      const getFirstPrice = (rowIdx: number): number | undefined => {
        const row = rows[rowIdx];
        for (let c = 1; c < row.length; c++) {
          const v = parseNum(row[c]);
          if (v !== undefined && v > 0) return v;
        }
        return undefined;
      };
      kpis.target_price_bull = getFirstPrice(numericRows[0]);
      kpis.target_price_base = getFirstPrice(numericRows[1]);
      kpis.target_price_bear = getFirstPrice(numericRows[2]);
    }
  }
}

/**
 * Main function: parse a financial model from a published Google Sheets URL.
 */
export async function parseModelFromUrl(modelUrl: string): Promise<ModelKpis> {
  const pubKey = extractPubKey(modelUrl);
  const kpis: Partial<ModelKpis> = {};

  // Try GIDs 0 through 8 and collect sheet data
  const gidsToTry: Array<number | undefined> = [undefined, 0, 1, 2, 3, 4, 5, 6, 7, 8];
  const sheets: SheetData[] = [];

  for (const gid of gidsToTry) {
    const url = buildCsvUrl(pubKey, gid);
    const csv = await fetchCsv(url);
    if (!csv || csv.trim().length === 0) continue;

    const rows = parseCsvRaw(csv);
    if (rows.length < 3) continue;

    const sheetType = identifySheet(rows);
    // Avoid duplicate sheet types
    if (sheetType !== 'unknown' && sheets.some(s => s.name === sheetType)) continue;

    const headerRow = findHeaderRow(rows);
    sheets.push({ name: sheetType, rows, headerRow });

    // Stop early if we found all 3 relevant sheet types
    const foundTypes = new Set(sheets.map(s => s.name));
    if (foundTypes.has('income_statement') && foundTypes.has('cash_flow') && foundTypes.has('valuation')) {
      break;
    }
  }

  // Parse each identified sheet
  for (const sheet of sheets) {
    if (sheet.name === 'income_statement') parseIncomeStatement(sheet, kpis);
    else if (sheet.name === 'cash_flow') parseCashFlow(sheet, kpis);
    else if (sheet.name === 'valuation') parseValuation(sheet, kpis);
  }

  kpis.parsed_at = new Date().toISOString();
  return kpis as ModelKpis;
}
