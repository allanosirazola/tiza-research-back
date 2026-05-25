#!/usr/bin/env tsx
/**
 * PostgreSQL DB setup / migration script.
 * Usage:
 *   npx tsx scripts/setup-db.ts
 *   npx tsx scripts/setup-db.ts --url postgresql://user:password@localhost:5432/tiza
 *
 * Falls back to DATABASE_URL env var if --url is not provided.
 */

import 'dotenv/config';
import { Pool } from 'pg';

// ─── Parse --url argument ────────────────────────────────────────────────────
function getConnectionString(): string {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    return args[urlIdx + 1];
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: No database URL provided. Use --url flag or set DATABASE_URL env var.');
    process.exit(1);
  }
  return dbUrl;
}

const connectionString = getConnectionString();
const isRailwayOrProd =
  connectionString.includes('railway') || process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString,
  ssl: isRailwayOrProd ? { rejectUnauthorized: false } : false,
});

async function setup(): Promise<void> {
  console.log('Setting up PostgreSQL database...');

  // ─── companies ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      ticker TEXT,
      sector TEXT,
      market_cap NUMERIC,
      currency TEXT DEFAULT 'EUR',
      current_price NUMERIC,
      target_price NUMERIC,
      entry_price NUMERIC,
      entry_date DATE,
      pe_ratio NUMERIC,
      ev_ebitda NUMERIC,
      conviction INTEGER CHECK(conviction BETWEEN 1 AND 5),
      position_size NUMERIC,
      status TEXT DEFAULT 'watchlist' CHECK(status IN ('active', 'watchlist', 'closed', 'sold')),
      notion_page_id TEXT,
      notion_page_url TEXT,
      logo_url TEXT,
      notes TEXT,
      last_price_update TIMESTAMPTZ,
      price_change_1d NUMERIC,
      week_52_high NUMERIC,
      week_52_low NUMERIC,
      nav_url TEXT,
      last_nav NUMERIC,
      last_nav_date DATE,
      nav_discount NUMERIC,
      alert_threshold NUMERIC DEFAULT 20,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  companies table: OK');

  // ─── earnings_calls ─────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS earnings_calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      call_date DATE,
      notion_page_id TEXT,
      notion_page_url TEXT,
      revenue_growth NUMERIC,
      eps NUMERIC,
      guidance TEXT,
      notes TEXT,
      conviction_change INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  earnings_calls table: OK');

  // ─── valuation_cases ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS valuation_cases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      case_type TEXT NOT NULL CHECK(case_type IN ('bull', 'base', 'bear')),
      target_price NUMERIC,
      entry_price NUMERIC,
      cagr NUMERIC,
      timeframe INTEGER DEFAULT 5,
      weight NUMERIC DEFAULT 33.33,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, case_type)
    );
  `);
  console.log('  valuation_cases table: OK');

  // ─── notion_cache ───────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notion_cache (
      page_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      last_fetched TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  notion_cache table: OK');

  // ─── price_alerts ───────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      alert_type TEXT NOT NULL CHECK(alert_type IN ('target_pct', 'price_above', 'price_below')),
      threshold NUMERIC NOT NULL,
      label TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      triggered_at TIMESTAMPTZ,
      last_notified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  price_alerts table: OK');

  // ─── weekly_summaries ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_summaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      week_start DATE NOT NULL UNIQUE,
      content JSONB NOT NULL,
      email_sent BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  weekly_summaries table: OK');

  // ─── user_scripts ────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_scripts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      code TEXT NOT NULL DEFAULT '',
      last_run TIMESTAMPTZ,
      last_output TEXT,
      last_error TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('  user_scripts table: OK');

  // ─── price_snapshots ─────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      price NUMERIC NOT NULL,
      market_cap NUMERIC,
      source TEXT DEFAULT 'yahoo',
      snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, snapshot_date)
    );
  `);
  console.log('  price_snapshots table: OK');

  await pool.end();
  console.log('\nDatabase setup complete.');
}

setup().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
