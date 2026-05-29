import axios from 'axios';
import pool from '../db';

/**
 * Converts any Google Sheets URL to a CSV export URL.
 * Supports:
 *  - Published pubhtml URLs: https://docs.google.com/spreadsheets/d/e/PUBKEY/pubhtml
 *  - Regular edit/share URLs: https://docs.google.com/spreadsheets/d/ID/edit
 */
function toCsvExportUrl(url: string): string {
  // Published URL format: /d/e/PUBKEY/pubhtml
  if (url.includes('/d/e/')) {
    const match = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('Invalid published Google Sheets URL');
    const pubKey = match[1];
    return `https://docs.google.com/spreadsheets/d/e/${pubKey}/pub?output=csv`;
  }

  // Regular edit URL format: /spreadsheets/d/ID
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) throw new Error('Invalid Google Sheets URL');
  const id = idMatch[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
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

    const ticker     = pick(row, 'ticker', 'symbol', 'simbolo');
    const sector     = pick(row, 'sector', 'industria', 'industry');
    const entry_price = toNum(pick(row, 'entry_price', 'precio_entrada', 'entry', 'coste'));

    try {
      const existing = await pool.query(
        `SELECT id FROM companies WHERE LOWER(name) = LOWER($1) OR (ticker IS NOT NULL AND LOWER(ticker) = LOWER($2))`,
        [name, ticker || '__NOTICKER__']
      );

      if (existing.rows.length > 0) {
        // Update only ticker, entry_price, sector — do not overwrite other fields
        await pool.query(
          `UPDATE companies SET
            ticker = COALESCE($1, ticker),
            entry_price = COALESCE($2, entry_price),
            sector = COALESCE($3, sector),
            updated_at = NOW()
           WHERE id = $4`,
          [ticker || null, entry_price, sector || null, existing.rows[0].id]
        );
        result.updated++;
      } else {
        // Insert new company with minimal fields; default status and currency
        await pool.query(
          `INSERT INTO companies (name, ticker, sector, entry_price, status, currency)
           VALUES ($1, $2, $3, $4, 'watchlist', 'EUR')`,
          [name, ticker || null, sector || null, entry_price]
        );
        result.inserted++;
      }
    } catch (e: any) {
      result.errors.push(`${name}: ${e.message}`);
    }
  }

  return result;
}
