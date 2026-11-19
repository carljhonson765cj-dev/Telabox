import 'dotenv/config';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  browseServerPagesBatch,
  crawlServer,
  fetchLatestServerUpdates,
  normalizeTargetUrl,
  searchServerContent,
} from './server/crawler.ts';
import { createDemoServerRouter } from './server/demoServer.ts';
import {
  BROWSER_USER_AGENT,
  DEFAULT_PORTAL_COOKIES,
  resolveVideoPageStream,
} from './server/resolver.ts';
import { registerBrowserProxyRoutes } from './server/browserProxy.ts';
import {
  classifyMediaItems,
  classifyVideoMetadataList,
  type VideoMetadataInput,
} from './server/podcastClassifier.ts';

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Built-in demo HTML video server & open directory for instant testing
  app.use('/demo-server', createDemoServerRouter());

  // SSE streaming server crawl endpoint
  app.get('/api/scan/stream', async (req, res) => {
    const rawUrl = String(req.query.url || '');
    const mode = req.query.mode === 'quick' ? 'quick' : 'full';
    const maxPages = Math.min(Math.max(Number(req.query.maxPages) || (mode === 'quick' ? 1 : 5), 1), 5);
    const maxDepth = Math.min(Math.max(Number(req.query.maxDepth) || (mode === 'quick' ? 0 : 1), 0), 3);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (payload: unknown) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    const abortController = new AbortController();
    req.on('close', () => {
      abortController.abort();
    });

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const profile = await crawlServer({
        url: rawUrl,
        mode,
        maxPages,
        maxDepth,
        localBaseUrl,
        signal: abortController.signal,
        onProgress: (progress) => {
          sendEvent({ type: 'progress', ...progress });
        },
        onItem: (item) => {
          sendEvent({ type: 'item', item });
        },
      });

      let classificationError: string | undefined;
      if (profile.items.length > 0) {
        sendEvent({
          type: 'progress',
          pagesScanned: profile.pagesScanned,
          maxPages,
          foldersFound: profile.foldersFound,
          itemsFound: profile.items.length,
          currentUrl: 'Analisando metadados dos vídeos (filtro anti-podcast)...',
          categories: profile.categories,
        });
        try {
          profile.items = await classifyMediaItems(profile.items, abortController.signal);
        } catch (err) {
          if (abortController.signal.aborted) throw err;
          classificationError =
            err instanceof Error ? err.message : 'Erro ao classificar metadados dos vídeos.';
        }
      }

      sendEvent({
        type: 'complete',
        profile,
        ...(classificationError ? { classificationError } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao carregar o servidor.';
      sendEvent({ type: 'error', message });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // Standard JSON scan fallback
  app.post('/api/scan', async (req, res) => {
    try {
      const { url, mode = 'full', maxPages = 5, maxDepth = 1 } = req.body || {};
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const profile = await crawlServer({
        url: String(url || ''),
        mode: mode === 'quick' ? 'quick' : 'full',
        maxPages: Math.min(Math.max(Number(maxPages) || 5, 1), 5),
        maxDepth: Math.min(Math.max(Number(maxDepth) || 1, 0), 3),
        localBaseUrl,
      });
      let classificationError: string | undefined;
      try {
        profile.items = await classifyMediaItems(profile.items);
      } catch (err) {
        classificationError =
          err instanceof Error ? err.message : 'Erro ao classificar metadados dos vídeos.';
      }
      res.json({
        ...profile,
        ...(classificationError ? { classificationError } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao escanear servidor.';
      res.status(400).json({ error: message });
    }
  });

  // On-demand metadata classification endpoint (accepts a batch of items or a single video item)
  app.post('/api/classify', async (req, res) => {
    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    try {
      const body = req.body || {};
      const rawList: unknown[] = Array.isArray(body.items)
        ? body.items
        : body.item && typeof body.item === 'object'
        ? [body.item]
        : typeof body.title === 'string'
        ? [body]
        : [];

      if (rawList.length === 0) {
        res.status(400).json({ error: 'Informe os metadados de ao menos um vídeo para análise.' });
        return;
      }

      const inputs: VideoMetadataInput[] = rawList
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .slice(0, 150)
        .map((entry, idx) => ({
          id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `item_${idx}`,
          title: typeof entry.title === 'string' ? entry.title : String(entry.rawTitle || 'Sem título'),
          rawTitle: typeof entry.rawTitle === 'string' ? entry.rawTitle : undefined,
          category: typeof entry.category === 'string' ? entry.category : undefined,
          folderPath: typeof entry.folderPath === 'string' ? entry.folderPath : undefined,
          duration: typeof entry.duration === 'string' ? entry.duration : undefined,
          quality: typeof entry.quality === 'string' ? entry.quality : undefined,
          format: typeof entry.format === 'string' ? entry.format : undefined,
          description: typeof entry.description === 'string' ? entry.description : undefined,
          url: typeof entry.url === 'string' ? entry.url : undefined,
        }));

      const map = await classifyVideoMetadataList(inputs, abortController.signal);
      const results = inputs.map((item) => ({
        id: item.id,
        is_podcast: map.get(item.id) === true,
      }));

      res.json({
        results,
        ...(results.length === 1 ? { is_podcast: results[0].is_podcast } : {}),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Erro ao classificar metadados dos vídeos.';
      res.status(502).json({ error: message });
    }
  });

  // On-demand remote server search endpoint (batches of 3-5 pages starting at page=1,4,7...)
  app.get('/api/search', async (req, res) => {
    const serverUrl = String(req.query.serverUrl || '');
    const query = String(req.query.query || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pages = Math.min(Math.max(Number(req.query.pages) || 3, 1), 5);
    if (!serverUrl || !query) {
      res.status(400).json({ error: 'Informe o servidor e o termo de pesquisa.' });
      return;
    }

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const result = await searchServerContent({
        serverUrl,
        query,
        page,
        pages,
        localBaseUrl,
        signal: abortController.signal,
      });
      let classificationError: string | undefined;
      try {
        result.items = await classifyMediaItems(result.items, abortController.signal);
      } catch (err) {
        if (abortController.signal.aborted) throw err;
        classificationError =
          err instanceof Error ? err.message : 'Erro ao classificar metadados dos vídeos.';
      }
      res.json({
        ...result,
        ...(classificationError ? { classificationError } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao pesquisar conteúdo no servidor.';
      res.status(502).json({ error: message });
    }
  });

  // Live on-demand batch pagination (fetches 3-5 pages sequentially with rate-limit delay)
  app.get('/api/browse', async (req, res) => {
    const rawPageUrl = String(req.query.url || '');
    const pages = Math.min(Math.max(Number(req.query.pages) || 4, 1), 5);
    const categoryName = typeof req.query.category === 'string' && req.query.category.trim()
      ? req.query.category.trim()
      : undefined;
    if (!rawPageUrl) {
      res.status(400).json({ error: 'Parâmetro url ausente.' });
      return;
    }

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const pageUrl = normalizeTargetUrl(rawPageUrl, localBaseUrl);
      const result = await browseServerPagesBatch({
        pageUrl,
        pages,
        categoryName,
        localBaseUrl,
        signal: abortController.signal,
      });
      let classificationError: string | undefined;
      try {
        result.items = await classifyMediaItems(result.items, abortController.signal);
      } catch (err) {
        if (abortController.signal.aborted) throw err;
        classificationError =
          err instanceof Error ? err.message : 'Erro ao classificar metadados dos vídeos.';
      }
      res.json({
        ...result,
        ...(classificationError ? { classificationError } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao carregar página do servidor.';
      res.status(502).json({ error: message });
    }
  });

  // Live check for recently added videos & site updates
  app.get('/api/latest', async (req, res) => {
    const serverUrl = String(req.query.serverUrl || '');
    const latestUrl = typeof req.query.latestUrl === 'string' && req.query.latestUrl.trim()
      ? req.query.latestUrl.trim()
      : undefined;
    if (!serverUrl) {
      res.status(400).json({ error: 'Parâmetro serverUrl ausente.' });
      return;
    }

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const result = await fetchLatestServerUpdates({
        serverUrl,
        latestUrl,
        localBaseUrl,
      });
      let classificationError: string | undefined;
      try {
        result.items = await classifyMediaItems(result.items);
      } catch (err) {
        classificationError =
          err instanceof Error ? err.message : 'Erro ao classificar metadados dos vídeos.';
      }
      res.json({
        ...result,
        ...(classificationError ? { classificationError } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao buscar novidades do site.';
      res.status(502).json({ error: message });
    }
  });

  // On-demand watch-page stream resolver (returns HLS/MP4 qualities & fresh signed URLs)
  app.get('/api/resolve', async (req, res) => {
    const rawTarget = String(req.query.url || '');
    if (!rawTarget) {
      res.status(400).json({ error: 'Parâmetro url ausente.' });
      return;
    }

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const targetUrl = normalizeTargetUrl(rawTarget, localBaseUrl);
      const resolved = await resolveVideoPageStream(targetUrl);
      res.json(resolved);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao extrair stream do vídeo.';
      res.status(502).json({ error: message });
    }
  });

  // Media, HLS playlist, subtitle (.srt -> .vtt), and thumbnail proxy with Range + Referer support
  app.get('/api/proxy', async (req, res) => {
    const rawTarget = String(req.query.url || '');
    const rawSubpath = typeof req.query.subpath === 'string' ? req.query.subpath : '';
    const rawReferer = typeof req.query.referer === 'string' ? req.query.referer : '';
    const rawUserAgent = typeof req.query.ua === 'string' && req.query.ua.trim() ? req.query.ua.trim() : '';
    if (!rawTarget) {
      res.status(400).send('Parâmetro url ausente.');
      return;
    }

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const baseTargetUrl = normalizeTargetUrl(rawTarget, localBaseUrl);
      const targetUrl = rawSubpath ? new URL(rawSubpath, baseTargetUrl).toString() : baseTargetUrl;
      const parsed = new URL(targetUrl);

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.status(400).send('Protocolo não suportado.');
        return;
      }

      const refererUrl = rawReferer || parsed.origin + '/';
      let originHeader = parsed.origin;
      let refererHost = parsed.hostname;
      try {
        const refParsed = new URL(refererUrl);
        originHeader = refParsed.origin;
        refererHost = refParsed.hostname;
      } catch {
        // keep parsed defaults
      }

      const targetRootDomain = parsed.hostname.split('.').slice(-2).join('.');
      const refererRootDomain = refererHost.split('.').slice(-2).join('.');
      const sameRootPortal = targetRootDomain === refererRootDomain;

      const headers: Record<string, string> = {
        'User-Agent': rawUserAgent || BROWSER_USER_AGENT,
        'Accept': '*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
        'Referer': refererUrl,
      };

      if (sameRootPortal) {
        headers['Origin'] = originHeader;
        headers['Cookie'] = DEFAULT_PORTAL_COOKIES;
      }

      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }

      const upstream = await fetch(targetUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        redirect: 'follow',
      });
      const finalUpstreamUrl = upstream.url || targetUrl;
      const contentType = upstream.headers.get('content-type') || '';
      const lowerUrl = finalUpstreamUrl.toLowerCase();

      if (req.method === 'HEAD') {
        res.status(upstream.status);
        const headHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
        for (const h of headHeaders) {
          const val = upstream.headers.get(h);
          if (val) res.setHeader(h, val);
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end();
        return;
      }

      // Convert .srt subtitles to WebVTT on the fly
      if (lowerUrl.endsWith('.srt') || contentType.includes('subrip')) {
        const srtText = await upstream.text();
        const vttText = 'WEBVTT\n\n' + srtText
          .replace(/\r\n/g, '\n')
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        res.status(200);
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(vttText);
        return;
      }

      // Rewrite relative segment/playlist URLs inside .m3u8 using post-redirect URL
      if (
        lowerUrl.includes('.m3u8') ||
        contentType.includes('mpegurl') ||
        contentType.includes('vnd.apple.mpegurl')
      ) {
        const playlistText = await upstream.text();
        const refParam = rawReferer ? `&referer=${encodeURIComponent(rawReferer)}` : '';
        const uaParam = rawUserAgent ? `&ua=${encodeURIComponent(rawUserAgent)}` : '';
        const proxyExtraParams = `${refParam}${uaParam}`;
        const rewritten = playlistText
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              return line.replace(/URI=(["'])([^"']+)\1/gi, (_, quote, uri) => {
                try {
                  const abs = new URL(uri, finalUpstreamUrl).toString();
                  return `URI=${quote}/api/proxy?url=${encodeURIComponent(abs)}${proxyExtraParams}${quote}`;
                } catch {
                  return `URI=${quote}${uri}${quote}`;
                }
              });
            }
            try {
              const abs = new URL(trimmed, finalUpstreamUrl).toString();
              return `/api/proxy?url=${encodeURIComponent(abs)}${proxyExtraParams}`;
            } catch {
              return line;
            }
          })
          .join('\n');

        res.status(upstream.status);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.query.download === '1') {
          const rawName = typeof req.query.filename === 'string' ? req.query.filename : 'video.m3u8';
          const safeAscii = rawName.replace(/[^\w.\- ()]/g, '_');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(rawName)}`
          );
        }
        res.send(rewritten);
        return;
      }

      // Rewrite relative <BaseURL> or segment paths inside MPEG-DASH (.mpd) manifests
      if (lowerUrl.includes('.mpd') || contentType.includes('dash+xml')) {
        const mpdText = await upstream.text();
        const refParam = rawReferer ? `&referer=${encodeURIComponent(rawReferer)}` : '';
        const uaParam = rawUserAgent ? `&ua=${encodeURIComponent(rawUserAgent)}` : '';
        const proxyExtraParams = `${refParam}${uaParam}`;
        const baseDir = new URL('.', finalUpstreamUrl).toString();
        let rewrittenMpd = mpdText
          .replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (_, rawBase) => {
            try {
              const abs = new URL(rawBase.trim(), finalUpstreamUrl).toString();
              return `<BaseURL>/api/proxy?url=${encodeURIComponent(abs)}${proxyExtraParams}</BaseURL>`;
            } catch {
              return `<BaseURL>${rawBase}</BaseURL>`;
            }
          })
          .replace(/(media|initialization)=["']([^"']+)["']/gi, (full, attr, val) => {
            if (val.startsWith('/api/proxy') || /^https?:\/\//i.test(val)) {
              if (/^https?:\/\//i.test(val)) {
                return `${attr}="/api/proxy?url=${encodeURIComponent(val)}${proxyExtraParams}"`;
              }
              return full;
            }
            if (val.includes('$')) {
              return full;
            }
            try {
              const abs = new URL(val, finalUpstreamUrl).toString();
              return `${attr}="/api/proxy?url=${encodeURIComponent(abs)}${proxyExtraParams}"`;
            } catch {
              return full;
            }
          });
        if (!/<BaseURL>/i.test(rewrittenMpd)) {
          rewrittenMpd = rewrittenMpd.replace(
            /(<MPD[^>]*>)/i,
            `$1\n  <BaseURL>/api/proxy?url=${encodeURIComponent(baseDir)}${proxyExtraParams}&subpath=</BaseURL>`
          );
        }
        res.status(upstream.status);
        res.setHeader('Content-Type', 'application/dash+xml');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewrittenMpd);
        return;
      }

      res.status(upstream.status);
      const hasEncoding = Boolean(upstream.headers.get('content-encoding'));
      const forwardHeaders = hasEncoding
        ? ['content-type', 'content-range', 'accept-ranges', 'cache-control']
        : ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
      for (const h of forwardHeaders) {
        const val = upstream.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (req.query.download === '1') {
        const rawName = typeof req.query.filename === 'string' ? req.query.filename : 'video.mp4';
        const safeAscii = rawName.replace(/[^\w.\- ()]/g, '_');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(rawName)}`
        );
      }

      if (upstream.body) {
        const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        nodeStream.on('error', () => {
          if (!res.headersSent) res.status(502).end();
        });
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'Erro no proxy de mídia.' });
      }
    }
  });

  registerBrowserProxyRoutes(app, PORT);

  // Prevent any unmatched /api/* route from falling through to HTML SPA fallback
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint de API não encontrado.' });
  });

  const httpServer = createHttpServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`TelaBox server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
