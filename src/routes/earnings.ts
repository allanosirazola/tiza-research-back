import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import { fetchPageBlocksCached, invalidateCache } from '../notionClient';

const router = Router({ mergeParams: true });

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.companyId);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    
    const earnings = db.prepare(
      'SELECT * FROM earnings_calls WHERE company_id = ? ORDER BY call_date DESC, period DESC'
    ).all(req.params.companyId);
    
    return res.json(earnings);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch earnings calls' });
  }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.companyId);
    if (!company) {
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
    db.prepare(`
      INSERT INTO earnings_calls (
        id, company_id, period, call_date, notion_page_id, notion_page_url,
        revenue_growth, eps, guidance, notes, conviction_change
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, req.params.companyId, period, call_date ?? null, notion_page_id ?? null,
      notion_page_url ?? null, revenue_growth ?? null, eps ?? null,
      guidance ?? null, notes ?? null, conviction_change ?? null
    );
    
    const earnings = db.prepare('SELECT * FROM earnings_calls WHERE id = ?').get(id);
    return res.status(201).json(earnings);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create earnings call' });
  }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare(
      'SELECT * FROM earnings_calls WHERE id = ? AND company_id = ?'
    ).get(req.params.id, req.params.companyId);
    
    if (!existing) {
      return res.status(404).json({ error: 'Earnings call not found' });
    }
    
    const fields = [
      'period', 'call_date', 'notion_page_id', 'notion_page_url',
      'revenue_growth', 'eps', 'guidance', 'notes', 'conviction_change'
    ];
    
    const updates: string[] = [];
    const values: unknown[] = [];
    
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }
    
    if (updates.length === 0) {
      return res.json(existing);
    }
    
    values.push(req.params.id);
    db.prepare(`UPDATE earnings_calls SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    
    const updated = db.prepare('SELECT * FROM earnings_calls WHERE id = ?').get(req.params.id);
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update earnings call' });
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = db.prepare(
      'DELETE FROM earnings_calls WHERE id = ? AND company_id = ?'
    ).run(req.params.id, req.params.companyId);
    
    if (result.changes === 0) {
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
    const db = getDb();
    const earnings = db.prepare(
      'SELECT * FROM earnings_calls WHERE id = ? AND company_id = ?'
    ).get(req.params.id, req.params.companyId) as any;
    
    if (!earnings) {
      return res.status(404).json({ error: 'Earnings call not found' });
    }
    
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
