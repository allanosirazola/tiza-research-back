#!/usr/bin/env tsx
/**
 * Standalone DB setup script.
 * Usage:
 *   npx tsx scripts/setup-db.ts
 *   npx tsx scripts/setup-db.ts --path /custom/path/tiza.db
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ─── Parse --path argument ──────────────────────────────────────────────────
function getDbPath(): string {
  const args = process.argv.slice(2);
  const pathIdx = args.indexOf('--path');
  if (pathIdx !== -1 && args[pathIdx + 1]) {
    return args[pathIdx + 1];
  }
  return path.resolve(process.cwd(), 'data', 'tiza.db');
}

const DB_PATH = getDbPath();
const DB_DIR = path.dirname(DB_PATH);

// ─── Ensure directory exists ────────────────────────────────────────────────
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  console.log(`Created directory: ${DB_DIR}`);
}

console.log(`Setting up database at: ${DB_PATH}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── companies ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ticker TEXT,
    sector TEXT,
    market_cap REAL,
    currency TEXT DEFAULT 'EUR',
    current_price REAL,
    target_price REAL,
    pe_ratio REAL,
    ev_ebitda REAL,
    conviction INTEGER CHECK(conviction BETWEEN 1 AND 5),
    position_size REAL,
    status TEXT DEFAULT 'watchlist' CHECK(status IN ('active', 'watchlist', 'closed', 'sold')),
    notion_page_id TEXT,
    notion_page_url TEXT,
    logo_url TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
console.log('  companies table: OK');

// ─── earnings_calls ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS earnings_calls (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    period TEXT NOT NULL,
    call_date TEXT,
    notion_page_id TEXT,
    notion_page_url TEXT,
    revenue_growth REAL,
    eps REAL,
    guidance TEXT,
    notes TEXT,
    conviction_change INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
  );
`);
console.log('  earnings_calls table: OK');

// ─── notion_cache ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS notion_cache (
    page_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    last_fetched TEXT DEFAULT (datetime('now'))
  );
`);
console.log('  notion_cache table: OK');

// ─── valuation_cases ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS valuation_cases (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    case_type TEXT NOT NULL CHECK(case_type IN ('bull', 'base', 'bear')),
    target_price REAL,
    entry_price REAL,
    cagr REAL,
    timeframe INTEGER DEFAULT 5,
    weight REAL DEFAULT 33.33,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    UNIQUE(company_id, case_type)
  );
`);
console.log('  valuation_cases table: OK');

db.close();
console.log('\nDatabase setup complete.');
