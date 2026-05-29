import pool from '../db';

const ANNUAL_SEED = [
  { year: 2020, period: "2020", period_start: "2020-01-01", period_end: "2020-12-31",
    portfolio_return: 37.00, sp500_return: 18.40, msci_world_return: 15.9,
    portfolio_value_end: 3010.21, money_invested: 1910.65, win_lose_usd: 1099.56 },
  { year: 2021, period: "2021", period_start: "2021-01-01", period_end: "2021-12-31",
    portfolio_return: -44.54, sp500_return: 26.61, msci_world_return: 21.8,
    portfolio_value_end: 4049.83, money_invested: 2380.45, win_lose_usd: -1340.83,
    notes: "Incluye pérdidas por apalancamiento/margen" },
  { year: 2022, period: "2022", period_start: "2022-01-01", period_end: "2022-12-31",
    portfolio_return: -35.22, sp500_return: -19.95, msci_world_return: -18.1,
    portfolio_value_end: 12000.79, money_invested: 9398.75, win_lose_usd: -1426.43 },
  { year: 2023, period: "2023", period_start: "2023-01-01", period_end: "2023-12-31",
    portfolio_return: 59.17, sp500_return: 24.73, msci_world_return: 23.8,
    portfolio_value_end: 25446.19, money_invested: 6434, win_lose_usd: 8017.64 },
  { year: 2024, period: "2024", period_start: "2024-01-01", period_end: "2024-12-31",
    portfolio_return: 19.08, sp500_return: 23.31, msci_world_return: 18.7,
    portfolio_value_end: 42487.84, money_invested: 12400, win_lose_usd: 5529.51 },
  { year: 2025, period: "2025", period_start: "2025-01-01", period_end: "2025-12-31",
    portfolio_return: 48.86, sp500_return: 27.06, msci_world_return: 15.0,
    portfolio_value_end: 103022.76, money_invested: 40250, win_lose_usd: 24117.27 },
  { year: 2026, period: "2026 YTD", period_start: "2026-01-01", period_end: "2026-12-31",
    portfolio_return: 0.92, sp500_return: 10.49, msci_world_return: null,
    portfolio_value_end: 123556.47, money_invested: 23283, win_lose_usd: 345.02,
    notes: "Parcial (YTD)" },
];

export async function seedPortfolioHistory(): Promise<void> {
  try {
    const currentYear = new Date().getFullYear();
    for (const row of ANNUAL_SEED) {
      if (row.year === currentYear) {
        // Always upsert the current year (YTD) record so it reflects latest values
        await pool.query(
          `INSERT INTO portfolio_performance_history
           (period, period_type, period_start, period_end, portfolio_return, sp500_return,
            msci_world_return, portfolio_value_end, money_invested, win_lose_usd, notes)
           VALUES ($1, 'annual', $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (period, period_type) DO UPDATE SET
             portfolio_return = EXCLUDED.portfolio_return,
             sp500_return = EXCLUDED.sp500_return,
             msci_world_return = EXCLUDED.msci_world_return,
             portfolio_value_end = EXCLUDED.portfolio_value_end,
             money_invested = EXCLUDED.money_invested,
             win_lose_usd = EXCLUDED.win_lose_usd,
             notes = EXCLUDED.notes`,
          [
            row.period, row.period_start, row.period_end,
            row.portfolio_return, row.sp500_return, row.msci_world_return ?? null,
            row.portfolio_value_end, row.money_invested, row.win_lose_usd,
            (row as any).notes ?? null
          ]
        );
      } else {
        // For historical years, only insert if missing — never overwrite
        await pool.query(
          `INSERT INTO portfolio_performance_history
           (period, period_type, period_start, period_end, portfolio_return, sp500_return,
            msci_world_return, portfolio_value_end, money_invested, win_lose_usd, notes)
           VALUES ($1, 'annual', $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (period, period_type) DO NOTHING`,
          [
            row.period, row.period_start, row.period_end,
            row.portfolio_return, row.sp500_return, row.msci_world_return ?? null,
            row.portfolio_value_end, row.money_invested, row.win_lose_usd,
            (row as any).notes ?? null
          ]
        );
      }
    }
    console.log('[seed] Portfolio history seeded:', ANNUAL_SEED.length, 'annual records');
  } catch (err) {
    console.error('[seed] Portfolio history seed failed:', err);
  }
}
