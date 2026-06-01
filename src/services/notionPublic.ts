import axios from 'axios';

/**
 * Scrape a PUBLIC notion.site page without an integration token.
 *
 * notion.site pages are JavaScript-rendered, so fetching the HTML yields an empty
 * shell (which is why a plain cheerio scrape only surfaces the link, not the
 * content). Instead we call the same public API the Notion web app uses,
 * `loadPageChunk`, which returns the page's block tree as JSON. We then flatten it
 * into collapsible sections keyed by the page's headings.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export interface ThesisBlock {
  id: string;
  type: string;            // notion block type (header, text, bulleted_list_item, …)
  text: string;            // plain text of the block
  level?: number;          // heading level (1–3) for header blocks
}

export interface ThesisSection {
  heading: string;         // section title (from a header block); "" for the intro
  level: number;           // 1–3
  blocks: ThesisBlock[];   // body blocks under this heading
}

export interface ScrapedThesis {
  url: string;
  pageId: string;
  title: string;
  sections: ThesisSection[];
}

/** Extract and dash-format the 32-char page id from any notion.site URL. */
export function extractNotionPageId(url: string): string | null {
  // The id is the last 32 hex chars in the path (optionally already dashed).
  const m = url.match(/([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!m) return null;
  const raw = m[0].replace(/-/g, '');
  if (raw.length !== 32) return null;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** Pull the plain text out of a Notion block's properties.title rich-text array. */
function blockText(value: any): string {
  const title = value?.properties?.title;
  if (!Array.isArray(title)) return '';
  return title.map((seg: any) => (Array.isArray(seg) ? seg[0] : '')).join('').trim();
}

const HEADING_TYPES: Record<string, number> = { header: 1, sub_header: 2, sub_sub_header: 3 };

/**
 * Call loadPageChunk repeatedly until the whole page is loaded, then assemble the
 * block list in document order and group it into sections by heading.
 */
export async function scrapeNotionThesis(pageUrl: string): Promise<ScrapedThesis> {
  const pageId = extractNotionPageId(pageUrl);
  if (!pageId) throw new Error('No se pudo extraer el ID de la página de Notion de la URL');

  const recordMap: Record<string, any> = {};
  let cursor: any = { stack: [] };
  let chunkNumber = 0;
  // Guard against infinite loops; a thesis page is realistically < 10 chunks.
  for (let i = 0; i < 12; i++) {
    const res = await axios.post(
      'https://www.notion.so/api/v3/loadPageChunk',
      {
        pageId,
        limit: 100,
        cursor,
        chunkNumber,
        verticalColumns: false,
      },
      {
        timeout: 20000,
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      }
    );
    const data = res.data as any;
    const block = data?.recordMap?.block ?? {};
    Object.assign(recordMap, block);
    const next = data?.cursor;
    if (next && Array.isArray(next.stack) && next.stack.length > 0) {
      cursor = next; chunkNumber++;
    } else {
      break;
    }
  }

  const root = recordMap[pageId]?.value;
  if (!root) throw new Error('La página de Notion no es pública o no se pudo leer');

  const title = blockText(root) || 'Tesis de Inversión';
  const order: string[] = root?.content ?? [];

  // Walk top-level content in order; nested children (list items) are appended too.
  const flat: ThesisBlock[] = [];
  const pushBlock = (id: string) => {
    const v = recordMap[id]?.value;
    if (!v) return;
    const type = v.type as string;
    const text = blockText(v);
    if (type === 'page') return; // skip subpage links here
    if (text || HEADING_TYPES[type]) {
      flat.push({ id, type, text, level: HEADING_TYPES[type] });
    }
    for (const childId of (v.content ?? [])) pushBlock(childId);
  };
  for (const id of order) pushBlock(id);

  // Group into collapsible sections by heading.
  const sections: ThesisSection[] = [];
  let current: ThesisSection = { heading: '', level: 1, blocks: [] };
  for (const b of flat) {
    if (b.level) {
      if (current.blocks.length || current.heading) sections.push(current);
      current = { heading: b.text, level: b.level, blocks: [] };
    } else {
      current.blocks.push(b);
    }
  }
  if (current.blocks.length || current.heading) sections.push(current);

  return { url: pageUrl, pageId, title, sections };
}
