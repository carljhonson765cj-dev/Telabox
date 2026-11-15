import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { Readable } from 'node:stream';
import { browseServerPage, crawlServer, fetchLatestServerUpdates, normalizeTargetUrl, searchServerContent } from './server/crawler.ts';
import { createDemoServerRouter } from './server/demoServer.ts';
import {
  BROWSER_USER_AGENT,
  DEFAULT_PORTAL_COOKIES,
  resolveVideoPageStream,
} from './server/resolver.ts';

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json());

  // Built-in demo HTML video server & open directory for instant testing
  app.use('/demo-server', createDemoServerRouter());

  // SSE streaming server crawl endpoint
  app.get('/api/scan/stream', async (req, res) => {
    const rawUrl = String(req.query.url || '');
    const mode = req.query.mode === 'quick' ? 'quick' : 'full';
    const maxPages = Math.min(Math.max(Number(req.query.maxPages) || (mode === 'quick' ? 1 : 25), 1), 120);
    const maxDepth = Math.min(Math.max(Number(req.query.maxDepth) || (mode === 'quick' ? 0 : 2), 0), 5);

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

      sendEvent({ type: 'complete', profile });
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
      const { url, mode = 'full', maxPages = 25, maxDepth = 2 } = req.body || {};
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const profile = await crawlServer({
        url: String(url || ''),
        mode: mode === 'quick' ? 'quick' : 'full',
        maxPages: Math.min(Math.max(Number(maxPages) || 25, 1), 120),
        maxDepth: Math.min(Math.max(Number(maxDepth) || 2, 0), 5),
        localBaseUrl,
      });
      res.json(profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao escanear servidor.';
      res.status(400).json({ error: message });
    }
  });

  // On-demand remote server search endpoint (supports page=1,2,3... pagination)
  app.get('/api/search', async (req, res) => {
    const serverUrl = String(req.query.serverUrl || '');
    const query = String(req.query.query || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    if (!serverUrl || !query) {
      res.status(400).json({ error: 'Informe o servidor e o termo de pesquisa.' });
      return;
    }

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const result = await searchServerContent({
        serverUrl,
        query,
        page,
        localBaseUrl,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro ao pesquisar conteúdo no servidor.';
      res.status(502).json({ error: message });
    }
  });

  // Live pagination / category browsing directly from the target website
  app.get('/api/browse', async (req, res) => {
    const rawPageUrl = String(req.query.url || '');
    const categoryName = typeof req.query.category === 'string' && req.query.category.trim()
      ? req.query.category.trim()
      : undefined;
    if (!rawPageUrl) {
      res.status(400).json({ error: 'Parâmetro url ausente.' });
      return;
    }

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const pageUrl = normalizeTargetUrl(rawPageUrl, localBaseUrl);
      const result = await browseServerPage({
        pageUrl,
        categoryName,
        localBaseUrl,
      });
      res.json(result);
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
      res.json(result);
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
    const rawReferer = typeof req.query.referer === 'string' ? req.query.referer : '';
    if (!rawTarget) {
      res.status(400).send('Parâmetro url ausente.');
      return;
    }

    try {
      const localBaseUrl = `http://127.0.0.1:${PORT}`;
      const targetUrl = normalizeTargetUrl(rawTarget, localBaseUrl);
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
        'User-Agent': BROWSER_USER_AGENT,
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
        const rewritten = playlistText
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              return line.replace(/URI=(["'])([^"']+)\1/gi, (_, quote, uri) => {
                try {
                  const abs = new URL(uri, finalUpstreamUrl).toString();
                  return `URI=${quote}/api/proxy?url=${encodeURIComponent(abs)}${refParam}${quote}`;
                } catch {
                  return `URI=${quote}${uri}${quote}`;
                }
              });
            }
            try {
              const abs = new URL(trimmed, finalUpstreamUrl).toString();
              return `/api/proxy?url=${encodeURIComponent(abs)}${refParam}`;
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

  // Prevent any unmatched /api/* route from falling through to HTML SPA fallback
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint de API não encontrado.' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TelaBox server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
