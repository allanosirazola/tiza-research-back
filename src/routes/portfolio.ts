import { Router, Request, Response } from 'express';
import { getPortfolioSummary, getPeriodReturns } from '../services/portfolioPerformance';

const router = Router();

// GET /api/portfolio/summary
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const summary = await getPortfolioSummary();
    return res.json(summary);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to get portfolio summary' });
  }
});

// GET /api/portfolio/performance?type=monthly|quarterly|all
router.get('/performance', async (req: Request, res: Response) => {
  try {
    const typeFilter = req.query.type as string | undefined;
    const all = await getPeriodReturns();
    const filtered = typeFilter && typeFilter !== 'all'
      ? all.filter(p => p.period_type === typeFilter)
      : all;
    return res.json(filtered);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to calculate portfolio performance' });
  }
});

export default router;
