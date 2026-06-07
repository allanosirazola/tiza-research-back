import axios from 'axios';
import * as cheerio from 'cheerio';
import pool from '../db';
import { resolveYahooSymbol } from './marketData';

/**
 * Auto-populate company_events from:
 *  1) The company's Investor Relations "events" page (primary — company-indicated).
 *  2) Yahoo Finance calendar (earnings + dividend dates) as a reliable complement.
 *
 * IR pages have no universal format, so discovery + parsing are best-effort: we try
 * common IR paths off the company website and look for date+title patterns. Yahoo is
 * the dependable baseline that always yields the next earnings/dividend dates.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export interface FetchedEvent {
  title: string;
  event_type: string;   // earnings | dividend | investor_day | conference | agm | other
  event_date: string;   // YYYY-MM-DD
  url?: string;
  source: 'yahoo' | 'ir';
}

/* ─── Yahoo earnings + dividend dates ──────────────────────────────────────── */

async function yahooCalendar(ticker: string): Promise<FetchedEvent[]> {
  const sym = resolveYahooSymbol(ticker);
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents`;
  try {
    const res = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const ce = (res.data as any)?.quoteSummary?.result?.[0]?.calendarEvents;
    if (!ce) return [];
    const out: FetchedEvent[] = [];
    const toDate = (v: any): string | null => {
      const raw = typeof v === 'object' ? v?.raw : v;
      if (!raw) return null;
      const d = new Date(raw * (String(raw).length <= 10 ? 1000 : 1));
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    };
    for (const d of (ce.earnings?.earningsDate ?? [])) {
      const date = toDate(d);
      if (date) out.push({ title: 'Resultados (estimado)', event_type: 'earnings', event_date: date, source: 'yahoo' });
    }
    const exDiv = toDate(ce.exDividendDate);
    if (exDiv) out.push({ title: 'Ex-dividendo', event_type: 'dividend', event_date: exDiv, source: 'yahoo' });
    const divDate = toDate(ce.dividendDate);
    if (divDate) out.push({ title: 'Pago de dividendo', event_type: 'dividend', event_date: divDate, source: 'yahoo' });
    return out;
  } catch { return []; }
}

/* ─── Investor Relations events page (discovery + generic scrape) ───────────── */

const IR_PATHS = [
  '/news-and-events/events', '/news-events/events', '/investors/events',
  '/investor-relations/events', '/investors/news-events/events', '/events-and-presentations',
  '/investor/events', '/investors/events-and-presentations', '/investors', '/investor-relations',
];

/** Try to find a working IR events page from the company website. */
export async function discoverIrEventsUrl(website?: string): Promise<string | null> {
  if (!website) return null;
  let origin: string;
  try { origin = new URL(website.startsWith('http') ? website : `https://${website}`).origin; }
  catch { return null; }
  for (const path of IR_PATHS) {
    const url = origin + path;
    try {
      const res = await axios.get<string>(url, { timeout: 8000, maxRedirects: 5, headers: { 'User-Agent': UA } });
      const html = String(res.data).toLowerCase();
      // Heuristic: page mentions events and has date-like content.
      if (/event|webcast|earnings call|investor|presentation/.test(html)) return res.request?.res?.responseUrl ?? url;
    } catch { /* try next */ }
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  ene: 1, abr: 4, ago: 8, dic: 12,
};

/** Parse a date from free text (e.g. "March 5, 2026", "5 Mar 2026", "2026-03-05"). */
function parseDate(text: string): string | null {
  const t = text.trim();
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/); // Month D, YYYY
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`; }
  m = t.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/); // D Month YYYY
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`; }
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); // D/M/YYYY (assume D/M)
  if (m) return `${m[3]}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  return null;
}

function classify(title: string): string {
  const t = title.toLowerCase();
  if (/earnings|results|quarter|q[1-4]\b|resultad|trimestr/.test(t)) return 'earnings';
  if (/dividend/.test(t)) return 'dividend';
  if (/investor day|capital markets|cmd/.test(t)) return 'investor_day';
  if (/agm|annual (general )?meeting|shareholder meeting|junta/.test(t)) return 'agm';
  if (/conference|conferen|webcast|fireside|summit/.test(t)) return 'conference';
  return 'other';
}

/** Generic scrape of an IR events page: find elements containing a date + a title. */
export async function scrapeIrEvents(url: string): Promise<FetchedEvent[]> {
  let html: string;
  try {
    const res = await axios.get<string>(url, { timeout: 12000, maxRedirects: 5, headers: { 'User-Agent': UA } });
    html = String(res.data);
  } catch { return []; }

  const out: FetchedEvent[] = [];
  const seen = new Set<string>();
  const add = (title: string, date: string | null, href?: string) => {
    title = title.replace(/\s+/g, ' ').trim();
    if (!date || !title || title.length < 4 || title.length > 160) return;
    const key = date + title.toLowerCase();
    if (seen.has(key)) return; seen.add(key);
    out.push({ title, event_type: classify(title), event_date: date, url: href, source: 'ir' });
  };

  // 1) JSON-LD "Event" objects (the cleanest when present).
  const $ = cheerio.load(html);
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).contents().text());
      const arr = Array.isArray(json) ? json : [json];
      for (const o of arr) {
        if (o && /event/i.test(o['@type'] ?? '') && o.startDate) {
          const d = parseDate(String(o.startDate)) ?? String(o.startDate).slice(0, 10);
          add(o.name ?? 'Evento', d, o.url);
        }
      }
    } catch { /* ignore */ }
  });

  // 2) Rows/cards: any element whose text has a parseable date; title = its strongest text.
  if (out.length === 0) {
    $('li, tr, article, .event, [class*="event"]').each((_, el) => {
      const $el = $(el);
      const txt = $el.text();
      const date = parseDate(txt);
      if (!date) return;
      const title = ($el.find('a, h1, h2, h3, h4, .title, [class*="title"]').first().text() || txt).trim();
      const href = $el.find('a').attr('href');
      const abs = href && !href.startsWith('http') ? new URL(href, url).href : href;
      add(title, date, abs ?? url);
    });
  }
  // Keep a sane number, most-recent-first by date.
  return out.sort((a, b) => a.event_date.localeCompare(b.event_date)).slice(0, 40);
}

/* ─── Orchestration ────────────────────────────────────────────────────────── */

export async function refreshCompanyEvents(companyId: string): Promise<{ added: number; ir: number; yahoo: number; irUrl: string | null }> {
  const { rows } = await pool.query(
    `SELECT id, ticker, ir_url, ir_events_url, logo_url FROM companies WHERE id = $1`, [companyId]);
  if (!rows.length) return { added: 0, ir: 0, yahoo: 0, irUrl: null };
  const company = rows[0];

  const events: FetchedEvent[] = [];

  // Yahoo (always, reliable).
  if (company.ticker) events.push(...await yahooCalendar(company.ticker));

  // IR page (primary): use stored url, else discover from website (Yahoo profile).
  let irUrl: string | null = company.ir_events_url || company.ir_url || null;
  if (!irUrl) {
    // Best-effort: derive website from Yahoo fundamentals if not stored.
    let website: string | undefined;
    try {
      const { fetchFundamentals } = await import('./marketData');
      website = (await fetchFundamentals(company.ticker).catch(() => null))?.website;
    } catch { /* ignore */ }
    irUrl = await discoverIrEventsUrl(website);
    if (irUrl) await pool.query('UPDATE companies SET ir_events_url = $1 WHERE id = $2', [irUrl, companyId]);
  }
  let irCount = 0;
  if (irUrl) {
    const irEvents = await scrapeIrEvents(irUrl);
    irCount = irEvents.length;
    events.push(...irEvents);
  }

  // Upsert (de-dup by company+source+date+title). Only keep future-ish events (last 90d+).
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  let added = 0;
  for (const e of events) {
    if (e.event_date < cutoff) continue;
    try {
      const r = await pool.query(
        `INSERT INTO company_events (company_id, title, event_type, event_date, url, source)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (company_id, source, event_date, title) WHERE source <> 'manual'
         DO UPDATE SET url = EXCLUDED.url, event_type = EXCLUDED.event_type, updated_at = NOW()`,
        [companyId, e.title, e.event_type, e.event_date, e.url ?? null, e.source]
      );
      added += r.rowCount ?? 0;
    } catch { /* ignore individual failures */ }
  }
  return { added, ir: irCount, yahoo: events.filter(e => e.source === 'yahoo').length, irUrl };
}

export async function refreshAllEvents(): Promise<{ companies: number; added: number }> {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE ticker IS NOT NULL AND ticker <> ''`);
  let added = 0;
  for (const c of rows) {
    try { added += (await refreshCompanyEvents(c.id)).added; } catch { /* continue */ }
  }
  return { companies: rows.length, added };
}
