import { Router, Request, Response } from 'express';
import { getPortfolioSummary, getPeriodReturns } from '../services/portfolioPerformance';
import { syncFromSheets } from '../services/sheetsSync';
import pool from '../db';

const DEFAULT_SHEETS_URL = 'https://docs.google.com/spreadsheets/d/11vNXKvruW8N8zSXtkJlUkr7772fUPN-6OcANfC0qNx4';

const router = Router();

// GET /api/portfolio/summary
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const summary = await getPortfolioSummary();
    // Also get portfolio totals from history
    const histResult = await pool.query(
      `SELECT * FROM portfolio_performance_history
       WHERE period_type = 'annual'
       ORDER BY period_end DESC NULLS LAST LIMIT 1`
    );
    const latestHistory = histResult.rows[0] ?? null;
    return res.json({ ...summary, latest_history: latestHistory });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to get portfolio summary' });
  }
});

// GET /api/portfolio/performance?type=monthly|quarterly|all
router.get('/performance', async (req: Request, res: Response) => {
  try {
    const typeFilter = req.query.type as string | undefined;
    const all = await getPeriodReturns();
    const filtered = typeFilter && typeFilter !== 'all'
      ? all.filter(p => p.period_type === typeFilter)
      : all;
    return res.json(filtered);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to calculate portfolio performance' });
  }
});

// GET /api/portfolio/history
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM portfolio_performance_history ORDER BY period_end DESC NULLS LAST`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch portfolio history' });
  }
});

// POST /api/portfolio/history
router.post('/history', async (req: Request, res: Response) => {
  try {
    const {
      period, period_type, period_start, period_end,
      portfolio_return, sp500_return, msci_world_return,
      portfolio_value_end, money_invested, win_lose_usd, notes
    } = req.body;
    if (!period || !period_type) {
      return res.status(400).json({ error: 'period and period_type are required' });
    }
    const result = await pool.query(
      `INSERT INTO portfolio_performance_history
       (period, period_type, period_start, period_end, portfolio_return, sp500_return,
        msci_world_return, portfolio_value_end, money_invested, win_lose_usd, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (period, period_type) DO UPDATE SET
         portfolio_return = EXCLUDED.portfolio_return,
         sp500_return = EXCLUDED.sp500_return,
         msci_world_return = EXCLUDED.msci_world_return,
         portfolio_value_end = EXCLUDED.portfolio_value_end,
         money_invested = EXCLUDED.money_invested,
         win_lose_usd = EXCLUDED.win_lose_usd,
         notes = EXCLUDED.notes
       RETURNING *`,
      [period, period_type, period_start || null, period_end || null,
       portfolio_return || null, sp500_return || null, msci_world_return || null,
       portfolio_value_end || null, money_invested || null, win_lose_usd || null,
       notes || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to upsert history record' });
  }
});

// POST /api/portfolio/seed-companies
// Seeds companies from the configured Google Sheet (same as sync-sheets but uses default URL)
router.post('/seed-companies', async (_req: Request, res: Response) => {
  try {
    const result = await syncFromSheets(DEFAULT_SHEETS_URL);
    return res.json({
      seeded: result.inserted,
      skipped: result.skipped,
      updated: result.updated,
      errors: result.errors,
    });
  } catch (err: any) {
    console.error('[seed-companies]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to seed companies from Google Sheets' });
  }
});

// POST /api/portfolio/sync-sheets
// Body: { url?: string }  — uses DEFAULT_SHEETS_URL when url is omitted
router.post('/sync-sheets', async (req: Request, res: Response) => {
  try {
    const url: string = req.body?.url ?? DEFAULT_SHEETS_URL;
    const result = await syncFromSheets(url);
    return res.json({
      updated: result.updated + result.inserted,
      errors: result.errors,
      detail: result,
    });
  } catch (err: any) {
    console.error('[sync-sheets]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to sync from Google Sheets' });
  }
});

export default router;
