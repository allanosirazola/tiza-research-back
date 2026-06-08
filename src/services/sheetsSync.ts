import axios from 'axios';
import pool from '../db';
import { refreshAllCompanyPrices } from './marketData';

/**
 * Converts any Google Sheets URL to a CSV export URL.
 * Supports:
 *  - Published pubhtml URLs: https://docs.google.com/spreadsheets/d/e/PUBKEY/pubhtml
 *  - Regular edit/share URLs: https://docs.google.com/spreadsheets/d/ID/edit
 */
function toCsvExportUrl(url: string, gid?: string): string {
  // Published URL format: /d/e/PUBKEY/pubhtml  (works without auth)
  if (url.includes('/d/e/')) {
    const match = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('Invalid published Google Sheets URL');
    const pubKey = match[1];
    const base = `https://docs.google.com/spreadsheets/d/e/${pubKey}/pub`;
    return gid ? `${base}?gid=${gid}&single=true&output=csv` : `${base}?output=csv`;
  }
  // Regular edit URL — will likely get 403 unless publicly shared
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) throw new Error('Invalid Google Sheets URL. Use the published /pubhtml URL instead.');
  const id = idMatch[1];
  const base = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  return gid ? `${base}&gid=${gid}` : base;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/**
 * Fetch the published pubhtml and return [{ name, gid }] for every sheet tab.
 * Google Sheets renders the tab bar as <li id="sheet-button-GID">...<a ...>Name</a>.
 * We try several markup shapes so detection is resilient to layout changes.
 */
export async function fetchSheetTabs(pubhtmlUrl: string): Promise<{ name: string; gid: string }[]> {
  const url = pubhtmlUrl.includes('/pubhtml')
    ? pubhtmlUrl
    : pubhtmlUrl.replace(/\/pub(\?.*)?$/, '/pubhtml');
  const res = await axios.get<string>(url, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
  });
  const html = res.data as string;
  const tabs: { name: string; gid: string }[] = [];
  const add = (gid: string, rawName: string) => {
    const name = decodeEntities(rawName).replace(/<[^>]+>/g, '').trim();
    if (gid && name && !tabs.find(t => t.gid === gid)) tabs.push({ gid, name });
  };

  let m: RegExpExecArray | null;

  // PRIMARY: anchors carrying the REAL gid in their href. Note the id in
  // `sheet-button-N` is often a sequential index, NOT the gid, so href is the
  // authoritative source for the gid → match it first.
  const reA = /<a\b[^>]*\bhref="[^"]*[?#&]gid=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = reA.exec(html)) !== null) add(m[1], m[2]);

  // FALLBACK: the <li id="sheet-button-GID"><a>Name</a> tab bar (older markup
  // where the id genuinely is the gid).
  if (tabs.length === 0) {
    const reLi = /id="sheet-button-(\d+)"[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = reLi.exec(html)) !== null) add(m[1], m[2]);
  }

  // LAST RESORT: scan for gid=NUMBER anywhere and grab nearby text as the name.
  if (tabs.length === 0) {
    const reG = /[?#&]gid=(\d+)[^>]*>([^<]{1,40})</g;
    while ((m = reG.exec(html)) !== null) add(m[1], m[2]);
  }
  return tabs;
}

/** Find the gid of the tab whose name matches the current portfolio year (e.g. "2026"). */
async function resolveYearGid(
  pubhtmlUrl: string,
  preferredName?: string,
): Promise<{ gid?: string; tabName?: string; tabs: { name: string; gid: string }[]; tabError?: string }> {
  let tabs: { name: string; gid: string }[] = [];
  try {
    tabs = await fetchSheetTabs(pubhtmlUrl);
  } catch (e: any) {
    return { tabs: [], tabError: e?.message ?? 'No se pudieron leer las pestañas' };
  }
  const year = preferredName?.trim() || String(new Date().getFullYear());
  // Exact match first, then any tab whose name contains the year token.
  const exact = tabs.find(t => t.name.trim().toLowerCase() === year.toLowerCase());
  const partial = tabs.find(t => new RegExp(`\\b${year}\\b`, 'i').test(t.name));
  const chosen = exact ?? partial;
  return { gid: chosen?.gid, tabName: chosen?.name, tabs };
}

/** Remove diacritics/accents and lowercase — "Compañía" → "compania" */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // strip combining diacritical marks
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
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
 * Tokenize a full CSV into rows of cells, respecting quoted fields that contain
 * embedded newlines. Splitting on "\n" first (as parseRow-per-line does) breaks a
 * cell like Constellation's ticker "FRA:\nW9C", desync-ing every following column.
 * Newlines inside quotes are flattened to a space so the cell stays a single token.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let current = '';
  let inQuotes = false;
  const t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"') {
      if (inQuotes && t[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(current); current = '';
    } else if (ch === '\n' && !inQuotes) {
      cells.push(current); rows.push(cells); cells = []; current = '';
    } else if (ch === '\n' && inQuotes) {
      current += ' '; // embedded newline inside a quoted cell → keep one cell
    } else {
      current += ch;
    }
  }
  // Flush the final cell/row if the file doesn't end with a newline.
  if (current !== '' || cells.length > 0) { cells.push(current); rows.push(cells); }
  return rows;
}

/** Convert an A1 reference ("P26", "AA3") to zero-based [row, col]. */
function a1ToRowCol(ref: string): { row: number; col: number } | null {
  const m = ref.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10) - 1, col: col - 1 };
}

/** Read a numeric value at an A1 cell from a raw CSV grid (handles %, €, EU decimals). */
function cellNum(grid: string[][], ref: string): number | null {
  const rc = a1ToRowCol(ref);
  if (!rc) return null;
  const raw = grid[rc.row]?.[rc.col];
  return raw != null ? toNum(raw) : null;
}

/**
 * Find a cell whose text matches one of `labels` (normalized, accent-insensitive) and
 * return the first numeric value to its right on the same row. Used for summary cells
 * like "Win/Lost ROA" whose exact A1 position can shift between sheets.
 */
function findLabeledValue(grid: string[][], labels: string[]): number | null {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const wanted = labels.map(norm);
  for (const row of grid) {
    for (let c = 0; c < row.length; c++) {
      const cell = norm(row[c] ?? '');
      if (cell && wanted.some(w => cell === w || cell.includes(w))) {
        for (let k = c + 1; k < row.length; k++) {
          const v = toNum(row[k]);
          if (v != null) return v;
        }
      }
    }
  }
  return null;
}

function parseCsv(text: string): { rows: Record<string, string>[]; rawHeaders: string[]; normHeaders: string[] } {
  // Tokenize respecting quoted newlines so multiline cells (e.g. Constellation's
  // "FRA:\nW9C" ticker) don't shift the columns of their row.
  const grid = parseCsvRows(text);

  // Anchor on the POSITIONS header ("Producto | Cantidad | Sector"). The sheet has
  // summary blocks plus a second SALES table whose header also starts with
  // "Producto" but carries a "Valor venta" column. Anchoring on the sales header
  // would misalign every row (no share count → no weight), so we explicitly skip
  // any header containing "valor venta"/"valor salvado" and prefer a row that has
  // both "cantidad" and "sector".
  let headerLine = -1;
  let headerScore = -1;
  for (let i = 0; i < Math.min(60, grid.length); i++) {
    const norm = grid[i].map(normalize);
    const isSales = norm.some(c => c.includes('valor_venta') || c.includes('valor_salvado'));
    if (isSales) continue;
    const hasProducto = norm.some(c => c.includes('producto'));
    const hasCantidad = norm.some(c => c.includes('cantidad'));
    const hasSector   = norm.some(c => c.includes('sector'));
    // Score candidates; the positions header has all three.
    const score = (hasProducto ? 1 : 0) + (hasCantidad ? 1 : 0) + (hasSector ? 1 : 0);
    if ((hasProducto || (hasCantidad && hasSector)) && score > headerScore) {
      headerLine = i; headerScore = score;
      if (score === 3) break; // perfect match — stop early
    }
  }
  // Fallback: first row that looks like a header (≥2 non-empty cells).
  if (headerLine === -1) {
    headerLine = 0;
    for (let i = 0; i < Math.min(5, grid.length); i++) {
      if (grid[i].filter(c => c.trim()).length >= 2) { headerLine = i; break; }
    }
  }

  const rawHeaders = (grid[headerLine] ?? []).map(h => h.trim());
  const normHeaders = rawHeaders.map(normalize);

  const rows: Record<string, string>[] = [];
  for (let i = headerLine + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells.every(c => !c.trim())) continue;

    // Stop at the next table. The sheet repeats a "Producto | Ticker | … | Valor
    // venta | …" header for the SALES log further down; its rows have ticker+sector
    // and would otherwise be imported as (or overwrite) holdings. A row that
    // re-declares a header — or introduces a "Valor venta" column — ends the
    // positions table, so we stop reading there.
    const norm = cells.map(normalize);
    const isSalesHeader = norm.some(c => c.includes('valor_venta') || c.includes('valor_salvado'));
    const isHeaderRepeat = norm.includes('producto') ||
      (norm.includes('ticker') && norm.includes('cantidad'));
    if (i !== headerLine && (isSalesHeader || isHeaderRepeat)) break;

    const row: Record<string, string> = {};
    normHeaders.forEach((h, idx) => { row[h] = (cells[idx] ?? '').trim(); });
    rows.push(row);
  }

  return { rows, rawHeaders, normHeaders };
}

/** Find a value by multiple possible column names (normalized). Substring match as fallback. */
function pick(row: Record<string, string>, normHeaders: string[], ...keys: string[]): string {
  // Exact match first
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  // Substring match: e.g. "precio_de_entrada" contains "precio_entrada"
  for (const k of keys) {
    const found = normHeaders.find(h => h.includes(k) || k.includes(h));
    if (found && row[found] !== undefined && row[found] !== '') return row[found];
  }
  return '';
}

function toNum(s: string): number | null {
  if (!s) return null;
  let cleaned = s.replace(/[%€$£\s]/g, '').trim();
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma !== -1 && lastComma > lastDot) {
    // European format: "7,5" or "1.234,56" → "7.5" or "1234.56"
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    // US/standard format: "7.5" or "1,234.56" → "7.5" or "1234.56"
    cleaned = cleaned.replace(/,/g, '');
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// Normalized name fragments that identify summary/accounting rows (not holdings):
// "2024 Start Value", "Money Invested", "Turnover", "Return on assets",
// "Comisiones", "Interés", "Ventas", "SPYTD", "Valor compra", etc.
const JUNK_NAME_TOKENS = [
  'producto', 'cantidad', 'start_value', 'money_invest', 'invested', 'turnover',
  'on_assets', 'assets', 'roa', 'coste', 'comision', 'interes', 'spytd', 'sp_ytd',
  'valor_compra', 'valor_inicio', 'ventas', 'difference', 'win_lost', 'win_lose',
  'return_on', 'spi500', 'sp500', 'benchmark', 'total',
];

function letterCount(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

/** A real sector cell has letters and is not a bare number. */
function hasRealSector(sector: string): boolean {
  const s = (sector ?? '').trim();
  return s.length >= 3 && toNum(s) === null && /\p{L}/u.test(s);
}

/** A usable ticker has at least one letter and is not a bare number. */
function hasUsableTicker(ticker: string): boolean {
  const t = (ticker ?? '').trim();
  return t.length >= 1 && /[A-Za-z]/.test(t) && toNum(t) === null;
}

/**
 * Decide whether a sheet row is an actual portfolio holding (vs. a summary line,
 * a stray number, or a name-only fragment from a neighbouring block). A holding
 * needs a real name plus EITHER a ticker OR a recognizable sector.
 */
function isRealHolding(name: string, ticker: string, sector: string): boolean {
  const nm = (name ?? '').trim();
  if (letterCount(nm) < 2) return false;                       // pure numbers / fragments
  const n = normalize(nm);
  if (JUNK_NAME_TOKENS.some(j => n.includes(j))) return false; // accounting/summary rows
  return hasUsableTicker(ticker) || hasRealSector(sector);
}

export interface SyncResult {
  updated: number;
  inserted: number;
  skipped: number;
  errors: string[];
  headers?: string[];   // raw column names found — useful for debugging
  sample?: string;      // first data row for debugging
  usedTab?: string;     // name of the sheet tab actually synced
  usedGid?: string;     // gid of that tab
  availableTabs?: string[]; // every tab detected (debugging which sheet was picked)
  deactivated?: number; // positions moved out of the portfolio (no longer in sheet)
  pricesUpdated?: number; // companies whose live price was refreshed during sync
  purged?: number;      // junk rows (summary/number/fragment) removed from the DB
  totalPnl?: number | null; // portfolio P&L read from the sheet's pnl cell (e.g. P26)
  portfolioReturn?: number | null; // "Return on assets" — the portfolio's YTD return %
  moneyInvested?: number | null;
  startValue?: number | null;
}

export async function syncFromSheets(
  sheetUrl: string,
  opts: { tab?: string; gid?: string; pnlCell?: string } = {},
): Promise<SyncResult> {
  // Portfolio positions live on the current-year tab (e.g. "2026"), not the first
  // sheet. Prefer an explicit numeric gid (manual selector); otherwise resolve by
  // year/tab name. A non-numeric "gid" (e.g. the user typed "2026") is treated as a
  // tab name so it still works instead of producing an invalid CSV URL (HTTP 400).
  let gid = opts.gid && /^\d+$/.test(opts.gid) ? opts.gid : undefined;
  const nameHint = opts.tab || (opts.gid && !/^\d+$/.test(opts.gid) ? opts.gid : undefined);
  let tabName: string | undefined;
  let tabs: { name: string; gid: string }[] = [];
  let tabError: string | undefined;
  if (gid) {
    try { tabs = await fetchSheetTabs(sheetUrl); } catch { /* non-fatal */ }
    tabName = tabs.find(t => t.gid === gid)?.name ?? `gid ${gid}`;
  } else {
    ({ gid, tabName, tabs, tabError } = await resolveYearGid(sheetUrl, nameHint));
  }
  const csvUrl = toCsvExportUrl(sheetUrl, gid);
  const result: SyncResult = {
    updated: 0, inserted: 0, skipped: 0, errors: [],
    usedTab: tabName, usedGid: gid, availableTabs: tabs.map(t => t.name),
  };
  console.log(`[sync] Tabs detected: ${tabs.map(t => `${t.name}#${t.gid}`).join(', ') || '(none)'}`);
  console.log(`[sync] Using sheet tab "${tabName ?? '(first/default)'}" (gid=${gid ?? 'default'})`);
  if (tabError) result.errors.push(`Aviso pestañas: ${tabError}`);
  if (!gid && !opts.gid) {
    const year = opts.tab || String(new Date().getFullYear());
    result.errors.push(
      tabs.length
        ? `No se encontró la pestaña "${year}". Pestañas: ${tabs.map(t => t.name).join(', ')}. Usando la primera hoja.`
        : `No se detectaron pestañas en el sheet publicado. Usando la primera hoja.`
    );
  }

  let csvText: string;
  try {
    const response = await axios.get<string>(csvUrl, {
      timeout: 20000,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
      },
    });
    csvText = response.data;
  } catch (e: any) {
    const hint = csvUrl.includes('/export?format=csv')
      ? ' Publica el sheet en Google Sheets: Archivo → Compartir → Publicar en la web → usar URL /pubhtml'
      : '';
    throw new Error(`No se pudo descargar el sheet: ${e.message}.${hint}`);
  }

  if (!csvText || csvText.trim().length < 10) {
    result.errors.push('El sheet devolvió contenido vacío');
    return result;
  }

  const { rows, rawHeaders, normHeaders } = parseCsv(csvText);
  result.headers = rawHeaders;

  // Read the portfolio total P&L. Prefer searching for the "Win/Lost ROA" label and
  // taking the value to its right (robust to row/column shifts); fall back to a fixed
  // cell ref (e.g. P26) if the label isn't found. This is the sheet's own
  // authoritative W/L. We use the full grid, not the trimmed positions table.
  {
    const fullGrid = parseCsvRows(csvText);
    result.totalPnl = findLabeledValue(fullGrid, ['win/lost roa', 'win/loss roa', 'win lost roa', 'winlost', 'w/l roa']);
    if (result.totalPnl == null && opts.pnlCell) {
      result.totalPnl = cellNum(fullGrid, opts.pnlCell);
    }
    // The portfolio's own performance figures from the summary block.
    result.portfolioReturn = findLabeledValue(fullGrid, ['return on assets', 'roa', 'rentabilidad cartera', 'retorno cartera']);
    result.moneyInvested  = findLabeledValue(fullGrid, ['money invested', 'dinero invertido', 'capital invertido']);
    result.startValue     = findLabeledValue(fullGrid, ['start value', 'valor inicio', 'valor inicial']);
    console.log(`[sync] Win/Lost ROA=${result.totalPnl} · ReturnOnAssets=${result.portfolioReturn} · MoneyInvested=${result.moneyInvested}`);
  }

  console.log('[sync] Raw headers:', rawHeaders.join(' | '));
  console.log('[sync] Norm headers:', normHeaders.join(' | '));
  console.log('[sync] Row count:', rows.length);

  if (rows.length === 0) {
    result.errors.push(`No se encontraron filas de datos. Columnas detectadas: ${rawHeaders.join(', ')}`);
    return result;
  }

  result.sample = JSON.stringify(rows[0]);
  console.log('[sync] First row sample:', result.sample);

  // Track every company present on the 2026 tab so we can deactivate the rest:
  // the 2026 sheet is the source of truth for what is currently held.
  const seenIds: string[] = [];

  for (const row of rows) {
    // Try to find company name — fallback to first non-empty column
    let name = pick(row, normHeaders,
      'producto', 'name', 'nombre', 'empresa', 'compania', 'company',
      'nombre_empresa', 'company_name', 'razon_social', 'titulo'
    );

    // Last resort fallback: use first non-empty cell value
    if (!name) {
      const firstKey = normHeaders.find(h => row[h]?.trim());
      if (firstKey) name = row[firstKey];
    }

    // Collapse internal whitespace: a multiline ticker cell ("FRA:\nW9C") is
    // flattened to "FRA: W9C" by the CSV tokenizer — normalize back to "FRA:W9C".
    const ticker = pick(row, normHeaders, 'ticker', 'symbol', 'simbolo', 'isin')
      .replace(/\s+/g, '');
    const sector = pick(row, normHeaders, 'sector', 'industria', 'industry', 'segmento');

    // Only import genuine holdings. This rejects the summary/accounting rows,
    // stray numbers and name-only fragments that were polluting the watchlist.
    if (!isRealHolding(name, ticker, sector)) { result.skipped++; continue; }

    // Share count ("Cantidad") — drives current value & weight (computed live).
    const sharesRaw = pick(row, normHeaders,
      'cantidad', 'cant', 'acciones', 'accion', 'num_acciones', 'numero_acciones',
      'numero_de_acciones', 'n_acciones', 'no_acciones', 'no_de_acciones', 'nacciones',
      'titulos', 'participaciones', 'unidades', 'shares', 'share', 'qty', 'quantity'
    );
    const shares = toNum(sharesRaw);

    // Per-share entry price = "Valor inicio año" (column D), already in the listing
    // currency, so it's consistent with Yahoo's per-share current price. Try the
    // per-share column first; only if it's missing fall back to the USD TOTAL column
    // ("Valor inicio año(USD)") divided by the share count.
    let entry_price = toNum(pick(row, normHeaders,
      'valor_inicio_ano', 'valor_inicio_año', 'valor_inicio',
      'precio_inicio_ano', 'precio_entrada', 'precio_de_entrada', 'precio_compra',
      'coste', 'coste_medio', 'entrada'
    ));
    if (entry_price == null) {
      const totalStart = toNum(pick(row, normHeaders, 'valor_inicio_anousd', 'valor_inicio_ano_usd'));
      if (totalStart != null && shares != null && shares > 0) entry_price = totalStart / shares;
    }

    // Current position value (total) from the sheet — used as a weight fallback when
    // the share count is missing. "Valor actual(USD)" (column G) is the USD total;
    // accept several header spellings.
    const sheet_value = toNum(pick(row, normHeaders,
      'valor_actualusd', 'valor_actual_usd', 'valor_actual',
      'valor_a_dia_de_hoy', 'valor_dia_de_hoy', 'valor_hoy',
      'valor_de_mercado', 'valor_mercado', 'valor_posicion', 'current_value', 'market_value'
    ));

    // Optional explicit weight column (rarely present — weight is normally computed).
    const posRaw = pick(row, normHeaders,
      'position_size', 'peso', 'weight', 'posicion', 'pct', 'porcentaje', 'allocation'
    );
    const position_size = toNum(posRaw);

    // Position P&L straight from the sheet — "Retorno / Perdida" (col I) already
    // includes dividends, and "R/P %" (col J) is its percentage. Dividends (col H)
    // are kept separately for display.
    const pnl_value = toNum(pick(row, normHeaders,
      'retorno__perdida', 'retorno_perdida', 'retorno_perdida_usd', 'retorno',
      'ganancia_perdida', 'pnl', 'win_loss', 'resultado'
    ));
    const pnl_pct = toNum(pick(row, normHeaders,
      'rp_', 'rp', 'r_p', 'retorno_perdida_pct', 'rp_pct', 'porcentaje_rp'
    ));
    const dividends = toNum(pick(row, normHeaders,
      'dividendos', 'dividends', 'dividendo', 'dividend'
    ));

    try {
      const existing = await pool.query(
        `SELECT id FROM companies
         WHERE LOWER(name) = LOWER($1)
            OR (ticker IS NOT NULL AND ticker <> '' AND LOWER(ticker) = LOWER($2))`,
        [name, ticker || '__NOTICKER__']
      );

      if (existing.rows.length > 0) {
        // Overwrite shares/entry from the sheet (the 2026 tab is authoritative),
        // not COALESCE — a blank in the sheet should clear a stale value.
        await pool.query(
          `UPDATE companies SET
            ticker       = COALESCE(NULLIF($1,''), ticker),
            entry_price  = $2,
            sector       = COALESCE(NULLIF($3,''), sector),
            position_size= $4,
            shares       = $5,
            sheet_value  = $6,
            pnl_value    = $7,
            pnl_pct      = $8,
            dividends    = $9,
            status       = 'active',
            updated_at   = NOW()
           WHERE id = $10`,
          [ticker || null, entry_price, sector || null, position_size, shares, sheet_value,
           pnl_value, pnl_pct, dividends, existing.rows[0].id]
        );
        seenIds.push(existing.rows[0].id);
        result.updated++;
      } else {
        // Don't force a currency: many positions are non-US (EPA:RMS, FRA:W9C…).
        // The price refresh that runs right after sync sets the real listing
        // currency from Yahoo, which the portfolio FX conversion then relies on.
        const ins = await pool.query(
          `INSERT INTO companies (name, ticker, sector, entry_price, position_size, shares, sheet_value, pnl_value, pnl_pct, dividends, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active') RETURNING id`,
          [name, ticker || null, sector || null, entry_price, position_size, shares, sheet_value, pnl_value, pnl_pct, dividends]
        );
        seenIds.push(ins.rows[0].id);
        result.inserted++;
      }
    } catch (e: any) {
      result.errors.push(`${name}: ${e.message}`);
    }
  }

  // The 2026 tab is the live portfolio: any company still marked active but absent
  // from the sheet (e.g. ASML after it was sold) is moved out of the portfolio.
  if (seenIds.length > 0) {
    const deact = await pool.query(
      `UPDATE companies SET status = 'sold', updated_at = NOW()
       WHERE status = 'active' AND id <> ALL($1::uuid[])
       RETURNING name`,
      [seenIds]
    );
    result.deactivated = deact.rowCount ?? 0;
    if (deact.rowCount) {
      console.log(`[sync] Deactivated ${deact.rowCount} positions no longer in sheet:`,
        deact.rows.map((r: any) => r.name).join(', '));
    }

    // One-time cleanup: earlier syncs imported summary lines, stray numbers and
    // name fragments as bogus companies. Delete those leftovers — but never touch
    // curated companies (thesis, model or Notion page) or current holdings.
    try {
      const { rows: all } = await pool.query(
        `SELECT id, name, ticker, sector FROM companies
         WHERE notion_page_id IS NULL
           AND (thesis_url IS NULL OR thesis_url = '')
           AND (thesis_content IS NULL OR thesis_content = '')
           AND (model_url IS NULL OR model_url = '')`
      );
      const seen = new Set(seenIds);
      const junkIds = all
        .filter((c: any) => !seen.has(c.id) &&
          !isRealHolding(c.name ?? '', c.ticker ?? '', c.sector ?? ''))
        .map((c: any) => c.id);
      if (junkIds.length) {
        const del = await pool.query(
          `DELETE FROM companies WHERE id = ANY($1::uuid[]) RETURNING name`, [junkIds]
        );
        result.purged = del.rowCount ?? 0;
        console.log(`[sync] Purged ${del.rowCount} junk rows:`,
          del.rows.map((r: any) => r.name).join(', '));
      }
    } catch (e: any) {
      result.errors.push(`No se pudo limpiar basura: ${e?.message ?? e}`);
    }
  }

  // Persist the sheet's own performance figures (P&L, return, money invested) into the
  // current-year history row so the Cartera header shows the real numbers instead of a
  // stale manual estimate. "Return on assets" can be a fraction (0.0118) or percent.
  if (result.totalPnl != null || result.portfolioReturn != null || result.moneyInvested != null) {
    try {
      const year = new Date().getFullYear();
      const ret = result.portfolioReturn == null ? null
        : (Math.abs(result.portfolioReturn) <= 1.5 ? result.portfolioReturn * 100 : result.portfolioReturn);
      await pool.query(
        `INSERT INTO portfolio_performance_history (period, period_type, win_lose_usd, portfolio_return, money_invested, notes)
         VALUES ($1, 'annual', $2, $3, $4, 'Sincronizado desde la hoja')
         ON CONFLICT (period, period_type) DO UPDATE SET
           win_lose_usd     = COALESCE(EXCLUDED.win_lose_usd, portfolio_performance_history.win_lose_usd),
           portfolio_return = COALESCE(EXCLUDED.portfolio_return, portfolio_performance_history.portfolio_return),
           money_invested   = COALESCE(EXCLUDED.money_invested, portfolio_performance_history.money_invested)`,
        [`${year} YTD`, result.totalPnl, ret, result.moneyInvested]
      );
    } catch (e: any) {
      result.errors.push(`No se pudo guardar el rendimiento: ${e?.message ?? e}`);
    }
  }

  // Pull live prices right away so weight (= shares × current price / total) can be
  // computed immediately, instead of staying blank until the next price cron run.
  try {
    const r = await refreshAllCompanyPrices();
    result.pricesUpdated = r.updated;
  } catch (e: any) {
    result.errors.push(`No se pudieron refrescar precios: ${e?.message ?? e}`);
  }

  return result;
}
