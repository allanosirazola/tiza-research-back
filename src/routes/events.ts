import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router({ mergeParams: true });

// GET /api/companies/:companyId/events
router.get('/', async (req: Request<{ companyId: string }>, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM company_events WHERE company_id = $1 ORDER BY event_date ASC`,
      [req.params.companyId]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET /api/events/upcoming?days=7  (global - for dashboard widget)
// This needs a separate router registered at /api/events

// POST /api/companies/:companyId/events
router.post('/', async (req: Request<{ companyId: string }>, res: Response) => {
  try {
    const { title, event_type, event_date, description, url } = req.body;
    if (!title || !event_date) {
      return res.status(400).json({ error: 'title and event_date are required' });
    }
    const result = await pool.query(
      `INSERT INTO company_events (company_id, title, event_type, event_date, description, url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.companyId, title, event_type || 'other', event_date, description || null, url || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create event' });
  }
});

// PUT /api/companies/:companyId/events/:id
router.put('/:id', async (req: Request<{ companyId: string; id: string }>, res: Response) => {
  try {
    const { title, event_type, event_date, description, url } = req.body;
    const result = await pool.query(
      `UPDATE company_events
       SET title=$1, event_type=$2, event_date=$3, description=$4, url=$5, updated_at=NOW()
       WHERE id=$6 AND company_id=$7
       RETURNING *`,
      [title, event_type, event_date, description || null, url || null, req.params.id, req.params.companyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE /api/companies/:companyId/events/:id
router.delete('/:id', async (req: Request<{ companyId: string; id: string }>, res: Response) => {
  try {
    await pool.query(
      'DELETE FROM company_events WHERE id=$1 AND company_id=$2',
      [req.params.id, req.params.companyId]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete event' });
  }
});

export default router;
