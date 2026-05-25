import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router({ mergeParams: true });

// GET /api/companies/:companyId/transcripts
router.get('/', async (req: Request<{ companyId: string }>, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, company_id, title, transcript_type, period, transcript_date,
              LEFT(content, 300) as content_preview,
              LENGTH(content) as content_length,
              created_at, updated_at
       FROM transcripts
       WHERE company_id = $1
       ORDER BY transcript_date DESC NULLS LAST, created_at DESC`,
      [req.params.companyId]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch transcripts' });
  }
});

// GET /api/companies/:companyId/transcripts/:id (full content)
router.get('/:id', async (req: Request<{ companyId: string; id: string }>, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transcripts WHERE id=$1 AND company_id=$2',
      [req.params.id, req.params.companyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Transcript not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

// POST /api/companies/:companyId/transcripts
router.post('/', async (req: Request<{ companyId: string }>, res: Response) => {
  try {
    const { title, transcript_type, content, period, transcript_date } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const result = await pool.query(
      `INSERT INTO transcripts (company_id, title, transcript_type, content, period, transcript_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, company_id, title, transcript_type, period, transcript_date,
                 LEFT(content, 300) as content_preview, LENGTH(content) as content_length, created_at, updated_at`,
      [req.params.companyId, title, transcript_type || 'earnings_call', content || null, period || null, transcript_date || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create transcript' });
  }
});

// PUT /api/companies/:companyId/transcripts/:id
router.put('/:id', async (req: Request<{ companyId: string; id: string }>, res: Response) => {
  try {
    const { title, transcript_type, content, period, transcript_date } = req.body;
    const result = await pool.query(
      `UPDATE transcripts
       SET title=$1, transcript_type=$2, content=$3, period=$4, transcript_date=$5, updated_at=NOW()
       WHERE id=$6 AND company_id=$7
       RETURNING id, company_id, title, transcript_type, period, transcript_date,
                 LEFT(content, 300) as content_preview, LENGTH(content) as content_length, created_at, updated_at`,
      [title, transcript_type, content || null, period || null, transcript_date || null, req.params.id, req.params.companyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Transcript not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update transcript' });
  }
});

// DELETE /api/companies/:companyId/transcripts/:id
router.delete('/:id', async (req: Request<{ companyId: string; id: string }>, res: Response) => {
  try {
    await pool.query('DELETE FROM transcripts WHERE id=$1 AND company_id=$2', [req.params.id, req.params.companyId]);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete transcript' });
  }
});

// GET /api/companies/:companyId/transcripts/:id/full (alias for full content)
// already handled by GET /:id above

export default router;
