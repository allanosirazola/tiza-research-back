import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db';

const router = Router({ mergeParams: true });

// GET /api/companies/:companyId/valuation
router.get('/', async (req: Request<{ companyId: string }>, res: Response) => {
  try {
    const companyResult = await pool.query('SELECT id FROM companies WHERE id = $1', [req.params.companyId]);
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const cases = await pool.query(
      'SELECT * FROM valuation_cases WHERE company_id = $1 ORDER BY case_type',
      [req.params.companyId]
    );

    return res.json(cases.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch valuation cases' });
  }
});

// PUT /api/companies/:companyId/valuation/:caseType
router.put('/:caseType', async (req: Request<{ companyId: string; caseType: string }>, res: Response) => {
  try {
    const { caseType, companyId } = req.params;
    if (!['bull', 'base', 'bear'].includes(caseType)) {
      return res.status(400).json({ error: 'Invalid case type. Must be bull, base, or bear.' });
    }

    const companyResult = await pool.query('SELECT id FROM companies WHERE id = $1', [companyId]);
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const { target_price, entry_price, cagr, timeframe, weight, notes } = req.body;

    const id = uuidv4();
    await pool.query(
      `INSERT INTO valuation_cases (id, company_id, case_type, target_price, entry_price, cagr, timeframe, weight, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (company_id, case_type) DO UPDATE SET
         target_price = EXCLUDED.target_price,
         entry_price = EXCLUDED.entry_price,
         cagr = EXCLUDED.cagr,
         timeframe = EXCLUDED.timeframe,
         weight = EXCLUDED.weight,
         notes = EXCLUDED.notes,
         updated_at = NOW()`,
      [
        id, companyId, caseType,
        target_price ?? null, entry_price ?? null, cagr ?? null,
        timeframe ?? 5, weight ?? 33.33, notes ?? null,
      ]
    );

    const updated = await pool.query(
      'SELECT * FROM valuation_cases WHERE company_id = $1 AND case_type = $2',
      [companyId, caseType]
    );
    return res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to upsert valuation case' });
  }
});

export default router;
