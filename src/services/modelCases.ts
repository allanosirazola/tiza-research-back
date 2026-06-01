import axios from 'axios';
import { fetchSheetTabs } from './sheetsSync';

/**
 * Reads the "valoración por casos" sheet of a published Google Sheets model:
 *  - 6 scenario columns (bull×2, base×2, bear×2)
 *  - 2 weighted-average columns (0.2 / 0.6 / 0.2)
 *  - projection variables (columns K–N)
 *  - user-chosen cells for Return and CAGR (default H10 / H11)
 */

export interface ModelCasesData {
  gid: string;
  tabName?: string;
  headers: string[];
  rows: string[][];
  returnCell: string;
  cagrCell: string;
  returnValue: number | null;
  cagrValue: number | null;
}

// A model URL is either a PUBLISHED sheet (/d/e/PUBKEY/…) or a regular shared sheet
// (/spreadsheets/d/ID/edit). Track which so we can build the right CSV/pubhtml URLs.
interface SheetRef { kind: 'published' | 'regular'; key: string; }

function extractPubKey(url: string): SheetRef {
  const pub = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)/);
  if (pub) return { kind: 'published', key: pub[1] };
  const reg = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (reg) return { kind: 'regular', key: reg[1] };
  throw new Error('URL de Google Sheets no válida (esperaba /d/e/PUBKEY o /spreadsheets/d/ID)');
}

function csvUrl(ref: SheetRef, gid: string): string {
  return ref.kind === 'published'
    ? `https://docs.google.com/spreadsheets/d/e/${ref.key}/pub?gid=${gid}&single=true&output=csv`
    : `https://docs.google.com/spreadsheets/d/${ref.key}/export?format=csv&gid=${gid}`;
}

function pubhtmlUrl(ref: SheetRef): string {
  return ref.kind === 'published'
    ? `https://docs.google.com/spreadsheets/d/e/${ref.key}/pubhtml`
    : `https://docs.google.com/spreadsheets/d/${ref.key}/pubhtml`;
}

function parseRow(line: string): string[] {
  const cells: string[] = [];
  let inQ = false, cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { cells.push(cur); cur = ''; }
    else { cur += ch; }
  }
  cells.push(cur);
  return cells;
}

function parseGrid(csv: string): string[][] {
  return csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(l => parseRow(l).map(c => c.trim()));
}

/** Convert an A1 reference (e.g. "H10", "AA3") to zero-based [row, col]. */
export function a1ToRowCol(ref: string): { row: number; col: number } | null {
  const m = ref.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10) - 1, col: col - 1 };
}

/** Read a numeric value at an A1 cell from a raw grid. Handles %, currency, EU decimals. */
export function cellNum(grid: string[][], ref: string): number | null {
  const rc = a1ToRowCol(ref);
  if (!rc) return null;
  const raw = grid[rc.row]?.[rc.col];
  if (raw == null || raw === '') return null;
  let c = raw.replace(/[%€$£\s]/g, '').trim();
  const lc = c.lastIndexOf(','), ld = c.lastIndexOf('.');
  if (lc !== -1 && lc > ld) c = c.replace(/\./g, '').replace(',', '.');
  else c = c.replace(/,/g, '');
  const n = parseFloat(c);
  return isNaN(n) ? null : n;
}

async function fetchTabs(ref: SheetRef): Promise<{ name: string; gid: string }[]> {
  // Reuse the robust multi-strategy tab parser from sheetsSync (the single-regex
  // version here missed tabs like "4.1 Valoración por casos" depending on markup).
  try {
    const tabs = await fetchSheetTabs(pubhtmlUrl(ref));
    if (tabs.length) return tabs;
  } catch { /* fall through to the local parser */ }

  const res = await axios.get<string>(pubhtmlUrl(ref), {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
  });
  const tabs: { name: string; gid: string }[] = [];
  const regex = /href="[^"]*#?gid=(\d+)"[^>]*>\s*([^<]+?)\s*<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(res.data)) !== null) {
    const name = m[2].trim();
    if (name && !tabs.find(t => t.gid === m![1])) tabs.push({ gid: m[1], name });
  }
  return tabs;
}

const normName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Pick the "valoración por casos" tab from a tab list (e.g. "4.1 Valoración por casos"). */
export function pickCasesGid(tabs: { name: string; gid: string }[]): string | undefined {
  // Match on the phrase, "por casos", the "4.1" prefix, or just "casos" — most → least specific.
  const byCases   = tabs.find(t => normName(t.name).includes('valoracion por casos'));
  const byPartial = tabs.find(t => normName(t.name).includes('por casos'));
  const byNum     = tabs.find(t => /(^|\s)4\.1(\s|$|\b)/.test(t.name.trim()));
  const byCasos   = tabs.find(t => normName(t.name).includes('casos'));
  return (byCases ?? byPartial ?? byNum ?? byCasos)?.gid;
}

/** Find the gid of the "valoración por casos" tab (e.g. "4.1 Valoración por casos"). */
export async function resolveCasesGid(modelUrl: string): Promise<string | undefined> {
  const pubKey = extractPubKey(modelUrl);
  let tabs: { name: string; gid: string }[] = [];
  try { tabs = await fetchTabs(pubKey); } catch { return undefined; }
  return pickCasesGid(tabs);
}

/** Public: list a model's tabs (for the UI selector / debugging detection). */
export async function listModelTabs(modelUrl: string): Promise<{ name: string; gid: string }[]> {
  return fetchTabs(extractPubKey(modelUrl));
}

export async function fetchModelCases(
  modelUrl: string,
  opts: { gid?: string; returnCell?: string; cagrCell?: string } = {}
): Promise<ModelCasesData> {
  const pubKey = extractPubKey(modelUrl);
  let gid = opts.gid;
  if (!gid) {
    const tabs = await fetchTabs(pubKey).catch(() => [] as { name: string; gid: string }[]);
    gid = pickCasesGid(tabs);
    if (!gid) {
      const list = tabs.length ? tabs.map(t => t.name).join(' | ') : '(ninguna detectada)';
      throw new Error(`No se encontró la pestaña de "valoración por casos". Pestañas detectadas: ${list}`);
    }
  }

  const returnCell = (opts.returnCell ?? 'H10').toUpperCase();
  const cagrCell = (opts.cagrCell ?? 'H11').toUpperCase();

  const res = await axios.get<string>(csvUrl(pubKey, gid), {
    timeout: 15000,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
  });
  const grid = parseGrid(res.data);

  // Detect header row (most-filled within first 12 rows) and trim trailing empties.
  let headerIdx = 0, best = -1;
  for (let i = 0; i < Math.min(grid.length, 12); i++) {
    const filled = grid[i].filter(c => c).length;
    if (filled > best) { best = filled; headerIdx = i; }
  }
  const headerRaw = grid[headerIdx] ?? [];
  let last = headerRaw.length - 1;
  while (last > 0 && !headerRaw[last]) last--;
  const headers = headerRaw.slice(0, last + 1);
  const rows = grid.slice(headerIdx + 1).map(r => r.slice(0, last + 1)).filter(r => r.some(c => c));

  return {
    gid,
    headers,
    rows,
    returnCell,
    cagrCell,
    returnValue: cellNum(grid, returnCell),
    cagrValue: cellNum(grid, cagrCell),
  };
}
