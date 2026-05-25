import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';
import {
  extractEarningsCallsFromPage,
  fetchPageBlocksCached,
  getPageTitle,
  extractPageIdFromUrl,
  invalidateCache,
} from '../notionClient';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const companies = db.prepare('SELECT * FROM companies ORDER BY name ASC').all();
    res.json(companies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const {
      name,
      ticker,
      sector,
      market_cap,
      currency,
      current_price,
      target_price,
      pe_ratio,
      ev_ebitda,
      conviction,
      position_size,
      status,
      notion_page_id,
      notion_page_url,
      logo_url,
      notes,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO companies (
        id, name, ticker, sector, market_cap, currency, current_price, target_price,
        pe_ratio, ev_ebitda, conviction, position_size, status, notion_page_id,
        notion_page_url, logo_url, notes
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      id, name, ticker ?? null, sector ?? null, market_cap ?? null,
      currency ?? 'EUR', current_price ?? null, target_price ?? null,
      pe_ratio ?? null, ev_ebitda ?? null, conviction ?? null,
      position_size ?? null, status ?? 'watchlist', notion_page_id ?? null,
      notion_page_url ?? null, logo_url ?? null, notes ?? null
    );

    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    return res.status(201).json(company);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create company' });
  }
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }
    return res.json(company);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch company' });
  }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const fields = [
      'name', 'ticker', 'sector', 'market_cap', 'currency', 'current_price',
      'target_price', 'pe_ratio', 'ev_ebitda', 'conviction', 'position_size',
      'status', 'notion_page_id', 'notion_page_url', 'logo_url', 'notes'
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

    updates.push(`updated_at = datetime('now')`);
    values.push(req.params.id);

    db.prepare(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update company' });
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete company' });
  }
});

router.post('/:id/sync-notion', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id) as any;
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    if (!company.notion_page_id) {
      return res.status(400).json({ error: 'No Notion page linked to this company' });
    }

    await invalidateCache(company.notion_page_id);
    const blocks = await fetchPageBlocksCached(company.notion_page_id);

    const earningsLinks = await extractEarningsCallsFromPage(company.notion_page_id);

    for (const link of earningsLinks) {
      const existingEarnings = db.prepare(
        'SELECT id FROM earnings_calls WHERE notion_page_id = ?'
      ).get(link.pageId);

      if (!existingEarnings) {
        db.prepare(`
          INSERT INTO earnings_calls (id, company_id, period, notion_page_id, notion_page_url)
          VALUES (?, ?, ?, ?, ?)
        `).run(uuidv4(), company.id, link.title, link.pageId, link.pageUrl);
      }
    }

    db.prepare(`UPDATE companies SET updated_at = datetime('now') WHERE id = ?`).run(company.id);

    return res.json({
      success: true,
      blocksCount: blocks.length,
      earningsFound: earningsLinks.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to sync from Notion' });
  }
});

export default router;
