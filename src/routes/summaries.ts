import { Router, Request, Response } from 'express';
import pool from '../db';
import { generateWeeklySummary } from '../services/alerts';
import { sendWeeklySummaryEmail } from '../services/email';

const router = Router();

// GET /api/summaries - list weekly summaries (newest first)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM weekly_summaries ORDER BY week_start DESC'
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch summaries' });
  }
});

// GET /api/summaries/:id - get a single summary
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM weekly_summaries WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Summary not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// POST /api/summaries/generate - manually generate current week's summary
router.post('/generate', async (req: Request, res: Response) => {
  try {
    const summary = await generateWeeklySummary();
    const s = summary as any;
    const weekStart = s.weekStart as string;

    await pool.query(
      `INSERT INTO weekly_summaries (week_start, content)
       VALUES ($1, $2)
       ON CONFLICT (week_start) DO UPDATE SET content = EXCLUDED.content`,
      [weekStart, JSON.stringify(summary)]
    );

    // Optionally send email if requested
    const sendEmail = req.body?.send_email === true;
    if (sendEmail) {
      try {
        await sendWeeklySummaryEmail(summary);
        await pool.query(
          'UPDATE weekly_summaries SET email_sent = TRUE WHERE week_start = $1',
          [weekStart]
        );
      } catch (emailErr) {
        console.error('Failed to send summary email:', emailErr);
      }
    }

    const stored = await pool.query(
      'SELECT * FROM weekly_summaries WHERE week_start = $1',
      [weekStart]
    );

    return res.json(stored.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to generate summary', details: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
