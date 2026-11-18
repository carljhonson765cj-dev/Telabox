import type { Express, Request, Response } from 'express';
import express from 'express';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as cheerio from 'cheerio';
import { normalizeTargetUrl } from './crawler.ts';
import {
  BROWSER_USER_AGENT,
  buildPortalHeaders,
  DEFAULT_PORTAL_COOKIES,
  extractStreamsFromHtml,
} from './resolver.ts';
import type { QualityOption } from '../src/types/media.ts';

const browserCookieJar = new Map<string, string>();
const MAX_COOKIE_DOMAINS = 200;

function getRootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname.toLowerCase();
}

function getCookiesForUrl(urlStr: string): string {
  try {
    const root = getRootDomain(new URL(urlStr).hostname);
    const saved = browserCookieJar.get(root);
    return saved ? `${DEFAULT_PORTAL_COOKIES}; ${saved}` : DEFAULT_PORTAL_COOKIES;
  } catch {
    return DEFAULT_PORTAL_COOKIES;
  }
}

function storeCookiesFromResponse(urlStr: string, res: globalThis.Response): void {
  try {
    const root = getRootDomain(new URL(urlStr).hostname);
    const setCookies = res.headers.getSetCookie?.() || [];
    if (setCookies.length === 0) return;

    const existing = browserCookieJar.get(root) || '';
    const map = new Map<string, string>();
    for (const pair of existing.split(';')) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    }
    for (const raw of setCookies) {
      const firstPart = raw.split(';')[0];
      const idx = firstPart.indexOf('=');
      if (idx > 0) {
        map.set(firstPart.slice(0, idx).trim(), firstPart.slice(idx + 1).trim());
      }
    }
    if (browserCookieJar.size >= MAX_COOKIE_DOMAINS && !browserCookieJar.has(root)) {
      const firstKey = browserCookieJar.keys().next().value;
      if (firstKey) browserCookieJar.delete(firstKey);
    }
    browserCookieJar.set(
      root,
      Array.from(map.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
    );
  } catch {
    // ignore invalid URL cookie storage
  }
}

function isSkippableUri(val: string): boolean {
  const v = val.trim().toLowerCase();
  return (
    !v ||
    v.startsWith('#') ||
    v.startsWith('data:') ||
    v.startsWith('blob:') ||
    v.startsWith('javascript:') ||
    v.startsWith('mailto:') ||
    v.startsWith('tel:')
  );
}

function toAbsUrl(raw: string, base: string): string | null {
  if (isSkippableUri(raw)) return null;
  try {
    return new URL(raw.trim(), base).toString();
  } catch {
    return null;
  }
}

function rewriteCssUrls(css: string, baseUrl: string, referer: string): string {
  const refPart = `&referer=${encodeURIComponent(referer)}`;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote, rawUrl) => {
    if (isSkippableUri(rawUrl) || rawUrl.startsWith('/api/')) return full;
    const abs = toAbsUrl(rawUrl, baseUrl);
    if (!abs) return full;
    return `url(${quote}/api/browser/asset?url=${encodeURIComponent(abs)}${refPart}${quote})`;
  });
}

function buildBridgeScript(params: {
  finalUrl: string;
  pageTitle: string;
  initialStreams: QualityOption[];
  blocked?: boolean;
}): string {
  const payloadJson = JSON.stringify(params).replace(/<\//g, '<\\/');
  return `
<script data-telabox-bridge="1">
(function() {
  var META = ${payloadJson};
  var CURRENT_URL = META.finalUrl;
  var PAGE_TITLE = META.pageTitle || document.title || CURRENT_URL;
  var discoveredMap = Object.create(null);

  function post(type, extra) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(Object.assign({ type: type }, extra || {}), '*');
      }
    } catch (e) {}
  }

  if (META.blocked) {
    post('telabox:blocked', { url: CURRENT_URL });
  }

  function isPreview(u) {
    return /thumb-v\\d*\\.|\\.t\\.(?:av1\\.)?mp4|\\/previews?\\/|\\/trailers?\\/|sprite|\\.(jpg|jpeg|png|webp|gif|svg|css|js|woff2?)(\\?|$)/i.test(u);
  }

  function detectStreamType(u) {
    var lower = String(u || '').toLowerCase();
    if (lower.indexOf('.m3u8') !== -1) return 'hls';
    if (lower.indexOf('.mpd') !== -1) return 'dash';
    if (/\\.(mp4|webm|m4v|mov|ogg)(\\?|$)/i.test(lower)) return 'video';
    return null;
  }

  function unwrapProxiedUrl(u) {
    if (!u || typeof u !== 'string') return '';
    try {
      var parsed = new URL(u, window.location.origin);
      if (
        (parsed.pathname === '/api/proxy' ||
          parsed.pathname === '/api/browser' ||
          parsed.pathname === '/api/browser/asset') &&
        parsed.searchParams.get('url')
      ) {
        return parsed.searchParams.get('url') || u;
      }
    } catch (e) {}
    return u;
  }

  function resolveAgainstPage(raw) {
    if (!raw || typeof raw !== 'string') return '';
    var cleaned = unwrapProxiedUrl(raw.trim());
    if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:') || cleaned.startsWith('javascript:')) return '';
    try {
      return new URL(cleaned, CURRENT_URL).toString();
    } catch (e) {
      return '';
    }
  }

  function registerStream(rawUrl, label, forcedType) {
    var abs = resolveAgainstPage(rawUrl);
    if (!abs || isPreview(abs)) return;
    var st = forcedType || detectStreamType(abs);
    if (!st) return;
    if (!discoveredMap[abs]) {
      discoveredMap[abs] = {
        label: label || (st === 'hls' ? 'HLS' : st === 'dash' ? 'DASH' : 'MP4'),
        url: abs,
        streamType: st
      };
      emitStreams();
    }
  }

  function emitStreams() {
    var list = Object.keys(discoveredMap).map(function(k) { return discoveredMap[k]; });
    post('telabox:streams', {
      url: CURRENT_URL,
      title: document.title || PAGE_TITLE,
      streams: list
    });
  }

  if (Array.isArray(META.initialStreams)) {
    for (var i = 0; i < META.initialStreams.length; i++) {
      var s = META.initialStreams[i];
      if (s && s.url) {
        discoveredMap[s.url] = s;
      }
    }
  }

  post('telabox:page', {
    url: CURRENT_URL,
    title: PAGE_TITLE,
    streams: Object.keys(discoveredMap).map(function(k) { return discoveredMap[k]; })
  });

  // Block external popups/new tabs; route valid URLs inside the internal browser
  window.open = function(url) {
    var abs = resolveAgainstPage(url);
    if (abs && /^https?:\\/\\//i.test(abs) && !/doubleclick|popads|exoclick|trafficjunky|juicyads|adsterra/i.test(abs)) {
      window.location.href = '/api/browser?url=' + encodeURIComponent(abs);
    }
    return null;
  };

  // Rewrite fetch() inside proxied page to stay CORS-free & sniff streams
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      try {
        var raw = typeof input === 'string' ? input : (input && input.url) || '';
        var real = unwrapProxiedUrl(raw);
        if (real && !raw.startsWith('/api/') && !raw.startsWith('/vendor/') && !raw.startsWith('data:') && !raw.startsWith('blob:')) {
          var abs = resolveAgainstPage(real);
          if (abs && /^https?:\\/\\//i.test(abs)) {
            registerStream(abs);
            var proxied = '/api/browser/asset?url=' + encodeURIComponent(abs) + '&referer=' + encodeURIComponent(CURRENT_URL);
            if (typeof input === 'string') {
              input = proxied;
            } else if (input && typeof Request !== 'undefined') {
              input = new Request(proxied, input);
            }
          }
        } else if (real) {
          registerStream(real);
        }
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }

  // Rewrite XMLHttpRequest inside proxied page & sniff streams
  var origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (typeof url === 'string') {
        var real = unwrapProxiedUrl(url);
        if (real && !url.startsWith('/api/') && !url.startsWith('/vendor/') && !url.startsWith('data:') && !url.startsWith('blob:')) {
          var abs = resolveAgainstPage(real);
          if (abs && /^https?:\\/\\//i.test(abs)) {
            registerStream(abs);
            arguments[1] = '/api/browser/asset?url=' + encodeURIComponent(abs) + '&referer=' + encodeURIComponent(CURRENT_URL);
          }
        } else if (real) {
          registerStream(real);
        }
      }
    } catch (e) {}
    return origXhrOpen.apply(this, arguments);
  };

  // Attach bundled Hls.js automatically to any <video> trying to play .m3u8 inside the browser
  function attachHlsToVideo(videoEl, rawSrc) {
    var abs = resolveAgainstPage(rawSrc);
    if (!abs) return false;
    registerStream(abs, 'HLS', 'hls');
    var proxiedM3u8 = '/api/proxy?url=' + encodeURIComponent(abs) + '&referer=' + encodeURIComponent(CURRENT_URL);
    if (window.Hls && window.Hls.isSupported()) {
      try {
        if (videoEl.__telaboxHls) {
          videoEl.__telaboxHls.destroy();
        }
        var hls = new window.Hls({ enableWorker: true, maxBufferLength: 20 });
        videoEl.__telaboxHls = hls;
        hls.loadSource(proxiedM3u8);
        hls.attachMedia(videoEl);
        return true;
      } catch (e) {}
    }
    return false;
  }

  // Intercept HTMLMediaElement src property & setAttribute for independent HLS/MP4 playback
  try {
    var mediaDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (mediaDesc && mediaDesc.set && mediaDesc.get) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        get: function() { return mediaDesc.get.call(this); },
        set: function(val) {
          if (typeof val === 'string' && val && !val.startsWith('blob:') && !val.startsWith('data:')) {
            var abs = resolveAgainstPage(val);
            if (abs) {
              registerStream(abs);
              if (abs.toLowerCase().indexOf('.m3u8') !== -1 && attachHlsToVideo(this, abs)) {
                return;
              }
              if (!val.startsWith('/api/')) {
                val = '/api/proxy?url=' + encodeURIComponent(abs) + '&referer=' + encodeURIComponent(CURRENT_URL);
              }
            }
          }
          return mediaDesc.set.call(this, val);
        }
      });
    }
  } catch (e) {}

  function scanMediaDom() {
    var nodes = document.querySelectorAll('video, video source');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var s = el.getAttribute('src') || el.src;
      if (s && !s.startsWith('blob:') && !s.startsWith('data:')) {
        var abs = resolveAgainstPage(s);
        if (abs) {
          registerStream(abs);
          if (el.tagName === 'VIDEO' && abs.toLowerCase().indexOf('.m3u8') !== -1 && !el.__telaboxHls) {
            attachHlsToVideo(el, abs);
          }
        }
      }
    }
  }

  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    if (href.startsWith('/api/browser')) return;
    var abs = resolveAgainstPage(a.getAttribute('data-telabox-href') || href);
    if (abs && /^https?:\\/\\//i.test(abs)) {
      e.preventDefault();
      window.location.href = '/api/browser?url=' + encodeURIComponent(abs);
    }
  }, true);

  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    var origAction = form.getAttribute('data-telabox-action') || form.getAttribute('action') || CURRENT_URL;
    var absAction = resolveAgainstPage(origAction) || CURRENT_URL;
    if (method === 'get') {
      e.preventDefault();
      try {
        var target = new URL(absAction);
        var fd = new FormData(form);
        fd.forEach(function(value, key) {
          if (typeof value === 'string') {
            target.searchParams.set(key, value);
          }
        });
        window.location.href = '/api/browser?url=' + encodeURIComponent(target.toString());
      } catch (err) {}
    } else {
      form.setAttribute('action', '/api/browser?url=' + encodeURIComponent(absAction));
      form.setAttribute('target', '_self');
    }
  }, true);

  document.addEventListener('play', function(e) {
    var v = e.target;
    if (v && v.tagName === 'VIDEO') {
      var s = v.currentSrc || v.src || '';
      if (s && !s.startsWith('blob:')) {
        registerStream(s);
      }
    }
  }, true);

  document.addEventListener('DOMContentLoaded', function() {
    scanMediaDom();
    if (document.title && document.title !== PAGE_TITLE) {
      PAGE_TITLE = document.title;
      post('telabox:title', { url: CURRENT_URL, title: PAGE_TITLE });
    }
    var obs = new MutationObserver(function() { scanMediaDom(); });
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }
  });
})();
</script>`.trim();
}

async function fetchBrowserUpstream(
  targetUrl: string,
  req: Request,
  refererOverride?: string
): Promise<globalThis.Response> {
  const parsed = new URL(targetUrl);
  const referer = refererOverride || parsed.origin + '/';
  const headers: Record<string, string> = {
    ...buildPortalHeaders(targetUrl, getCookiesForUrl(targetUrl), referer),
    'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'User-Agent': BROWSER_USER_AGENT,
  };

  if (req.method === 'POST') {
    headers['Origin'] = parsed.origin;
    if (typeof req.headers['content-type'] === 'string') {
      headers['Content-Type'] = req.headers['content-type'];
    }
  }
  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }

  let body: BodyInit | undefined;
  if (req.method === 'POST' && req.body) {
    if (typeof req.body === 'string') {
      body = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      body = new Uint8Array(req.body);
    } else if (typeof req.body === 'object') {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/x-www-form-urlencoded')) {
        body = new URLSearchParams(req.body as Record<string, string>).toString();
      } else {
        body = JSON.stringify(req.body);
      }
    }
  }

  const upstream = await fetch(targetUrl, {
    method: req.method === 'POST' ? 'POST' : 'GET',
    headers,
    body,
    redirect: 'follow',
  });
  storeCookiesFromResponse(upstream.url || targetUrl, upstream);
  return upstream;
}

function sendSafeUpstreamHeaders(res: Response, upstream: globalThis.Response): void {
  res.status(upstream.status);
  const hasEncoding = Boolean(upstream.headers.get('content-encoding'));
  const allowed = hasEncoding
    ? ['content-type', 'content-range', 'accept-ranges', 'cache-control']
    : ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
  for (const h of allowed) {
    const val = upstream.headers.get(h);
    if (val) res.setHeader(h, val);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
}

export function registerBrowserProxyRoutes(app: Express, port: number): void {
  // Serve bundled hls.min.js locally so the internal browser never needs extensions or external CDNs
  app.get('/vendor/hls.min.js', (_req, res) => {
    const hlsPath = path.resolve(process.cwd(), 'node_modules/hls.js/dist/hls.min.js');
    res.sendFile(hlsPath);
  });

  // Internal Browser page renderer (strips frame blocks, rewrites links/assets, injects HLS & stream sniffer bridge)
  const handleBrowserPage = async (req: Request, res: Response) => {
    const rawTarget = String(req.query.url || '');
    if (!rawTarget) {
      res.status(400).send('Parâmetro url ausente.');
      return;
    }

    try {
      const localBaseUrl = `http://127.0.0.1:${port}`;
      const targetUrl = normalizeTargetUrl(rawTarget, localBaseUrl);
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.status(400).send('Protocolo não suportado.');
        return;
      }

      const upstream = await fetchBrowserUpstream(targetUrl, req);
      const finalUrl = upstream.url || targetUrl;
      const contentType = (upstream.headers.get('content-type') || '').toLowerCase();

      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        if (contentType.includes('text/css')) {
          const css = await upstream.text();
          res.status(upstream.status);
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.send(rewriteCssUrls(css, finalUrl, finalUrl));
          return;
        }
        sendSafeUpstreamHeaders(res, upstream);
        if (upstream.body) {
          const nodeStream = Readable.fromWeb(
            upstream.body as Parameters<typeof Readable.fromWeb>[0]
          );
          nodeStream.pipe(res);
        } else {
          res.end();
        }
        return;
      }

      const html = await upstream.text();
      let initialStreams: QualityOption[] = [];
      let extractedTitle = '';
      try {
        const resolved = await extractStreamsFromHtml(html, finalUrl);
        initialStreams = resolved.qualities || [];
        extractedTitle = resolved.title || '';
      } catch {
        // page might be a catalog or search page without direct stream yet
      }

      const $ = cheerio.load(html);
      const pageTitle = extractedTitle || $('title').first().text().trim() || finalUrl;

      // Remove frame-blocking meta tags & <base> that would bypass our proxy
      $('meta[http-equiv="Content-Security-Policy"]').remove();
      $('meta[http-equiv="content-security-policy"]').remove();
      $('meta[http-equiv="X-Frame-Options"]').remove();
      $('base').remove();

      const refParam = `&referer=${encodeURIComponent(finalUrl)}`;

      // Rewrite hyperlinks to keep navigation inside the internal browser
      $('a[href]').each((_, el) => {
        const raw = $(el).attr('href');
        if (!raw || isSkippableUri(raw)) return;
        const abs = toAbsUrl(raw, finalUrl);
        if (!abs) return;
        $(el).attr('data-telabox-href', abs);
        $(el).attr('href', `/api/browser?url=${encodeURIComponent(abs)}`);
        $(el).attr('target', '_self');
      });

      // Rewrite forms
      $('form').each((_, el) => {
        const rawAction = $(el).attr('action') || finalUrl;
        const abs = toAbsUrl(rawAction, finalUrl) || finalUrl;
        $(el).attr('data-telabox-action', abs);
        $(el).attr('action', `/api/browser?url=${encodeURIComponent(abs)}`);
        $(el).attr('target', '_self');
      });

      // Rewrite media/images/posters/tracks through /api/proxy
      $('img, source, video, track').each((_, el) => {
        for (const attr of ['src', 'poster', 'data-src', 'data-thumb', 'data-original', 'data-lazy-src']) {
          const raw = $(el).attr(attr);
          if (!raw || isSkippableUri(raw) || raw.startsWith('/api/')) continue;
          const abs = toAbsUrl(raw, finalUrl);
          if (!abs) continue;
          if (attr === 'src' && $(el).is('video, source') && abs.toLowerCase().includes('.m3u8')) {
            // Keep real URL so our injected Hls.js bridge can attach cleanly
            $(el).attr(attr, abs);
          } else {
            $(el).attr(attr, `/api/proxy?url=${encodeURIComponent(abs)}${refParam}`);
          }
        }
        const srcset = $(el).attr('srcset');
        if (srcset) {
          const rewrittenSet = srcset
            .split(',')
            .map((part) => {
              const trimmed = part.trim();
              if (!trimmed) return '';
              const [u, desc] = trimmed.split(/\s+/, 2);
              const abs = toAbsUrl(u, finalUrl);
              if (!abs) return trimmed;
              const proxied = `/api/proxy?url=${encodeURIComponent(abs)}${refParam}`;
              return desc ? `${proxied} ${desc}` : proxied;
            })
            .filter(Boolean)
            .join(', ');
          if (rewrittenSet) $(el).attr('srcset', rewrittenSet);
        }
      });

      // Rewrite nested iframes to also stay proxied inside internal browser
      $('iframe[src]').each((_, el) => {
        const raw = $(el).attr('src');
        if (!raw || isSkippableUri(raw) || raw.startsWith('/api/')) return;
        const abs = toAbsUrl(raw, finalUrl);
        if (abs) {
          $(el).attr('src', `/api/browser?url=${encodeURIComponent(abs)}`);
        }
      });

      // Rewrite stylesheets & scripts through /api/browser/asset and strip SRI/crossorigin locks
      $('link[href]').each((_, el) => {
        const rel = ($(el).attr('rel') || '').toLowerCase();
        const raw = $(el).attr('href');
        if (!raw || isSkippableUri(raw) || raw.startsWith('/api/')) return;
        if (rel.includes('stylesheet') || rel.includes('icon') || rel.includes('preload')) {
          const abs = toAbsUrl(raw, finalUrl);
          if (abs) {
            $(el).attr('href', `/api/browser/asset?url=${encodeURIComponent(abs)}${refParam}`);
            $(el).removeAttr('integrity');
            $(el).removeAttr('crossorigin');
          }
        }
      });

      $('script[src]').each((_, el) => {
        const raw = $(el).attr('src');
        if (!raw || isSkippableUri(raw) || raw.startsWith('/api/') || raw.startsWith('/vendor/')) return;
        const abs = toAbsUrl(raw, finalUrl);
        if (abs) {
          $(el).attr('src', `/api/browser/asset?url=${encodeURIComponent(abs)}${refParam}`);
          $(el).removeAttr('integrity');
          $(el).removeAttr('crossorigin');
          $(el).removeAttr('nonce');
        }
      });

      $('style').each((_, el) => {
        const css = $(el).html();
        if (css) {
          $(el).html(rewriteCssUrls(css, finalUrl, finalUrl));
        }
      });

      const isBlocked =
        upstream.status === 403 ||
        upstream.status === 429 ||
        upstream.status === 503 ||
        (/cf-browser-verification|__cf_chl_|Just a moment\.\.\.|Attention Required!\s*\|\s*Cloudflare/i.test(
          html
        ) &&
          !html.includes('window.initials') &&
          !html.includes('flashvars_'));

      const bridgeHtml =
        `<script src="/vendor/hls.min.js"></script>\n` +
        buildBridgeScript({ finalUrl, pageTitle, initialStreams, blocked: isBlocked });

      if ($('head').length > 0) {
        $('head').prepend(bridgeHtml);
      } else {
        $.root().prepend(`<head>${bridgeHtml}</head>`);
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.send($.html());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar página no navegador interno.';
      res.status(502).send(
        `<!doctype html><html lang="pt-BR"><body style="background:#090A0F;color:#e2e8f0;font-family:sans-serif;padding:40px;text-align:center;">
          <h2 style="margin-bottom:8px;">Não foi possível carregar esta página</h2>
          <p style="color:#94a3b8;font-size:14px;">${msg.replace(/</g, '&lt;')}</p>
        </body></html>`
      );
    }
  };

  app.get('/api/browser', handleBrowserPage);
  app.post('/api/browser', express.urlencoded({ extended: true }), handleBrowserPage);

  // Asset/API proxy for CSS, JS, fonts, and XHR/fetch requests made inside the internal browser
  const handleBrowserAsset = async (req: Request, res: Response) => {
    const rawTarget = String(req.query.url || '');
    const rawReferer = typeof req.query.referer === 'string' ? req.query.referer : '';
    if (!rawTarget) {
      res.status(400).send('Parâmetro url ausente.');
      return;
    }

    try {
      const localBaseUrl = `http://127.0.0.1:${port}`;
      const targetUrl = normalizeTargetUrl(rawTarget, localBaseUrl);
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        res.status(400).send('Protocolo não suportado.');
        return;
      }

      const upstream = await fetchBrowserUpstream(targetUrl, req, rawReferer || undefined);
      const finalUrl = upstream.url || targetUrl;
      const contentType = (upstream.headers.get('content-type') || '').toLowerCase();

      if (contentType.includes('text/css') || finalUrl.toLowerCase().split('?')[0].endsWith('.css')) {
        const css = await upstream.text();
        res.status(upstream.status);
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewriteCssUrls(css, finalUrl, rawReferer || finalUrl));
        return;
      }

      sendSafeUpstreamHeaders(res, upstream);
      if (upstream.body) {
        const nodeStream = Readable.fromWeb(
          upstream.body as Parameters<typeof Readable.fromWeb>[0]
        );
        nodeStream.on('error', () => {
          if (!res.headersSent) res.status(502).end();
        });
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({
          error: err instanceof Error ? err.message : 'Erro ao carregar recurso do navegador interno.',
        });
      }
    }
  };

  app.get('/api/browser/asset', handleBrowserAsset);
  app.post('/api/browser/asset', express.urlencoded({ extended: true }), handleBrowserAsset);
}
