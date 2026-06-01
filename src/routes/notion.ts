import { Router, Request, Response } from 'express';
import {
  fetchPageBlocksCached,
  getPageTitle,
  extractPageIdFromUrl,
  invalidateCache,
} from '../notionClient';
import { scrapePage } from '../services/pageScraper';
import { scrapeNotionThesis } from '../services/notionPublic';

const router = Router();

// GET /api/notion/thesis?url=...  — scrape a PUBLIC notion.site page via loadPageChunk
// (no integration token needed) and return it as collapsible sections.
router.get('/thesis', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const thesis = await scrapeNotionThesis(url);
    return res.json(thesis);
  } catch (err: any) {
    console.error('[notion/thesis]', err?.message);
    return res.status(500).json({ error: err?.message ?? 'No se pudo cargar la tesis de Notion' });
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

export default router;
