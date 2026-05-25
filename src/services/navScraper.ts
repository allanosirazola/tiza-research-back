import axios from 'axios';
import * as cheerio from 'cheerio';
import pool from '../db';

export interface NavResult {
  nav: number;
  date: string;
  source: string;
  discount?: number; // vs market price
}

// Common patterns for extracting NAV values from HTML
const NAV_PATTERNS = [
  /NAV[:\s]+[\$€£]?\s*([\d,]+\.?\d*)/i,
  /Net Asset Value[:\s]+[\$€£]?\s*([\d,]+\.?\d*)/i,
  /[\$€£]\s*([\d,]+\.?\d*)\s*(?:per share|NAV)/i,
];

// Try axios+cheerio first (faster, no browser needed)
export async function scrapeNavHttp(url: string, selector?: string): Promise<NavResult | null> {
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TizaBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const $ = cheerio.load(response.data as string);

    // If a CSS selector is provided, try it first
    if (selector) {
      const el = $(selector);
      if (el.length > 0) {
        const text = el.first().text().trim();
        const numStr = text.replace(/[,$€£\s]/g, '');
        const nav = parseFloat(numStr);
        if (!isNaN(nav) && nav > 0) {
          return {
            nav,
            date: new Date().toISOString().slice(0, 10),
            source: url,
          };
        }
      }
    }

    // Try regex patterns on page text
    const bodyText = $('body').text();
    for (const pattern of NAV_PATTERNS) {
      const match = bodyText.match(pattern);
      if (match) {
        const nav = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(nav) && nav > 0) {
          return {
            nav,
            date: new Date().toISOString().slice(0, 10),
            source: url,
          };
        }
      }
    }

    // Page may be JS-rendered — return null to indicate failure
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[navScraper] HTTP fetch failed for ${url}: ${msg}`);
    return null;
  }
}

// For PSH specifically — known scraper
// PSH NAV page: https://pershingsquareholdings.com/performance/net-asset-value-and-returns/
export async function scrapePSHNav(): Promise<NavResult> {
  const url = 'https://pershingsquareholdings.com/performance/net-asset-value-and-returns/';

  // Try simple HTTP scrape first
  const result = await scrapeNavHttp(url);
  if (result) {
    return result;
  }

  // PSH page is likely JS-rendered; inform caller
  // A puppeteer addon or a Python-based selenium script would be needed for this
  throw new Error(
    'PSH NAV page requires JavaScript rendering. ' +
    'HTTP scraping returned no data. ' +
    'Consider adding a puppeteer-based scraper or a Python/Playwright addon for this page.'
  );
}

export async function updateCompanyNav(companyId: string): Promise<NavResult | null> {
  const companyResult = await pool.query(
    'SELECT id, nav_url, current_price FROM companies WHERE id = $1',
    [companyId]
  );

  if (companyResult.rows.length === 0) {
    throw new Error('Company not found');
  }

  const company = companyResult.rows[0];
  if (!company.nav_url) {
    return null;
  }

  const navResult = await scrapeNavHttp(company.nav_url);
  if (!navResult) {
    return null;
  }

  // Calculate discount vs market price if available
  if (company.current_price && navResult.nav > 0) {
    navResult.discount = ((parseFloat(company.current_price) - navResult.nav) / navResult.nav) * 100;
  }

  await pool.query(
    `UPDATE companies SET
      last_nav = $1,
      last_nav_date = $2,
      nav_discount = $3,
      updated_at = NOW()
    WHERE id = $4`,
    [navResult.nav, navResult.date, navResult.discount ?? null, companyId]
  );

  return navResult;
}
