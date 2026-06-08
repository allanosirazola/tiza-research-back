import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

// GET /api/settings/:key — read a setting value (e.g. a Notion parent URL).
router.get('/:key', async (req: Request, res: Response) => {
  try {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [req.params.key]);
    return res.json({ key: req.params.key, value: r.rows[0]?.value ?? null });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Failed to read setting' });
  }
});

// PUT /api/settings/:key  { value } — upsert a setting value.
router.put('/:key', async (req: Request, res: Response) => {
  try {
    const value = req.body?.value ?? null;
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [req.params.key, value]
    );
    return res.json({ key: req.params.key, value });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Failed to save setting' });
  }
});

export default router;
