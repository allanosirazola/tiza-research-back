import { Client, isFullBlock } from '@notionhq/client';
import { BlockObjectResponse, RichTextItemResponse } from '@notionhq/client/build/src/api-endpoints';
import pool from './db';

let notionClient: Client | null = null;

function getNotionClient(): Client {
  if (!notionClient) {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      throw new Error('NOTION_TOKEN environment variable is not set');
    }
    notionClient = new Client({ auth: token });
  }
  return notionClient;
}

export interface RichTextItem {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
  link?: string;
}

export interface NotionBlock {
  id: string;
  type: string;
  content?: string;
  richContent?: RichTextItem[];
  children?: NotionBlock[];
  url?: string;
  caption?: string;
  checked?: boolean;
  title?: string;
  pageUrl?: string;
  rows?: string[][];
  icon?: string;
  language?: string;
}

function convertRichText(richText: RichTextItemResponse[]): RichTextItem[] {
  return richText.map((item) => {
    const result: RichTextItem = { text: item.plain_text };
    if (item.annotations) {
      if (item.annotations.bold) result.bold = true;
      if (item.annotations.italic) result.italic = true;
      if (item.annotations.strikethrough) result.strikethrough = true;
      if (item.annotations.underline) result.underline = true;
      if (item.annotations.code) result.code = true;
      if (item.annotations.color && item.annotations.color !== 'default') {
        result.color = item.annotations.color;
      }
    }
    if (item.type === 'text' && item.text?.link?.url) {
      result.link = item.text.link.url;
    }
    if (item.type === 'mention' && item.mention?.type === 'link_preview') {
      result.link = (item.mention as any).link_preview?.url;
    }
    return result;
  });
}

function richTextToString(richText: RichTextItemResponse[]): string {
  return richText.map((item) => item.plain_text).join('');
}

async function fetchBlockChildren(blockId: string, depth: number): Promise<NotionBlock[]> {
  if (depth <= 0) return [];

  const notion = getNotionClient();
  const blocks: BlockObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    let response;
    try {
      response = await notion.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      });
    } catch (err: any) {
      // A nested block (synced block, unshared sub-page/database, etc.) may not be
      // reachable by the integration. Skip it instead of failing the whole page.
      if (err?.code === 'object_not_found' || err?.code === 'validation_error') {
        console.warn(`[notion] skipping inaccessible block ${blockId}: ${err.code}`);
        break;
      }
      throw err;
    }

    for (const block of response.results) {
      if (isFullBlock(block)) {
        blocks.push(block);
      }
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  const result: NotionBlock[] = [];

  for (const block of blocks) {
    const converted = await convertBlock(block, depth);
    if (converted) {
      result.push(converted);
    }
  }

  return result;
}

async function convertBlock(block: BlockObjectResponse, depth: number): Promise<NotionBlock | null> {
  const base: NotionBlock = { id: block.id, type: block.type };

  switch (block.type) {
    case 'paragraph': {
      const rich = block.paragraph.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      if (block.has_children && depth > 1) {
        base.children = await fetchBlockChildren(block.id, depth - 1);
      }
      break;
    }
    case 'heading_1': {
      const rich = block.heading_1.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      // Toggle headings keep their section content as children.
      if (block.has_children && depth > 1) base.children = await fetchBlockChildren(block.id, depth - 1);
      break;
    }
    case 'heading_2': {
      const rich = block.heading_2.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      if (block.has_children && depth > 1) base.children = await fetchBlockChildren(block.id, depth - 1);
      break;
    }
    case 'heading_3': {
      const rich = block.heading_3.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      if (block.has_children && depth > 1) base.children = await fetchBlockChildren(block.id, depth - 1);
      break;
    }
    case 'toggle': {
      const rich = block.toggle.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      if (block.has_children && depth > 1) {
        base.children = await fetchBlockChildren(block.id, depth - 1);
      }
      break;
    }
    case 'bulleted_list_item': {
      const rich = block.bulleted_list_item.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      if (block.has_children && depth > 1) {
        base.children = await fetchBlockChildren(block.id, depth - 1);
      }
      break;
    }
    case 'numbered_list_item': {
      const rich = block.numbered_list_item.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      if (block.has_children && depth > 1) {
        base.children = await fetchBlockChildren(block.id, depth - 1);
      }
      break;
    }
    case 'to_do': {
      const rich = block.to_do.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      base.checked = block.to_do.checked;
      break;
    }
    case 'image': {
      if (block.image.type === 'external') {
        base.url = block.image.external.url;
      } else if (block.image.type === 'file') {
        base.url = block.image.file.url;
      }
      if (block.image.caption?.length) {
        base.caption = richTextToString(block.image.caption);
      }
      break;
    }
    case 'table': {
      if (block.has_children && depth > 1) {
        const rowBlocks = await fetchBlockChildren(block.id, depth - 1);
        base.rows = rowBlocks
          .filter((r) => r.type === 'table_row')
          .map((r) => r.rows?.[0] ?? []);
      }
      break;
    }
    case 'table_row': {
      const cells = block.table_row.cells;
      base.rows = [cells.map((cell) => richTextToString(cell))];
      break;
    }
    case 'callout': {
      const rich = block.callout.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      if (block.callout.icon?.type === 'emoji') {
        base.icon = block.callout.icon.emoji;
      }
      if (block.has_children && depth > 1) {
        base.children = await fetchBlockChildren(block.id, depth - 1);
      }
      break;
    }
    case 'child_page': {
      base.title = block.child_page.title;
      base.pageUrl = `https://www.notion.so/${block.id.replace(/-/g, '')}`;
      break;
    }
    case 'divider': {
      break;
    }
    case 'quote': {
      const rich = block.quote.rich_text;
      base.content = richTextToString(rich);
      base.richContent = convertRichText(rich);
      if (block.has_children && depth > 1) {
        base.children = await fetchBlockChildren(block.id, depth - 1);
      }
      break;
    }
    case 'code': {
      const rich = block.code.rich_text;
      base.content = richTextToString(rich);
      base.language = block.code.language;
      break;
    }
    case 'file': {
      if (block.file.type === 'external') {
        base.url = block.file.external.url;
      } else if (block.file.type === 'file') {
        base.url = block.file.file.url;
      }
      break;
    }
    case 'column_list': {
      if (block.has_children && depth > 1) {
        base.children = await fetchBlockChildren(block.id, depth - 1);
      }
      break;
    }
    case 'column': {
      if (block.has_children && depth > 1) {
        base.children = await fetchBlockChildren(block.id, depth - 1);
      }
      break;
    }
    default:
      return null;
  }

  return base;
}

export async function fetchPageBlocks(pageId: string): Promise<NotionBlock[]> {
  return fetchBlockChildren(pageId, 4);
}

/* ─── Seguimiento: sub-pages under the "Seguimiento" heading ─────────────────── */

export interface ThesisSectionOut { heading: string; level: number; blocks: { id: string; type: string; text: string; url?: string }[]; }
export interface SeguimientoItem { id: string; title: string; sections: ThesisSectionOut[]; }

const HEADING_LVL: Record<string, number> = { heading_1: 1, heading_2: 2, heading_3: 3 };
const normTxt = (s: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Flatten NotionBlocks into collapsible sections (recurses into children). */
export function blocksToThesisSections(blocks: NotionBlock[]): ThesisSectionOut[] {
  const sections: ThesisSectionOut[] = [];
  let current: ThesisSectionOut = { heading: '', level: 1, blocks: [] };
  const flush = () => { if (current.blocks.length || current.heading) sections.push(current); };
  const textOf = (b: NotionBlock) => (b.richContent?.map(r => r.text).join('') || b.content || '').trim();
  const walk = (list: NotionBlock[]) => {
    for (const b of list) {
      const lvl = HEADING_LVL[b.type];
      if (lvl) {
        flush();
        current = { heading: textOf(b), level: lvl, blocks: [] };
        if (b.children?.length) walk(b.children);
      } else if (b.type === 'image') {
        current.blocks.push({ id: b.id, type: 'image', text: b.caption ?? '', url: b.url });
      } else {
        const t = textOf(b);
        if (t) current.blocks.push({ id: b.id, type: b.type, text: t, url: b.url });
        if (b.children?.length) walk(b.children);
      }
    }
  };
  walk(blocks);
  flush();
  return sections;
}

/** Title of a database page (from its "title"-typed property). */
function dbPageTitle(page: any): string {
  const props = page?.properties ?? {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === 'title') return (p.title ?? []).map((t: any) => t.plain_text).join('');
  }
  return '';
}

/** List a Notion page's sub-pages (id + title) WITHOUT fetching their content.
 *  Fast: one block-list call per container. Handles sub-pages at any nesting depth
 *  (columns/toggles/headings) and pages inside an inline database. */
export async function listNotionChildPages(pageId: string): Promise<{ id: string; title: string }[]> {
  const notion = getNotionClient();
  const pageRefs: { id: string; title: string }[] = [];
  const dbRefs: string[] = [];
  const CONTAINERS = new Set([
    'column_list', 'column', 'toggle', 'synced_block', 'callout',
    'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item',
  ]);

  async function scan(blockId: string, depth: number) {
    if (depth <= 0) return;
    let cursor: string | undefined;
    do {
      let resp;
      try {
        resp = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
      } catch (err: any) {
        if (err?.code === 'object_not_found' || err?.code === 'validation_error') return;
        throw err;
      }
      for (const b of resp.results) {
        if (!isFullBlock(b)) continue;
        if (b.type === 'child_page') {
          pageRefs.push({ id: b.id, title: (b as any).child_page.title || 'Página' });
        } else if (b.type === 'child_database') {
          dbRefs.push(b.id);
        } else if ((b as any).has_children && CONTAINERS.has(b.type)) {
          await scan(b.id, depth - 1);
        }
      }
      cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
  }
  await scan(pageId, 4);

  // Pages contained in inline databases.
  for (const dbId of dbRefs) {
    try {
      let cursor: string | undefined;
      do {
        const q: any = await notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 });
        for (const p of q.results) pageRefs.push({ id: p.id, title: dbPageTitle(p) || 'Página' });
        cursor = q.has_more ? (q.next_cursor ?? undefined) : undefined;
      } while (cursor);
    } catch { /* database not shared with the integration */ }
  }

  // De-duplicate.
  const seen = new Set<string>();
  return pageRefs.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** Parse a single Notion page into collapsible sections. */
export async function fetchNotionPageSections(pageId: string): Promise<ThesisSectionOut[]> {
  const blocks = await fetchPageBlocks(pageId);
  return blocksToThesisSections(blocks);
}

/** Return all sub-pages of a Notion page, each parsed into sections.
 *  NOTE: prefer listNotionChildPages + lazy per-page fetch for large sections —
 *  fetching every page's content upfront can exceed the edge gateway timeout. */
export async function fetchNotionChildren(pageId: string): Promise<SeguimientoItem[]> {
  const refs = await listNotionChildPages(pageId);
  const items: SeguimientoItem[] = [];
  for (const ref of refs) {
    try {
      items.push({ id: ref.id, title: ref.title, sections: await fetchNotionPageSections(ref.id) });
    } catch {
      items.push({ id: ref.id, title: ref.title, sections: [] }); // not shared → keep title + link
    }
  }
  return items;
}

/** Find the "Seguimiento" heading and return each sub-page under it, parsed. */
export async function fetchSeguimiento(pageId: string): Promise<SeguimientoItem[]> {
  const blocks = await fetchPageBlocks(pageId);

  // Locate the "Seguimiento" heading and collect child_page blocks that belong to it:
  // either nested as its children (toggle-heading) or as following siblings up to the
  // next heading of the same/higher level.
  const childPages: NotionBlock[] = [];
  let segIdx = -1, segLevel = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (HEADING_LVL[b.type] && normTxt((b.richContent?.map(r => r.text).join('') || b.content || '')).includes('seguimiento')) {
      segIdx = i; segLevel = HEADING_LVL[b.type];
      for (const ch of (b.children ?? [])) if (ch.type === 'child_page') childPages.push(ch);
      break;
    }
  }
  if (segIdx >= 0) {
    for (let i = segIdx + 1; i < blocks.length; i++) {
      const b = blocks[i];
      if (HEADING_LVL[b.type] && HEADING_LVL[b.type] <= segLevel) break;
      if (b.type === 'child_page') childPages.push(b);
    }
  }

  const items: SeguimientoItem[] = [];
  for (const p of childPages) {
    try {
      const sub = await fetchPageBlocks(p.id);
      items.push({ id: p.id, title: p.title || 'Seguimiento', sections: blocksToThesisSections(sub) });
    } catch { /* sub-page not shared with the integration */ }
  }
  return items;
}

export async function fetchPageBlocksCached(pageId: string): Promise<NotionBlock[]> {
  const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

  const cacheResult = await pool.query(
    'SELECT content, last_fetched FROM notion_cache WHERE page_id = $1',
    [pageId]
  );

  if (cacheResult.rows.length > 0) {
    const cached = cacheResult.rows[0];
    const fetchedAt = new Date(cached.last_fetched).getTime();
    const age = Date.now() - fetchedAt;
    if (age < CACHE_DURATION_MS) {
      return JSON.parse(cached.content) as NotionBlock[];
    }
  }

  const blocks = await fetchPageBlocks(pageId);
  const content = JSON.stringify(blocks);

  await pool.query(
    `INSERT INTO notion_cache (page_id, content, last_fetched)
     VALUES ($1, $2, NOW())
     ON CONFLICT (page_id) DO UPDATE SET content = $2, last_fetched = NOW()`,
    [pageId, content]
  );

  return blocks;
}

export async function invalidateCache(pageId: string): Promise<void> {
  await pool.query('DELETE FROM notion_cache WHERE page_id = $1', [pageId]);
}

export interface EarningsCallLink {
  pageId: string;
  title: string;
  pageUrl: string;
}

export async function extractEarningsCallsFromPage(pageId: string): Promise<EarningsCallLink[]> {
  const blocks = await fetchPageBlocks(pageId);

  let inSeguimiento = false;
  const earnings: EarningsCallLink[] = [];

  for (const block of blocks) {
    if (block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3') {
      const text = block.content?.toLowerCase() ?? '';
      if (text.includes('seguimiento')) {
        inSeguimiento = true;
      } else if (inSeguimiento) {
        inSeguimiento = false;
      }
    }

    if (block.type === 'toggle' && block.content?.toLowerCase().includes('seguimiento')) {
      inSeguimiento = true;
      if (block.children) {
        for (const child of block.children) {
          if (child.type === 'child_page' && child.title && child.pageUrl) {
            earnings.push({
              pageId: child.id,
              title: child.title,
              pageUrl: child.pageUrl,
            });
          }
        }
      }
      inSeguimiento = false;
      continue;
    }

    if (inSeguimiento && block.type === 'child_page' && block.title && block.pageUrl) {
      earnings.push({
        pageId: block.id,
        title: block.title,
        pageUrl: block.pageUrl,
      });
    }
  }

  return earnings;
}

export async function getPageTitle(pageId: string): Promise<string> {
  const notion = getNotionClient();
  const page = await notion.pages.retrieve({ page_id: pageId });

  if ('properties' in page) {
    const titleProp = Object.values(page.properties).find(
      (p) => p.type === 'title'
    );
    if (titleProp && titleProp.type === 'title') {
      return titleProp.title.map((t: any) => t.plain_text).join('');
    }
  }

  return 'Untitled';
}

/** Return the page's icon as an image URL (external/file). Emojis return null so the
 *  caller can fall back to another logo source. */
export async function getPageIcon(pageId: string): Promise<string | null> {
  try {
    const notion = getNotionClient();
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    const icon = page?.icon;
    if (!icon) return null;
    if (icon.type === 'external') return icon.external?.url ?? null;
    if (icon.type === 'file') return icon.file?.url ?? null;
    return null; // emoji → no image
  } catch { return null; }
}

export function extractPageIdFromUrl(url: string): string | null {
  const match = url.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (match) {
    return match[1].replace(/-/g, '');
  }
  return null;
}
