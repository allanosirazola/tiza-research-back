import { Router, Request, Response } from 'express';
import {
  fetchPageBlocksCached,
  getPageTitle,
  extractPageIdFromUrl,
  invalidateCache,
} from '../notionClient';
import { scrapePage } from '../services/pageScraper';
import { scrapeNotionThesis, debugNotionThesis } from '../services/notionPublic';
import { fetchNotionChildren } from '../notionClient';
import pool from '../db';

const router = Router();

// GET /api/notion/thesis?url=...  — scrape a PUBLIC notion.site page via loadPageChunk
// (no integration token needed) and return it as collapsible sections.
router.get('/thesis', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // 1) Try the public scrape (no token). Newer Notion pages return no content this
    //    way, so 2) fall back to the official Notion API (integration token) — which
    //    needs the page shared with the integration.
    let thesis = await scrapeNotionThesis(url).catch(() => null);
    if (!thesis || thesis.sections.length === 0) {
      const pageId = extractPageIdFromUrl(url);
      if (pageId && process.env.NOTION_TOKEN) {
        try {
          const [blocks, title] = await Promise.all([
            fetchPageBlocksCached(pageId),
            getPageTitle(pageId).catch(() => 'Tesis de Inversión'),
          ]);
          const sections = blocksToSections(blocks);
          if (sections.length) {
            return res.json({ url, pageId, title, sections, source: 'notion-api' });
          }
        } catch (e: any) {
          // Page not shared with the integration, or token missing.
          return res.status(409).json({
            error: 'NOTION_API_FALLBACK_FAILED',
            detail: e?.message,
            hint: 'Comparte la página de Notion con tu integración (··· → Conexiones) para leer el contenido.',
          });
        }
      }
    }
    if (!thesis || thesis.sections.length === 0) {
      return res.status(409).json({
        error: 'EMPTY',
        hint: 'La API pública de Notion no devuelve el contenido de esta página. Conecta una integración de Notion (NOTION_TOKEN) y comparte la página con ella.',
      });
    }
    return res.json(thesis);
  } catch (err: any) {
    console.error('[notion/thesis]', err?.message);
    return res.status(500).json({ error: err?.message ?? 'No se pudo cargar la tesis de Notion' });
  }
});

/** Flatten Notion API blocks into the collapsible-section shape used by the UI.
 *  Recurses into children so toggle-headings, toggles and columns contribute their
 *  content, and surfaces images with their URL. */
function blocksToSections(blocks: any[]): { heading: string; level: number; blocks: { id: string; type: string; text: string; url?: string }[] }[] {
  const sections: any[] = [];
  let current: any = { heading: '', level: 1, blocks: [] };
  const headingLevel: Record<string, number> = { heading_1: 1, heading_2: 2, heading_3: 3 };
  const textOf = (b: any): string =>
    (b.richContent?.map((r: any) => r.text).join('') ?? b.content ?? '').trim();
  const flush = () => { if (current.blocks.length || current.heading) sections.push(current); };

  const walk = (list: any[]) => {
    for (const b of list) {
      const lvl = headingLevel[b.type];
      if (lvl) {
        flush();
        current = { heading: textOf(b), level: lvl, blocks: [] };
        if (b.children?.length) walk(b.children); // toggle-heading content lives in children
      } else if (b.type === 'image') {
        current.blocks.push({ id: b.id, type: 'image', text: b.caption ?? '', url: b.url });
      } else {
        const t = textOf(b);
        if (t) current.blocks.push({ id: b.id, type: b.type, text: t, url: b.url });
        if (b.children?.length) walk(b.children); // toggles, columns, nested lists…
      }
    }
  };
  walk(blocks);
  flush();
  return sections;
}

// GET /api/notion/thesis-debug?url=... — raw recordMap shape for diagnosing.
router.get('/thesis-debug', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    return res.json(await debugNotionThesis(url));
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// GET /api/notion/scrape?url=...  — fetch a public web/notion.site page server-side
// (notion.site forbids iframing) and return sanitized HTML to render inline.
router.get('/scrape', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const page = await scrapePage(url);
    return res.json(page);
  } catch (err: any) {
    console.error('[scrape]', err?.message);
    return res.status(500).json({ error: err?.message ?? 'No se pudo cargar la página' });
  }
});

router.get('/page/:pageId', async (req: Request, res: Response) => {
  try {
    const { pageId } = req.params;
    const force = req.query.force === 'true';
    
    if (force) {
      await invalidateCache(pageId);
    }
    
    const blocks = await fetchPageBlocksCached(pageId);
    return res.json({ pageId, blocks });
  } catch (err: any) {
    console.error(err);
    if (err?.code === 'object_not_found') {
      return res.status(404).json({ error: 'Notion page not found' });
    }
    return res.status(500).json({ error: 'Failed to fetch Notion page', details: err?.message });
  }
});

router.post('/import', async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const pageId = extractPageIdFromUrl(url);
    if (!pageId) {
      return res.status(400).json({ error: 'Could not extract page ID from URL' });
    }
    
    const [title, blocks] = await Promise.all([
      getPageTitle(pageId),
      fetchPageBlocksCached(pageId),
    ]);
    
    return res.json({ pageId, title, blocks });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to import Notion page', details: err?.message });
  }
});

// GET /api/notion/children?url=... — all child pages of a Notion page, each parsed
// into collapsible sections (for Sectores / Formación / Informes anuales).
router.get('/children', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!process.env.NOTION_TOKEN) return res.status(409).json({ error: 'NOTION_TOKEN not configured' });
    const pageId = extractPageIdFromUrl(url);
    if (!pageId) return res.status(400).json({ error: 'URL de Notion no válida' });
    const items = await fetchNotionChildren(pageId);
    return res.json({ items });
  } catch (err: any) {
    console.error('[notion/children]', err?.message);
    return res.status(500).json({ error: err?.message ?? 'Failed to fetch Notion children' });
  }
});

export default router;
