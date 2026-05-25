import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db';
import { fetchPageBlocksCached, invalidateCache } from '../notionClient';

const router = Router({ mergeParams: true });

router.get('/', async (req: Request, res: Response) => {
  try {
    const companyResult = await pool.query('SELECT id FROM companies WHERE id = $1', [req.params.companyId]);
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const earnings = await pool.query(
      'SELECT * FROM earnings_calls WHERE company_id = $1 ORDER BY call_date DESC NULLS LAST, period DESC',
      [req.params.companyId]
    );

    return res.json(earnings.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch earnings calls' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const companyResult = await pool.query('SELECT id FROM companies WHERE id = $1', [req.params.companyId]);
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const {
      period,
      call_date,
      notion_page_id,
      notion_page_url,
      revenue_growth,
      eps,
      guidance,
      notes,
      conviction_change,
    } = req.body;

    if (!period) {
      return res.status(400).json({ error: 'Period is required' });
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO earnings_calls (
        id, company_id, period, call_date, notion_page_id, notion_page_url,
        revenue_growth, eps, guidance, notes, conviction_change
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id, req.params.companyId, period, call_date ?? null, notion_page_id ?? null,
        notion_page_url ?? null, revenue_growth ?? null, eps ?? null,
        guidance ?? null, notes ?? null, conviction_change ?? null,
      ]
    );

    const earnings = await pool.query('SELECT * FROM earnings_calls WHERE id = $1', [id]);
    return res.status(201).json(earnings.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create earnings call' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existingResult = await pool.query(
      'SELECT * FROM earnings_calls WHERE id = $1 AND company_id = $2',
      [req.params.id, req.params.companyId]
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Earnings call not found' });
    }

    const fields = [
      'period', 'call_date', 'notion_page_id', 'notion_page_url',
      'revenue_growth', 'eps', 'guidance', 'notes', 'conviction_change',
    ];

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${paramIdx}`);
        values.push(req.body[field]);
        paramIdx++;
      }
    }

    if (updates.length === 0) {
      return res.json(existingResult.rows[0]);
    }

    values.push(req.params.id);
    await pool.query(
      `UPDATE earnings_calls SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    const updated = await pool.query('SELECT * FROM earnings_calls WHERE id = $1', [req.params.id]);
    return res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update earnings call' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'DELETE FROM earnings_calls WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, req.params.companyId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Earnings call not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete earnings call' });
  }
});

router.post('/:id/sync-notion', async (req: Request, res: Response) => {
  try {
    const earningsResult = await pool.query(
      'SELECT * FROM earnings_calls WHERE id = $1 AND company_id = $2',
      [req.params.id, req.params.companyId]
    );

    if (earningsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Earnings call not found' });
    }

    const earnings = earningsResult.rows[0];

    if (!earnings.notion_page_id) {
      return res.status(400).json({ error: 'No Notion page linked to this earnings call' });
    }

    await invalidateCache(earnings.notion_page_id);
    const blocks = await fetchPageBlocksCached(earnings.notion_page_id);

    return res.json({ success: true, blocksCount: blocks.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to sync earnings call from Notion' });
  }
});

export default router;
