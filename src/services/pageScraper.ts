import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Scrape a public web page (e.g. a published notion.site page) and return a
 * sanitized HTML fragment that can be rendered inside the app. This exists
 * because notion.site sends X-Frame-Options/CSP that forbid iframing, so we
 * fetch server-side and strip scripts/styles before sending to the client.
 */
export interface ScrapedPage {
  url: string;
  title: string;
  html: string;   // sanitized inner HTML
  text: string;   // plain-text fallback
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export async function scrapePage(pageUrl: string): Promise<ScrapedPage> {
  if (!/^https?:\/\//i.test(pageUrl)) {
    throw new Error('URL no válida');
  }

  const res = await axios.get<string>(pageUrl, {
    timeout: 20000,
    responseType: 'text',
    maxRedirects: 5,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    },
  });

  const $ = cheerio.load(res.data);

  // Drop anything non-content / unsafe.
  $('script, style, noscript, iframe, link, meta, svg, head').remove();
  // Remove event handlers and inline styles.
  $('*').each((_, el) => {
    const e = el as any;
    if (!e.attribs) return;
    for (const attr of Object.keys(e.attribs)) {
      if (/^on/i.test(attr) || attr === 'style' || attr === 'class' || attr === 'id') {
        $(el).removeAttr(attr);
      }
    }
  });

  const title = ($('title').first().text() || $('h1').first().text() || 'Tesis').trim();

  // Notion published pages render content inside .notion-app or main; fall back to body.
  let $root = $('div.notion-app').first();
  if ($root.length === 0) $root = $('main').first();
  if ($root.length === 0) $root = $('body').first();

  const html = ($root.html() || '').trim();
  const text = $root.text().replace(/\n{3,}/g, '\n\n').trim();

  return { url: pageUrl, title, html, text };
}
