import { Router, Request, Response } from 'express';
import {
  fetchPageBlocksCached,
  getPageTitle,
  extractPageIdFromUrl,
  invalidateCache,
} from '../notionClient';

const router = Router();

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
