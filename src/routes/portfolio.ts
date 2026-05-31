import { Router, Request, Response } from 'express';
import axios from 'axios';
import { getPortfolioSummary, getPeriodReturns } from '../services/portfolioPerformance';
import { syncFromSheets, fetchSheetTabs } from '../services/sheetsSync';
import pool from '../db';

const DEFAULT_SHEETS_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS5d6l6QsJmv_uJyzyKjt_h5ekWayV45ARu5wIrv-eBto2d_Gv0T3W02JSKfsdQa6SZSwKajb0ELA8l/pubhtml';

const router = Router();

// GET /api/portfolio/summary
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const summary = await getPortfolioSummary();
    // Also get portfolio totals from history
    const histResult = await pool.query(
      `SELECT * FROM portfolio_performance_history
       WHERE period_type = 'annual'
       ORDER BY period_end DESC NULLS LAST LIMIT 1`
    );
    const latestHistory = histResult.rows[0] ?? null;
    return res.json({ ...summary, latest_history: latestHistory });
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

// GET /api/portfolio/history
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM portfolio_performance_history ORDER BY period_end DESC NULLS LAST`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch portfolio history' });
  }
});

// POST /api/portfolio/history
router.post('/history', async (req: Request, res: Response) => {
  try {
    const {
      period, period_type, period_start, period_end,
      portfolio_return, sp500_return, msci_world_return,
      portfolio_value_end, money_invested, win_lose_usd, notes
    } = req.body;
    if (!period || !period_type) {
      return res.status(400).json({ error: 'period and period_type are required' });
    }
    const result = await pool.query(
      `INSERT INTO portfolio_performance_history
       (period, period_type, period_start, period_end, portfolio_return, sp500_return,
        msci_world_return, portfolio_value_end, money_invested, win_lose_usd, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (period, period_type) DO UPDATE SET
         portfolio_return = EXCLUDED.portfolio_return,
         sp500_return = EXCLUDED.sp500_return,
         msci_world_return = EXCLUDED.msci_world_return,
         portfolio_value_end = EXCLUDED.portfolio_value_end,
         money_invested = EXCLUDED.money_invested,
         win_lose_usd = EXCLUDED.win_lose_usd,
         notes = EXCLUDED.notes
       RETURNING *`,
      [period, period_type, period_start || null, period_end || null,
       portfolio_return || null, sp500_return || null, msci_world_return || null,
       portfolio_value_end || null, money_invested || null, win_lose_usd || null,
       notes || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to upsert history record' });
  }
});

// POST /api/portfolio/seed-companies
// Seeds companies from the configured Google Sheet (same as sync-sheets but uses default URL)
router.post('/seed-companies', async (_req: Request, res: Response) => {
  try {
    const result = await syncFromSheets(DEFAULT_SHEETS_URL);
    return res.json({
      seeded: result.inserted,
      skipped: result.skipped,
      updated: result.updated,
      errors: result.errors,
      detail: result,
    });
  } catch (err: any) {
    console.error('[seed-companies]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to seed companies from Google Sheets' });
  }
});

// GET /api/portfolio/sheet-tabs?url=PUBHTML  — list tabs for the portfolio sheet
router.get('/sheet-tabs', async (req: Request, res: Response) => {
  try {
    const url = (req.query.url as string) || DEFAULT_SHEETS_URL;
    const tabs = await fetchSheetTabs(url);
    return res.json({ tabs });
  } catch (err: any) {
    console.error('[sheet-tabs]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to list sheet tabs', tabs: [] });
  }
});

// GET /api/portfolio/diagnose?url=PUBHTML[&gid=GID]
// Reports exactly what the SERVER sees: whether Google is reachable from the host,
// the detected tabs, the CSV headers and first rows for the chosen tab. This is the
// ground truth for debugging why the portfolio doesn't match the 2026 sheet.
router.get('/diagnose', async (req: Request, res: Response) => {
  const url = (req.query.url as string) || DEFAULT_SHEETS_URL;
  const out: any = { url, steps: {} };

  // 1) Can the host reach the pubhtml at all? Also capture raw HTML snippets around
  // every gid= occurrence so we can see Google's exact tab markup.
  try {
    const r = await axios.get<string>(url, {
      timeout: 20000, responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
      validateStatus: () => true,
    });
    const html = r.data || '';
    const snippets: string[] = [];
    const re = /gid=\d+/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(html)) !== null && snippets.length < 6) {
      snippets.push(html.slice(Math.max(0, mm.index - 60), mm.index + 80).replace(/\s+/g, ' '));
    }
    // Also look for the tab-bar container markup.
    const barIdx = html.search(/sheet-button|switcherItem|gridTab|menucontainer/i);
    out.steps.pubhtml = {
      status: r.status,
      bytes: html.length,
      gidSnippets: snippets,
      barSnippet: barIdx >= 0 ? html.slice(barIdx, barIdx + 400).replace(/\s+/g, ' ') : null,
    };
  } catch (e: any) {
    out.steps.pubhtml = { error: e?.message, code: e?.code };
  }

  // 2) Tab detection
  try {
    out.steps.tabs = await fetchSheetTabs(url);
  } catch (e: any) {
    out.steps.tabs = { error: e?.message };
  }

  // 3) CSV for chosen/auto gid
  try {
    const tabs = Array.isArray(out.steps.tabs) ? out.steps.tabs : [];
    const year = String(new Date().getFullYear());
    const gid = (req.query.gid as string)
      || tabs.find((t: any) => t.name?.trim() === year)?.gid
      || tabs.find((t: any) => (t.name || '').includes(year))?.gid;
    const pubKeyM = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)/);
    const pubKey = pubKeyM ? pubKeyM[1] : '';
    const csvUrl = gid
      ? `https://docs.google.com/spreadsheets/d/e/${pubKey}/pub?gid=${gid}&single=true&output=csv`
      : `https://docs.google.com/spreadsheets/d/e/${pubKey}/pub?output=csv`;
    const r = await axios.get<string>(csvUrl, {
      timeout: 20000, responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
      validateStatus: () => true,
    });
    const lines = (r.data || '').split(/\r?\n/).slice(0, 6);
    out.steps.csv = { gidUsed: gid ?? '(default/first)', status: r.status, firstLines: lines };
  } catch (e: any) {
    out.steps.csv = { error: e?.message };
  }

  return res.json(out);
});

// POST /api/portfolio/sync-sheets
// Body: { url?, tab?, gid? } — uses DEFAULT_SHEETS_URL when url is omitted.
// `gid` selects the tab explicitly (manual selector); `tab` matches by name;
// otherwise it defaults to the current year (e.g. "2026").
router.post('/sync-sheets', async (req: Request, res: Response) => {
  try {
    const url: string = req.body?.url ?? DEFAULT_SHEETS_URL;
    const tab: string | undefined = req.body?.tab;
    const gid: string | undefined = req.body?.gid;
    // P&L cell defaults to "P26" (2026 tab's total Win/Loss incl. dividends).
    const pnlCell: string | undefined = req.body?.pnlCell ?? 'P26';
    const result = await syncFromSheets(url, { tab, gid, pnlCell });
    return res.json({
      updated: result.updated + result.inserted,
      errors: result.errors,
      detail: result,
    });
  } catch (err: any) {
    console.error('[sync-sheets]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to sync from Google Sheets' });
  }
});

// GET /api/portfolio/model-sheets?url=PUBHTML_URL
// Returns sheet names and GIDs parsed from pubhtml
router.get('/model-sheets', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url || !url.includes('/pubhtml')) {
      return res.status(400).json({ error: 'Valid pubhtml URL required' });
    }
    // Reuse the shared tab parser (handles Google's real href="...?gid=N&single=true").
    const sheets = await fetchSheetTabs(url);
    const pubKeyMatch = url.match(/\/d\/e\/([a-zA-Z0-9_-]+)/);
    const pubKey = pubKeyMatch ? pubKeyMatch[1] : '';
    return res.json({ sheets, pubKey });
  } catch (err: any) {
    console.error('[model-sheets]', err);
    return res.status(500).json({ error: 'Failed to parse sheet tabs', details: err.message });
  }
});

// GET /api/portfolio/model-csv?pubkey=KEY&gid=GID
// Returns parsed CSV rows for a specific sheet
router.get('/model-csv', async (req: Request, res: Response) => {
  try {
    const { pubkey, gid } = req.query as { pubkey: string; gid: string };
    if (!pubkey || !gid) return res.status(400).json({ error: 'pubkey and gid required' });
    const csvUrl = `https://docs.google.com/spreadsheets/d/e/${pubkey}/pub?gid=${gid}&output=csv&single=true`;
    const response = await axios.get<string>(csvUrl, {
      timeout: 15000,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TizaResearch/1.0)' },
    });
    const text = response.data as string;
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const parseRow = (line: string): string[] => {
      const cells: string[] = [];
      let inQ = false, cur = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = !inQ;
        } else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      cells.push(cur.trim());
      return cells;
    };
    const allRows = lines.map(parseRow);

    // Detect the real header row. Financial models often have title/spacer rows on top,
    // so rows[0] is rarely the header. Prefer the first row containing >= 2 year-like
    // tokens (2023, 2025e, FY24...); otherwise fall back to the row with the most
    // non-empty cells within the first 15 rows.
    const yearRe = /^(fy\s?)?('?\d{2}|(19|20)\d{2})e?$/i;
    let headerIdx = -1;
    for (let i = 0; i < Math.min(allRows.length, 15); i++) {
      const yearCount = allRows[i].filter(c => yearRe.test(c.trim())).length;
      if (yearCount >= 2) { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      let bestFilled = 1;
      for (let i = 0; i < Math.min(allRows.length, 15); i++) {
        const filled = allRows[i].filter(c => c.trim()).length;
        if (filled > bestFilled) { bestFilled = filled; headerIdx = i; }
      }
      if (headerIdx === -1) headerIdx = 0;
    }

    // Trim trailing fully-empty columns so the table isn't padded with blanks.
    const headerRaw = allRows[headerIdx] ?? [];
    let lastCol = headerRaw.length - 1;
    while (lastCol > 0 && !headerRaw[lastCol]?.trim()) lastCol--;
    const headers = headerRaw.slice(0, lastCol + 1);

    const dataRows = allRows
      .slice(headerIdx + 1)
      .map(r => r.slice(0, lastCol + 1))
      .filter(r => r.some(c => c.trim()));

    return res.json({ headers, rows: dataRows, headerRow: headerIdx });
  } catch (err: any) {
    console.error('[model-csv]', err);
    return res.status(500).json({ error: 'Failed to fetch CSV data', details: err.message });
  }
});

export default router;
