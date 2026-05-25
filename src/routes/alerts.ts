import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db';
import { checkAndFireAlerts } from '../services/alerts';

const router = Router();

// GET /api/alerts - list all alerts (with company name/ticker)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        pa.*,
        c.name AS company_name,
        c.ticker AS company_ticker
      FROM price_alerts pa
      JOIN companies c ON c.id = pa.company_id
      ORDER BY pa.created_at DESC
    `);
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// POST /api/alerts - create alert
router.post('/', async (req: Request, res: Response) => {
  try {
    const { company_id, alert_type, threshold, label } = req.body;

    if (!company_id || !alert_type || threshold === undefined) {
      return res.status(400).json({ error: 'company_id, alert_type, and threshold are required' });
    }

    if (!['target_pct', 'price_above', 'price_below'].includes(alert_type)) {
      return res.status(400).json({ error: 'alert_type must be target_pct, price_above, or price_below' });
    }

    const companyResult = await pool.query('SELECT id FROM companies WHERE id = $1', [company_id]);
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO price_alerts (id, company_id, alert_type, threshold, label)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, company_id, alert_type, threshold, label ?? null]
    );

    const alertResult = await pool.query(`
      SELECT pa.*, c.name AS company_name, c.ticker AS company_ticker
      FROM price_alerts pa
      JOIN companies c ON c.id = pa.company_id
      WHERE pa.id = $1
    `, [id]);

    return res.status(201).json(alertResult.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create alert' });
  }
});

// PUT /api/alerts/:id - update alert
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existingResult = await pool.query('SELECT * FROM price_alerts WHERE id = $1', [req.params.id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const fields = ['alert_type', 'threshold', 'label', 'is_active'];
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
      `UPDATE price_alerts SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    const updated = await pool.query(`
      SELECT pa.*, c.name AS company_name, c.ticker AS company_ticker
      FROM price_alerts pa
      JOIN companies c ON c.id = pa.company_id
      WHERE pa.id = $1
    `, [req.params.id]);

    return res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update alert' });
  }
});

// DELETE /api/alerts/:id - delete alert
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('DELETE FROM price_alerts WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete alert' });
  }
});

// POST /api/alerts/check - manually trigger alert check
router.post('/check', async (_req: Request, res: Response) => {
  try {
    await checkAndFireAlerts();
    return res.json({ success: true, message: 'Alert check completed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to check alerts', details: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
