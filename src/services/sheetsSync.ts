import axios from 'axios';
import pool from '../db';

/**
 * Converts any Google Sheets URL to a CSV export URL.
 * Supports:
 *  - Published pubhtml URLs: https://docs.google.com/spreadsheets/d/e/PUBKEY/pubhtml
 *  - Regular edit/share URLs: https://docs.google.com/spreadsheets/d/ID/edit
 */
function toCsvExportUrl(url: string): string {
  // Published URL format: /d/e/PUBKEY/pubhtml  (works without auth)
  if (url.includes('/d/e/')) {
    const match = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('Invalid published Google Sheets URL');
    const pubKey = match[1];
    return `https://docs.google.com/spreadsheets/d/e/${pubKey}/pub?output=csv`;
  }
  // Regular edit URL — will likely get 403 unless publicly shared
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) throw new Error('Invalid Google Sheets URL. Use the published /pubhtml URL instead.');
  const id = idMatch[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
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

function parseCsv(text: string): { rows: Record<string, string>[]; rawHeaders: string[]; normHeaders: string[] } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Find the first row that looks like a header (has at least 2 non-empty cells)
  let headerLine = 0;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const cells = parseRow(lines[i]);
    if (cells.filter(c => c.trim()).length >= 2) { headerLine = i; break; }
  }

  const rawHeaders = parseRow(lines[headerLine]).map(h => h.trim());
  const normHeaders = rawHeaders.map(normalize);

  const rows: Record<string, string>[] = [];
  for (let i = headerLine + 1; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (cells.every(c => !c.trim())) continue;
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
  const n = parseFloat(s.replace(/[%€$£,\s]/g, '').replace(',', '.').trim());
  return isNaN(n) ? null : n;
}

export interface SyncResult {
  updated: number;
  inserted: number;
  skipped: number;
  errors: string[];
  headers?: string[];   // raw column names found — useful for debugging
  sample?: string;      // first data row for debugging
}

export async function syncFromSheets(sheetUrl: string): Promise<SyncResult> {
  const csvUrl = toCsvExportUrl(sheetUrl);
  const result: SyncResult = { updated: 0, inserted: 0, skipped: 0, errors: [] };

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

  console.log('[sync] Raw headers:', rawHeaders.join(' | '));
  console.log('[sync] Norm headers:', normHeaders.join(' | '));
  console.log('[sync] Row count:', rows.length);

  if (rows.length === 0) {
    result.errors.push(`No se encontraron filas de datos. Columnas detectadas: ${rawHeaders.join(', ')}`);
    return result;
  }

  result.sample = JSON.stringify(rows[0]);
  console.log('[sync] First row sample:', result.sample);

  for (const row of rows) {
    // Try to find company name — fallback to first non-empty column
    let name = pick(row, normHeaders,
      'name', 'nombre', 'empresa', 'compania', 'company',
      'nombre_empresa', 'company_name', 'razon_social', 'titulo'
    );

    // Last resort fallback: use first non-empty cell value
    if (!name) {
      const firstKey = normHeaders.find(h => row[h]?.trim());
      if (firstKey) name = row[firstKey];
    }

    if (!name || name.length < 2) { result.skipped++; continue; }
    // Skip header-like rows that got through
    if (['nombre', 'empresa', 'name', 'company', 'compania'].includes(name.toLowerCase())) {
      result.skipped++; continue;
    }

    const ticker = pick(row, normHeaders, 'ticker', 'symbol', 'simbolo', 'isin');
    const sector = pick(row, normHeaders, 'sector', 'industria', 'industry', 'segmento');
    const entryPriceRaw = pick(row, normHeaders,
      'entry_price', 'precio_entrada', 'precio_de_entrada',
      'coste', 'coste_medio', 'precio_compra', 'entrada'
    );
    const entry_price = toNum(entryPriceRaw);

    // Also try to pull weight/position from sheet
    const posRaw = pick(row, normHeaders,
      'position_size', 'peso', 'weight', 'posicion', 'pct', 'porcentaje', 'allocation'
    );
    const position_size = toNum(posRaw);

    try {
      const existing = await pool.query(
        `SELECT id FROM companies
         WHERE LOWER(name) = LOWER($1)
            OR (ticker IS NOT NULL AND ticker <> '' AND LOWER(ticker) = LOWER($2))`,
        [name, ticker || '__NOTICKER__']
      );

      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE companies SET
            ticker       = COALESCE(NULLIF($1,''), ticker),
            entry_price  = COALESCE($2, entry_price),
            sector       = COALESCE(NULLIF($3,''), sector),
            position_size= COALESCE($4, position_size),
            status       = 'active',
            updated_at   = NOW()
           WHERE id = $5`,
          [ticker || null, entry_price, sector || null, position_size, existing.rows[0].id]
        );
        result.updated++;
      } else {
        await pool.query(
          `INSERT INTO companies (name, ticker, sector, entry_price, position_size, status, currency)
           VALUES ($1, $2, $3, $4, $5, 'active', 'EUR')`,
          [name, ticker || null, sector || null, entry_price, position_size]
        );
        result.inserted++;
      }
    } catch (e: any) {
      result.errors.push(`${name}: ${e.message}`);
    }
  }

  return result;
}
