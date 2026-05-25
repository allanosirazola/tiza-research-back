import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import companiesRouter from './routes/companies';
import notionRouter from './routes/notion';
import earningsRouter from './routes/earnings';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

app.use(cors());
app.use(express.json());

app.use('/api/companies', companiesRouter);
app.use('/api/notion', notionRouter);
app.use('/api/companies/:companyId/earnings', earningsRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

initDb();

app.listen(PORT, () => {
  console.log(`Tiza Research backend running on http://localhost:${PORT}`);
});

export default app;
