import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db';

const router = Router({ mergeParams: true });

// GET /api/companies/:companyId/valuation
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const cases = db.prepare('SELECT * FROM valuation_cases WHERE company_id = ? ORDER BY case_type').all(req.params.companyId);
    return res.json(cases);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch valuation cases' });
  }
});

// PUT /api/companies/:companyId/valuation/:caseType
router.put('/:caseType', (req, res) => {
  try {
    const db = getDb();
    const { caseType, companyId } = req.params;
    if (!['bull', 'base', 'bear'].includes(caseType)) {
      return res.status(400).json({ error: 'Invalid case type. Must be bull, base, or bear.' });
    }
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const existing = db.prepare('SELECT id FROM valuation_cases WHERE company_id = ? AND case_type = ?').get(companyId, caseType);

    const { target_price, entry_price, cagr, timeframe, weight, notes } = req.body;

    if (existing) {
      db.prepare(`
        UPDATE valuation_cases SET
          target_price = ?, entry_price = ?, cagr = ?, timeframe = ?, weight = ?, notes = ?, updated_at = datetime('now')
        WHERE company_id = ? AND case_type = ?
      `).run(
        target_price ?? null, entry_price ?? null, cagr ?? null,
        timeframe ?? 5, weight ?? 33.33, notes ?? null,
        companyId, caseType
      );
    } else {
      db.prepare(`
        INSERT INTO valuation_cases (id, company_id, case_type, target_price, entry_price, cagr, timeframe, weight, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), companyId, caseType,
        target_price ?? null, entry_price ?? null, cagr ?? null,
        timeframe ?? 5, weight ?? 33.33, notes ?? null
      );
    }

    const updated = db.prepare('SELECT * FROM valuation_cases WHERE company_id = ? AND case_type = ?').get(companyId, caseType);
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to upsert valuation case' });
  }
});

export default router;
