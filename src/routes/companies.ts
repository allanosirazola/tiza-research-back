import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db';
import {
  extractEarningsCallsFromPage,
  fetchPageBlocksCached,
  invalidateCache,
} from '../notionClient';
import { parseModelFromUrl } from '../services/modelParser';
import { fetchModelCases, resolveCasesGid } from '../services/modelCases';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM companies ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      name,
      ticker,
      sector,
      market_cap,
      currency,
      current_price,
      target_price,
      entry_price,
      entry_date,
      pe_ratio,
      ev_ebitda,
      conviction,
      position_size,
      status,
      notion_page_id,
      notion_page_url,
      logo_url,
      notes,
      nav_url,
      ir_url,
      alert_threshold,
      model_url,
      estado,
      subsector,
      thesis_url,
      thesis_content,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO companies (
        id, name, ticker, sector, market_cap, currency, current_price, target_price,
        entry_price, entry_date, pe_ratio, ev_ebitda, conviction, position_size, status,
        notion_page_id, notion_page_url, logo_url, notes, nav_url, ir_url, alert_threshold, model_url, estado,
        subsector, thesis_url, thesis_content
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
        $25, $26, $27
      )`,
      [
        id, name, ticker ?? null, sector ?? null, market_cap ?? null,
        currency ?? 'EUR', current_price ?? null, target_price ?? null,
        entry_price ?? null, entry_date ?? null, pe_ratio ?? null, ev_ebitda ?? null,
        conviction ?? null, position_size ?? null, status ?? 'watchlist',
        notion_page_id ?? null, notion_page_url ?? null, logo_url ?? null,
        notes ?? null, nav_url ?? null, ir_url ?? null, alert_threshold ?? 20, model_url ?? null,
        estado ?? null,
        subsector ?? null, thesis_url ?? null, thesis_content ?? null,
      ]
    );

    const company = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
    return res.status(201).json(company.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create company' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch company' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existingResult = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const fields = [
      'name', 'ticker', 'sector', 'market_cap', 'currency', 'current_price',
      'target_price', 'entry_price', 'entry_date', 'pe_ratio', 'ev_ebitda',
      'conviction', 'position_size', 'status', 'notion_page_id', 'notion_page_url',
      'logo_url', 'notes', 'nav_url', 'ir_url', 'alert_threshold', 'model_url', 'estado', 'subsector',
      'thesis_url', 'thesis_content',
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

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);

    await pool.query(
      `UPDATE companies SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    const updated = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    return res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update company' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('DELETE FROM companies WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount === 0) {
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
    const companyResult = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    const company = companyResult.rows[0];

    if (!company.notion_page_id) {
      return res.status(400).json({ error: 'No Notion page linked to this company' });
    }

    await invalidateCache(company.notion_page_id);
    const blocks = await fetchPageBlocksCached(company.notion_page_id);

    const earningsLinks = await extractEarningsCallsFromPage(company.notion_page_id);

    for (const link of earningsLinks) {
      const existingEarnings = await pool.query(
        'SELECT id FROM earnings_calls WHERE notion_page_id = $1',
        [link.pageId]
      );

      if (existingEarnings.rows.length === 0) {
        await pool.query(
          `INSERT INTO earnings_calls (id, company_id, period, notion_page_id, notion_page_url)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), company.id, link.title, link.pageId, link.pageUrl]
        );
      }
    }

    await pool.query('UPDATE companies SET updated_at = NOW() WHERE id = $1', [company.id]);

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

// POST /api/companies/:id/parse-model
// Body: { url?: string }  — uses company's model_url if no url in body
router.post('/:id/parse-model', async (req: Request, res: Response) => {
  try {
    const company = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (company.rows.length === 0) return res.status(404).json({ error: 'Company not found' });

    const modelUrl = req.body?.url ?? company.rows[0].model_url;
    if (!modelUrl) return res.status(400).json({ error: 'No model URL provided' });

    // Save the URL if it was provided in body
    if (req.body?.url) {
      await pool.query('UPDATE companies SET model_url = $1, updated_at = NOW() WHERE id = $2', [req.body.url, req.params.id]);
    }

    const kpis = await parseModelFromUrl(modelUrl);
    await pool.query('UPDATE companies SET model_kpis = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(kpis), req.params.id]);

    return res.json({ success: true, kpis });
  } catch (err: any) {
    console.error('[parse-model]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to parse model' });
  }
});

// GET /api/companies/:id/model-cases?returnCell=H10&cagrCell=H11&gid=...
// Returns the "valoración por casos" grid + the user-chosen return/CAGR cells.
router.get('/:id/model-cases', async (req: Request, res: Response) => {
  try {
    const c = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = c.rows[0];
    if (!company.model_url) return res.status(400).json({ error: 'No model URL set for this company' });

    const returnCell = (req.query.returnCell as string) || company.model_return_cell || 'H10';
    const cagrCell   = (req.query.cagrCell as string)   || company.model_cagr_cell   || 'H11';
    const gid        = (req.query.gid as string)        || company.model_cases_gid   || undefined;

    const data = await fetchModelCases(company.model_url, { gid, returnCell, cagrCell });
    return res.json(data);
  } catch (err: any) {
    console.error('[model-cases]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to fetch model cases' });
  }
});

// POST /api/companies/:id/model-cases
// Body: { returnCell?, cagrCell?, gid? } — persists chosen cells and the computed
// return/CAGR so the portfolio can show them (N/A when no model is set).
router.post('/:id/model-cases', async (req: Request, res: Response) => {
  try {
    const c = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = c.rows[0];
    if (!company.model_url) return res.status(400).json({ error: 'No model URL set for this company' });

    const returnCell = (req.body?.returnCell as string) || company.model_return_cell || 'H10';
    const cagrCell   = (req.body?.cagrCell as string)   || company.model_cagr_cell   || 'H11';
    let gid          = (req.body?.gid as string)        || company.model_cases_gid   || undefined;
    if (!gid) gid = await resolveCasesGid(company.model_url);

    const data = await fetchModelCases(company.model_url, { gid, returnCell, cagrCell });

    await pool.query(
      `UPDATE companies SET
        model_return = $1, model_cagr = $2,
        model_return_cell = $3, model_cagr_cell = $4, model_cases_gid = $5,
        updated_at = NOW()
       WHERE id = $6`,
      [data.returnValue, data.cagrValue, returnCell, cagrCell, data.gid, req.params.id]
    );

    return res.json({ success: true, ...data });
  } catch (err: any) {
    console.error('[model-cases:save]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to save model cases' });
  }
});

export default router;
