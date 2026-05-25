import axios from 'axios';
import pool from '../db';

/**
 * Converts any Google Sheets URL (edit, share, etc.) to a CSV export URL.
 * Supports gid parameter for specific sheets.
 */
function toCsvExportUrl(url: string): string {
  // Extract the spreadsheet ID
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) throw new Error('Invalid Google Sheets URL');
  const id = idMatch[1];

  // Extract gid if present
  const gidMatch = url.match(/[?&#]gid=(\d+)/);
  const gid = gidMatch ? `&gid=${gidMatch[1]}` : '';

  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid}`;
}

/**
 * Parse a CSV string, handling quoted fields.
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header row
  const headers = parseRow(lines[0]).map(h => h.trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
  );

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (cells.every(c => !c.trim())) continue; // skip blank rows
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? '').trim();
    });
    rows.push(row);
  }
  return rows;
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

/** Attempt to find a value by multiple possible column names */
function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return '';
}

function toNum(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/[%€$,]/g, '').trim());
  return isNaN(n) ? null : n;
}

function toStatus(s: string): string {
  const lower = s.toLowerCase();
  if (lower.includes('activ') || lower === 'active') return 'active';
  if (lower.includes('watch')) return 'watchlist';
  if (lower.includes('close') || lower.includes('cerr')) return 'closed';
  if (lower.includes('sold') || lower.includes('vend')) return 'sold';
  return 'active'; // default for portfolio rows
}

function toDate(s: string): string | null {
  if (!s) return null;
  // Try ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Try dd/mm/yyyy
  const parts = s.split(/[\/\-\.]/);
  if (parts.length === 3) {
    if (parts[2].length === 4) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2,'0')}-${parts[2].padStart(2,'0')}`;
  }
  return null;
}

export interface SyncResult {
  updated: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

export async function syncFromSheets(sheetUrl: string): Promise<SyncResult> {
  const csvUrl = toCsvExportUrl(sheetUrl);
  const result: SyncResult = { updated: 0, inserted: 0, skipped: 0, errors: [] };

  let csvText: string;
  try {
    const response = await axios.get<string>(csvUrl, {
      timeout: 15000,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    csvText = response.data;
  } catch (e: any) {
    throw new Error(`Failed to fetch Google Sheet: ${e.message}. Make sure the sheet is shared publicly ("Anyone with the link can view").`);
  }

  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    result.errors.push('No data rows found in spreadsheet');
    return result;
  }

  console.log('[sync] CSV headers:', Object.keys(rows[0]).join(', '));
  console.log('[sync] Row count:', rows.length);

  for (const row of rows) {
    // Try to find the company name
    const name = pick(row, 'name', 'nombre', 'empresa', 'company', 'nombre_empresa', 'company_name');
    if (!name) { result.skipped++; continue; }

    const ticker   = pick(row, 'ticker', 'symbol', 'simbolo');
    const sector   = pick(row, 'sector', 'industria', 'industry');
    const currency = pick(row, 'currency', 'moneda', 'divisa') || 'EUR';
    const status   = toStatus(pick(row, 'status', 'estado', 'estado_posicion', 'estado_empresa') || 'active');

    const entry_price   = toNum(pick(row, 'entry_price', 'precio_entrada', 'entry', 'coste'));
    const current_price = toNum(pick(row, 'current_price', 'precio_actual', 'precio', 'price', 'current'));
    const target_price  = toNum(pick(row, 'target_price', 'precio_objetivo', 'objetivo', 'target'));
    const position_size = toNum(pick(row, 'position_size', 'peso', 'weight', 'posicion', 'position', 'peso_'));
    const pe_ratio      = toNum(pick(row, 'pe_ratio', 'pe', 'p_e', 'ratio_pe', 'per'));
    const ev_ebitda     = toNum(pick(row, 'ev_ebitda', 'evebitda', 'ev', 'ev_ebitda_ratio'));
    const conviction_v  = toNum(pick(row, 'conviction', 'conviccion', 'stars', 'rating'));
    const conviction    = conviction_v != null ? Math.min(5, Math.max(1, Math.round(conviction_v))) : null;
    const entry_date    = toDate(pick(row, 'entry_date', 'fecha_entrada', 'fecha'));

    try {
      const existing = await pool.query(
        `SELECT id FROM companies WHERE LOWER(name) = LOWER($1) OR (ticker IS NOT NULL AND LOWER(ticker) = LOWER($2))`,
        [name, ticker || '__NOTICKER__']
      );

      if (existing.rows.length > 0) {
        // Update
        await pool.query(
          `UPDATE companies SET
            ticker=$1, sector=$2, currency=$3, status=$4,
            entry_price=COALESCE($5, entry_price),
            current_price=COALESCE($6, current_price),
            target_price=COALESCE($7, target_price),
            position_size=COALESCE($8, position_size),
            pe_ratio=COALESCE($9, pe_ratio),
            ev_ebitda=COALESCE($10, ev_ebitda),
            conviction=COALESCE($11, conviction),
            entry_date=COALESCE($12, entry_date),
            updated_at=NOW()
           WHERE id=$13`,
          [ticker||null, sector||null, currency, status,
           entry_price, current_price, target_price, position_size,
           pe_ratio, ev_ebitda, conviction, entry_date,
           existing.rows[0].id]
        );
        result.updated++;
      } else {
        // Insert
        await pool.query(
          `INSERT INTO companies
           (name, ticker, sector, currency, status, entry_price, current_price,
            target_price, position_size, pe_ratio, ev_ebitda, conviction, entry_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [name, ticker||null, sector||null, currency, status,
           entry_price, current_price, target_price, position_size,
           pe_ratio, ev_ebitda, conviction, entry_date]
        );
        result.inserted++;
      }
    } catch (e: any) {
      result.errors.push(`${name}: ${e.message}`);
    }
  }

  return result;
}
