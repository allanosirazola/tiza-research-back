import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { initDb } from './db';
import pool from './db';
import companiesRouter from './routes/companies';
import notionRouter from './routes/notion';
import earningsRouter from './routes/earnings';
import valuationRouter from './routes/valuation';
import marketRouter from './routes/market';
import alertsRouter from './routes/alerts';
import scriptsRouter from './routes/scripts';
import summariesRouter from './routes/summaries';
import eventsRouter from './routes/events';
import eventsGlobalRouter from './routes/eventsGlobal';
import transcriptsRouter from './routes/transcripts';
import portfolioRouter from './routes/portfolio';
import { seedPortfolioHistory } from './services/portfolioSeed';
import { refreshAllCompanyPrices } from './services/marketData';
import { refreshAllEvents } from './services/eventsFetcher';
import { snapshotMonthlyPortfolio } from './services/portfolioPerformance';
import { checkAndFireAlerts, generateWeeklySummary } from './services/alerts';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

// CORS: allow Vercel frontend + localhost dev
const allowedOrigins = [
  process.env.FRONTEND_URL,           // e.g. https://tiza-research.vercel.app
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean) as string[];

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (curl, mobile apps, same-origin)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json());

app.use('/api/companies', companiesRouter);
app.use('/api/notion', notionRouter);
app.use('/api/companies/:companyId/earnings', earningsRouter);
app.use('/api/companies/:companyId/valuation', valuationRouter);
app.use('/api/market', marketRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/scripts', scriptsRouter);
app.use('/api/summaries', summariesRouter);
app.use('/api/companies/:companyId/events', eventsRouter);
app.use('/api/events', eventsGlobalRouter);
app.use('/api/companies/:companyId/transcripts', transcriptsRouter);
app.use('/api/portfolio', portfolioRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Cron jobs ───────────────────────────────────────────────────────────────

// Every hour: refresh prices and check alerts
cron.schedule('0 * * * *', async () => {
  console.log('[cron] Refreshing prices...');
  try {
    await refreshAllCompanyPrices();
    await checkAndFireAlerts();
  } catch (err) {
    console.error('[cron] Price refresh/alert check failed:', err);
  }
});

// 1st of each month at 7am: Factset-style portfolio snapshot for the prior month.
cron.schedule('0 7 1 * *', async () => {
  console.log('[cron] Monthly portfolio snapshot...');
  try {
    const r = await snapshotMonthlyPortfolio();
    console.log(`[cron] Snapshot stored for ${r.period} (value=${r.value})`);
  } catch (err) {
    console.error('[cron] Monthly snapshot failed:', err);
  }
});

// Daily 6am: auto-fetch company events (IR pages + Yahoo earnings/dividends).
cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Refreshing company events...');
  try {
    const r = await refreshAllEvents();
    console.log(`[cron] Events refreshed: ${r.added} new across ${r.companies} companies`);
  } catch (err) {
    console.error('[cron] Events refresh failed:', err);
  }
});

// Every Saturday 8am: generate weekly summary
cron.schedule('0 8 * * 6', async () => {
  console.log('[cron] Generating weekly summary...');
  try {
    const summary = await generateWeeklySummary();
    const s = summary as any;
    const weekStart = s.weekStart as string;
    await pool.query(
      `INSERT INTO weekly_summaries (week_start, content)
       VALUES ($1, $2)
       ON CONFLICT (week_start) DO UPDATE SET content = $2`,
      [weekStart, JSON.stringify(summary)]
    );
    console.log('[cron] Weekly summary stored for week', weekStart);
  } catch (err) {
    console.error('[cron] Weekly summary generation failed:', err);
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await initDb();
  await seedPortfolioHistory();

  app.listen(PORT, () => {
    console.log(`Tiza Research backend running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
