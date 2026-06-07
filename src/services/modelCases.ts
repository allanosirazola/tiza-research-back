import axios from 'axios';
import * as cheerio from 'cheerio';
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
export interface SheetRef { kind: 'published' | 'regular'; key: string; }

export function extractPubKey(url: string): SheetRef {
  const pub = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)/);
  if (pub) return { kind: 'published', key: pub[1] };
  const reg = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (reg) return { kind: 'regular', key: reg[1] };
  throw new Error('URL de Google Sheets no válida (esperaba /d/e/PUBKEY o /spreadsheets/d/ID)');
}

export function csvUrl(ref: SheetRef, gid: string): string {
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

export function parseGrid(csv: string): string[][] {
  // Tokenize the whole CSV respecting quoted newlines, so multiline cells (e.g. a
  // "CAGR\n5 años" header) don't split a row and shift its columns.
  const rows: string[][] = [];
  let cells: string[] = [];
  let cur = '';
  let inQ = false;
  const t = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"') {
      if (inQ && t[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      cells.push(cur); cur = '';
    } else if (ch === '\n' && !inQ) {
      cells.push(cur); rows.push(cells.map(c => c.trim())); cells = []; cur = '';
    } else if (ch === '\n' && inQ) {
      cur += ' ';
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || cells.length) { cells.push(cur); rows.push(cells.map(c => c.trim())); }
  return rows;
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

/** Candidate URLs to enumerate tabs, depending on how the sheet is shared. */
function tabListUrls(ref: SheetRef): string[] {
  if (ref.kind === 'published') {
    return [`https://docs.google.com/spreadsheets/d/e/${ref.key}/pubhtml`];
  }
  // A regular (link-shared) sheet isn't "published", so /pubhtml 404s. /htmlview
  // renders the tab bar for anyone-with-link sheets; keep /pubhtml as a fallback.
  return [
    `https://docs.google.com/spreadsheets/d/${ref.key}/htmlview`,
    `https://docs.google.com/spreadsheets/d/${ref.key}/pubhtml`,
  ];
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

export function parseTabsFromHtml(htmlRaw: string): { name: string; gid: string }[] {
  const html = decodeEntities(htmlRaw);
  const tabs: { name: string; gid: string }[] = [];
  const add = (gid: string, rawName: string) => {
    const name = rawName.replace(/<[^>]+>/g, '').trim();
    if (gid && name && !tabs.find(t => t.gid === gid)) tabs.push({ gid, name });
  };
  let m: RegExpExecArray | null;

  // 1) cheerio on the published tab bar (most reliable — same as the cartera path).
  try {
    const $ = cheerio.load(htmlRaw);
    $('#sheet-menu li, ul.sheets li, li[id^="sheet-button"]').each((_, el) => {
      const $el = $(el);
      const href = $el.find('a').attr('href') ?? '';
      const gid = (href.match(/[?#&]gid=(\d+)/) ?? [])[1] ?? ($el.attr('id')?.match(/(\d+)/) ?? [])[1];
      const name = $el.find('a').text() || $el.text();
      if (gid) add(gid, name);
    });
    if (tabs.length) return tabs;
    // Any anchor anywhere carrying a gid.
    $('a[href*="gid="]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const gid = (href.match(/[?#&]gid=(\d+)/) ?? [])[1];
      if (gid) add(gid, $(el).text());
    });
    if (tabs.length) return tabs;
  } catch { /* fall through to regex */ }

  // 2) regex: anchor href with gid → name.
  const reA = /<a\b[^>]*\bhref="[^"]*[?#&]gid=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = reA.exec(html)) !== null) add(m[1], m[2]);
  if (tabs.length) return tabs;

  // 3) regex: <li id="sheet-button-GID">…Name.
  const reLi = /id="sheet-button-(\d+)"[\s\S]*?>([^<]{1,80})</g;
  while ((m = reLi.exec(html)) !== null) add(m[1], m[2]);
  if (tabs.length) return tabs;

  // 4) last resort: gid=N anywhere followed by short text.
  const reG = /[?#&]gid=(\d+)[^>]*>\s*([^<]{1,80}?)\s*</g;
  while ((m = reG.exec(html)) !== null) add(m[1], m[2]);
  return tabs;
}

/** Extract the sheet gids in document order from a pubhtml, even when there are no
 *  named <li>/<a> tabs (newer Google markup only embeds bare gid= references). */
export function extractGidsInOrder(htmlRaw: string): string[] {
  const html = decodeEntities(htmlRaw);
  const seen = new Set<string>();
  const order: string[] = [];
  const re = /gid=(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); order.push(m[1]); }
  }
  return order;
}

/** Does a sheet grid look like the "4.1 Valoración por casos" tab? */
function looksLikeCasesGrid(grid: string[][]): boolean {
  const flat = grid.slice(0, 12).map(r => r.map(c => normName(c)).join(' ')).join(' | ');
  const hasObjetivo = flat.includes('precio objetivo');
  const hasCases = flat.includes('caso mejor') || flat.includes('caso medio') || flat.includes('caso peor');
  const hasProj = flat.includes('proyeccion a futuro') || flat.includes('crecimiento en ventas');
  return (hasObjetivo && hasCases) || hasCases || (hasObjetivo && hasProj);
}

/** Resolve the cases-sheet gid by fetching each tab and checking its content.
 *  Works regardless of tab markup/names — the last resort when names aren't found. */
async function resolveCasesGidByContent(ref: SheetRef): Promise<string | undefined> {
  let html = '';
  try {
    const res = await axios.get<string>(
      ref.kind === 'published'
        ? `https://docs.google.com/spreadsheets/d/e/${ref.key}/pubhtml`
        : `https://docs.google.com/spreadsheets/d/${ref.key}/htmlview`,
      { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' } },
    );
    html = res.data as string;
  } catch { return undefined; }

  const gids = extractGidsInOrder(html);
  if (!gids.length) return undefined;

  // The template's tab order is fixed: 4.1 Valoración por casos is the 5th sheet.
  // Try that first (fast path), then fall back to scanning each tab's content.
  const candidates = gids[4] ? [gids[4], ...gids.filter((_, i) => i !== 4)] : gids;
  for (const gid of candidates) {
    try {
      const res = await axios.get<string>(csvUrl(ref, gid), {
        timeout: 15000, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
      });
      if (looksLikeCasesGrid(parseGrid(res.data))) return gid;
    } catch { /* try next */ }
  }
  return undefined;
}

export async function fetchTabs(ref: SheetRef): Promise<{ name: string; gid: string }[]> {
  // For published sheets, reuse the robust shared parser first.
  if (ref.kind === 'published') {
    try {
      const tabs = await fetchSheetTabs(`https://docs.google.com/spreadsheets/d/e/${ref.key}/pubhtml`);
      if (tabs.length) return tabs;
    } catch { /* fall through */ }
  }

  const errors: string[] = [];
  for (const url of tabListUrls(ref)) {
    try {
      const res = await axios.get<string>(url, {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
      });
      const tabs = parseTabsFromHtml(res.data as string);
      if (tabs.length) return tabs;
      errors.push(`${url} → 200 pero 0 pestañas`);
    } catch (e: any) {
      errors.push(`${url} → ${e?.response?.status ?? e?.message ?? 'error'}`);
    }
  }
  // Surface why nothing was found so the UI can tell the user to publish the sheet.
  throw new Error(
    `No se pudieron leer las pestañas del modelo (${ref.kind}). ` +
    `Probablemente el modelo no está "Publicado en la web". Detalle: ${errors.join(' ; ')}`
  );
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

/** Debug: fetch the pubhtml and return tabs + an HTML snippet around the first
 *  "gid=" / "sheet-button" so we can see Google's real markup when parsing fails. */
export async function debugModelTabs(modelUrl: string): Promise<any> {
  const ref = extractPubKey(modelUrl);
  const out: any = { ref, attempts: [] };
  for (const url of tabListUrls(ref)) {
    try {
      const res = await axios.get<string>(url, {
        timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
      });
      const html = res.data as string;
      const tabs = parseTabsFromHtml(html);
      // Capture the ACTUAL <ul id="sheet-menu"> element (not the CSS rule) and the
      // first few gid= occurrences so we can see Google's real tab markup.
      const menuMatch = html.match(/<ul[^>]*id="sheet-menu"[\s\S]*?<\/ul>/i);
      const gidHits = (html.match(/gid=\d+/g) ?? []).slice(0, 12);
      const liHits = (html.match(/<li[^>]*>[\s\S]*?<\/li>/gi) ?? []).slice(0, 12);
      out.attempts.push({
        url, status: 200, length: html.length, tabsFound: tabs.length, tabs,
        menu: menuMatch ? menuMatch[0].slice(0, 2000) : '(no <ul id="sheet-menu"> found)',
        gidHits,
        liSample: liHits,
      });
    } catch (e: any) {
      out.attempts.push({ url, status: e?.response?.status ?? null, error: e?.message });
    }
  }
  return out;
}

export async function fetchModelCases(
  modelUrl: string,
  opts: { gid?: string; returnCell?: string; cagrCell?: string } = {}
): Promise<ModelCasesData> {
  const pubKey = extractPubKey(modelUrl);
  let gid = opts.gid;
  if (!gid) {
    // Try named-tab detection first; if the markup has no named tabs (newer Google
    // pubhtml only embeds bare gids), fall back to content-based detection.
    let tabs: { name: string; gid: string }[] = [];
    try { tabs = await fetchTabs(pubKey); } catch { /* no named tabs */ }
    gid = pickCasesGid(tabs);
    if (!gid) gid = await resolveCasesGidByContent(pubKey);
    if (!gid) {
      const list = tabs.length ? tabs.map(t => t.name).join(' | ') : '(sin pestañas con nombre)';
      throw new Error(`No se encontró "4.1 Valoración por casos" (ni por nombre ni por contenido). Pestañas: ${list}`);
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
