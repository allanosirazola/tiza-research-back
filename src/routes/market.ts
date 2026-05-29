import { Router, Request, Response } from 'express';
import pool from '../db';
import {
  fetchQuote,
  fetchFundamentals,
  refreshAllCompanyPrices,
  calculateCAGR,
  calculateUpside,
} from '../services/marketData';

const router = Router();

// GET /api/market/quote/:ticker - real-time quote
router.get('/quote/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const quote = await fetchQuote(ticker.toUpperCase());
    return res.json(quote);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch quote', details: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/market/fundamentals/:ticker
router.get('/fundamentals/:ticker', async (req: Request, res: Response) => {
  try {
    const { ticker } = req.params;
    const data = await fetchFundamentals(ticker.toUpperCase());
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch fundamentals', details: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/market/refresh-all - update all companies
router.post('/refresh-all', async (_req: Request, res: Response) => {
  try {
    const result = await refreshAllCompanyPrices();
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to refresh prices', details: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/companies/:id/performance - CAGR, total return, upside
router.get('/companies/:id/performance', async (req: Request, res: Response) => {
  try {
    const companyResult = await pool.query(
      'SELECT id, name, ticker, entry_price, entry_date, current_price, target_price FROM companies WHERE id = $1',
      [req.params.id]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    const company = companyResult.rows[0];

    const entryPrice = company.entry_price ? parseFloat(company.entry_price) : null;
    const currentPrice = company.current_price ? parseFloat(company.current_price) : null;
    const targetPrice = company.target_price ? parseFloat(company.target_price) : null;
    const entryDate = company.entry_date ? String(company.entry_date).slice(0, 10) : null;

    let cagr: number | null = null;
    let totalReturn: number | null = null;
    let upside: number | null = null;

    if (entryPrice && currentPrice) {
      totalReturn = ((currentPrice - entryPrice) / entryPrice) * 100;
      if (entryDate) {
        cagr = calculateCAGR(entryPrice, currentPrice, entryDate);
      }
    }

    if (currentPrice && targetPrice) {
      upside = calculateUpside(currentPrice, targetPrice);
    }

    // Price history (last 30 snapshots)
    const snapshotsResult = await pool.query(
      `SELECT price, market_cap, snapshot_date FROM price_snapshots
       WHERE company_id = $1
       ORDER BY snapshot_date DESC
       LIMIT 30`,
      [company.id]
    );

    return res.json({
      company: {
        id: company.id,
        name: company.name,
        ticker: company.ticker,
      },
      entryPrice,
      currentPrice,
      targetPrice,
      entryDate,
      cagr,
      totalReturn,
      upside,
      priceHistory: snapshotsResult.rows,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch performance data' });
  }
});

export default router;
