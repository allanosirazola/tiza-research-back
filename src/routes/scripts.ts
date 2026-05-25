import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db';
import { runScriptById } from '../services/scriptRunner';

const router = Router();

// GET /api/scripts - list all scripts
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_scripts ORDER BY name ASC'
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch scripts' });
  }
});

// POST /api/scripts - create script
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, code } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const id = uuidv4();
    await pool.query(
      `INSERT INTO user_scripts (id, name, description, code)
       VALUES ($1, $2, $3, $4)`,
      [id, name, description ?? null, code ?? '']
    );

    const script = await pool.query('SELECT * FROM user_scripts WHERE id = $1', [id]);
    return res.status(201).json(script.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create script' });
  }
});

// PUT /api/scripts/:id - update script
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const existingResult = await pool.query('SELECT * FROM user_scripts WHERE id = $1', [req.params.id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Script not found' });
    }

    const fields = ['name', 'description', 'code'];
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
      `UPDATE user_scripts SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    const updated = await pool.query('SELECT * FROM user_scripts WHERE id = $1', [req.params.id]);
    return res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update script' });
  }
});

// DELETE /api/scripts/:id - delete script
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'DELETE FROM user_scripts WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Script not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete script' });
  }
});

// POST /api/scripts/:id/run - execute script
router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const result = await runScriptById(req.params.id);
    return res.json(result);
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Script not found') {
      return res.status(404).json({ error: msg });
    }
    return res.status(500).json({ error: 'Failed to run script', details: msg });
  }
});

export default router;
