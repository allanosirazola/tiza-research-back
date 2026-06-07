import { Router, Request, Response } from 'express';
import pool from '../db';
import { refreshAllEvents, refreshCompanyEvents } from '../services/eventsFetcher';

const router = Router();

// POST /api/events/refresh-all — auto-fetch events (IR + Yahoo) for every company.
router.post('/refresh-all', async (_req: Request, res: Response) => {
  try { return res.json(await refreshAllEvents()); }
  catch (err: any) { console.error('[events/refresh-all]', err?.message); return res.status(500).json({ error: err?.message ?? 'Failed' }); }
});

// POST /api/events/refresh/:companyId — refresh one company's events.
router.post('/refresh/:companyId', async (req: Request, res: Response) => {
  try { return res.json(await refreshCompanyEvents(req.params.companyId)); }
  catch (err: any) { console.error('[events/refresh]', err?.message); return res.status(500).json({ error: err?.message ?? 'Failed' }); }
});

// GET /api/events/upcoming?days=7
router.get('/upcoming', async (req: Request, res: Response) => {
  try {
    const days = parseInt(String(req.query.days || '7'));
    const result = await pool.query(
      `SELECT e.*, c.name as company_name, c.ticker as company_ticker, c.logo_url as company_logo
       FROM company_events e
       JOIN companies c ON c.id = e.company_id
       WHERE e.event_date >= CURRENT_DATE
         AND e.event_date <= CURRENT_DATE + INTERVAL '${days} days'
       ORDER BY e.event_date ASC
       LIMIT 50`,
      []
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch upcoming events' });
  }
});

// GET /api/events/calendar?month=YYYY-MM (all events in a month)
router.get('/calendar', async (req: Request, res: Response) => {
  try {
    const month = String(req.query.month || new Date().toISOString().slice(0, 7));
    const result = await pool.query(
      `SELECT e.*, c.name as company_name, c.ticker as company_ticker, c.logo_url as company_logo
       FROM company_events e
       JOIN companies c ON c.id = e.company_id
       WHERE TO_CHAR(e.event_date, 'YYYY-MM') = $1
       ORDER BY e.event_date ASC`,
      [month]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

export default router;
