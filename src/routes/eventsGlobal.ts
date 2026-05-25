import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

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
