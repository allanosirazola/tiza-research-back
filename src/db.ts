import { Pool, types } from 'pg';

// PostgreSQL returns NUMERIC/DECIMAL (OID 1700) and BIGINT (OID 20) as strings by
// default. The frontend treats these columns as JS numbers (e.g. price.toFixed()),
// so strings cause "x.toFixed is not a function" crashes. Parse them to numbers at
// the driver level so every query returns real numbers. NUMERIC values in this app
// (prices, market caps, ratios) are well within IEEE-754 safe range.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

export async function initDb(): Promise<void> {
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

    CREATE TABLE IF NOT EXISTS notion_cache (
      page_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      last_fetched TIMESTAMPTZ DEFAULT NOW()
    );

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

    CREATE TABLE IF NOT EXISTS weekly_summaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      week_start DATE NOT NULL UNIQUE,
      content JSONB NOT NULL,
      email_sent BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

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

    ALTER TABLE companies ADD COLUMN IF NOT EXISTS ir_url TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS model_url TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS subsector TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS model_kpis JSONB;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'pendiente';

    CREATE TABLE IF NOT EXISTS company_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'other' CHECK (event_type IN ('earnings','press_release','investor_day','agm','roadshow','dividend','conference','other')),
      event_date DATE NOT NULL,
      description TEXT,
      url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_company_events_company_id ON company_events(company_id);
    CREATE INDEX IF NOT EXISTS idx_company_events_date ON company_events(event_date);

    CREATE TABLE IF NOT EXISTS transcripts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      transcript_type TEXT NOT NULL DEFAULT 'earnings_call' CHECK (transcript_type IN ('earnings_call','press_release','investor_day','annual_report','conference','other')),
      content TEXT,
      period TEXT,
      transcript_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transcripts_company_id ON transcripts(company_id);

    CREATE TABLE IF NOT EXISTS portfolio_performance_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      period TEXT NOT NULL,
      period_type TEXT NOT NULL DEFAULT 'annual',
      period_start DATE,
      period_end DATE,
      portfolio_return NUMERIC,
      sp500_return NUMERIC,
      msci_world_return NUMERIC,
      portfolio_value_end NUMERIC,
      money_invested NUMERIC,
      win_lose_usd NUMERIC,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(period, period_type)
    );
  `);
  console.log('PostgreSQL database initialized');
}

export function getDb() {
  return pool;
}

export default pool;
