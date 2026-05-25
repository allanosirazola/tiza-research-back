import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import companiesRouter from './routes/companies';
import notionRouter from './routes/notion';
import earningsRouter from './routes/earnings';
import valuationRouter from './routes/valuation';

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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

initDb();

app.listen(PORT, () => {
  console.log(`Tiza Research backend running on http://localhost:${PORT}`);
});

export default app;
