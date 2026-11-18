import * as cheerio from 'cheerio';
import type { QualityOption } from '../src/types/media.ts';
import { toOfficialEmbedUrl } from '../src/utils/embedUrl.ts';

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Common age-gate, consent & session cookies used across adult & media portals
export const DEFAULT_PORTAL_COOKIES =
  'accessAgeDisclaimerPH=1; accessAgeDisclaimerRT=1; platform=pc; age_verified=1; over18=1; ageGate=1; xh_age_gate=1; consent=yes; cookie_consent=1; cookiesAccepted=1; disclaimer=1; avs=1; video_lang=pt';

export function getPortalRootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname.toLowerCase();
}

export function buildPortalHeaders(
  targetUrl: string,
  extraCookie?: string,
  refererOverride?: string,
  fetchSite: 'same-origin' | 'cross-site' | 'none' = 'same-origin'
): Record<string, string> {
  let referer = refererOverride || targetUrl;
  if (!refererOverride) {
    try {
      referer = new URL(targetUrl).origin + '/';
    } catch {
      // keep targetUrl
    }
  }

  const cookie = extraCookie
    ? `${DEFAULT_PORTAL_COOKIES}; ${extraCookie}`
    : DEFAULT_PORTAL_COOKIES;

  return {
    'User-Agent': BROWSER_USER_AGENT,
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'max-age=0',
    'Cookie': cookie,
    'Referer': referer,
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': fetchSite,
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

export interface ResolvedStreamResult {
  streamUrl: string;
  streamType: 'hls' | 'dash' | 'video' | 'embed';
  referer: string;
  userAgent?: string;
  title?: string;
  thumbnail?: string;
  qualities: QualityOption[];
  embedFallbackUrl?: string;
  fallbackMode?: 'embed' | 'page';
  fallbackReason?: string;
  directBlocked?: boolean;
}

function isAv1Stream(label: string, url?: string): boolean {
  return /\bav1\b/i.test(label) || Boolean(url && /\.av1\b/i.test(url));
}

function isPreviewClipUrl(urlStr: string): boolean {
  return /thumb-v\d*\.|\.t\.(?:av1\.)?mp4|\/previews?\/|\/trailers?\/|sprite/i.test(urlStr);
}

function parseQualityScore(label: string, url?: string): number {
  let base = 0;
  const cleanedLabel = label.replace(/\bav1\b/gi, '').replace(/\bh\.?264\b/gi, '');
  const pMatch = cleanedLabel.match(/(\d{3,4})\s*p/i);
  const numMatch = pMatch || cleanedLabel.match(/\b(\d{3,4})\b/);
  const num = numMatch ? parseInt(numMatch[1], 10) : NaN;

  if (Number.isFinite(num) && num > 0) base = num;
  else if (/4k|uhd/i.test(cleanedLabel)) base = 2160;
  else if (/fhd/i.test(cleanedLabel)) base = 1080;
  else if (url && /mp4_sd|low/i.test(url)) base = 360;
  else if (/hd/i.test(cleanedLabel)) base = 720;
  else if (/sd/i.test(cleanedLabel)) base = 360;

  // Strongly prefer universally supported H.264 over AV1 for TV Box / cross-browser compatibility
  if (isAv1Stream(label, url)) {
    return Math.max(1, base - 5000);
  }
  return base;
}

function unescapeJsUrl(raw: string): string {
  return raw
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\x26/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/&amp;/g, '&')
    .trim();
}

function safeResolve(urlStr: string, base: string): string | null {
  try {
    const cleaned = unescapeJsUrl(urlStr);
    if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return null;
    return new URL(cleaned, base).toString();
  } catch {
    return null;
  }
}

function decodeXhamsterHexCipher(hex: string): string | null {
  if (
    typeof hex !== 'string' ||
    hex.length < 12 ||
    (hex.length & 1) !== 0 ||
    !/^[0-9a-fA-F]+$/.test(hex)
  ) {
    return null;
  }

  const bytes = new Array<number>(hex.length >> 1);
  for (let s = 0, n = 0; s < hex.length; s += 2) {
    bytes[n++] = parseInt(hex.substring(s, s + 2), 16);
  }
  if (bytes.length < 5) return null;

  const algo = bytes[0] | 0;
  if (algo < 1 || algo > 7) return null;

  let state = (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) | 0;
  const nextByte = (): number => {
    if (algo === 1) {
      state = (Math.imul(state, 1664525) + 0x3c6ef35f) | 0;
      return state & 255;
    }
    if (algo === 2) {
      state |= 0;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state |= 0;
      return state & 255;
    }
    if (algo === 3) {
      let e = (state = (state + 0x9e3779b9) | 0);
      e ^= e >>> 16;
      e = Math.imul(e, 0x85ebca77) | 0;
      e ^= e >>> 13;
      e = Math.imul(e, 0xc2b2ae3d) | 0;
      return (e ^ (e >>> 16)) & 255;
    }
    if (algo === 4) {
      let e = ((state = (state + 0x6d2b79f5) | 0) << 7) | (state >>> 25);
      e = (e + 0x9e3779b9) | 0;
      e ^= e >>> 11;
      e = Math.imul(e, 0x27d4eb2d) | 0;
      return e & 255;
    }
    if (algo === 5) {
      state |= 0;
      state ^= state << 7;
      state ^= state >>> 9;
      state ^= state << 8;
      state = (state + 0xa5a5a5a5) | 0;
      return state & 255;
    }
    if (algo === 6) {
      state = (Math.imul(state, 0x2c9277b5) + 0xac564b05) | 0;
      return ((state ^ (state >>> 18)) >>> ((state >>> 27) & 31)) & 255;
    }
    if (algo === 7) {
      let e = (state = (state + 0x9e3779b9) | 0) ^ (state << 5);
      e = Math.imul(e, 0x7feb352d) | 0;
      e ^= e >>> 15;
      e = Math.imul(e, 0x846ca68b) | 0;
      return e & 255;
    }
    return 0;
  };

  const out = new Array<number>(bytes.length - 5);
  for (let l = 5, a = 0; l < bytes.length; l++, a++) {
    out[a] = (bytes[l] ^ nextByte()) & 255;
  }

  let pct = '';
  for (let i = 0; i < out.length; i++) {
    pct += '%' + out[i].toString(16).padStart(2, '0');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pct);
  } catch {
    decoded = String.fromCharCode(...out);
  }
  return /^[\x20-\x7E]+$/.test(decoded) ? decoded : null;
}

function decodeXhamsterUrl(raw: string): string {
  if (typeof raw !== 'string' || !raw.length) return raw;
  const direct = decodeXhamsterHexCipher(raw);
  if (direct !== null) return direct;

  const protoIdx = raw.indexOf('://');
  const slashIdx = protoIdx !== -1 ? raw.indexOf('/', protoIdx + 3) : raw.indexOf('/');
  if (slashIdx === -1) return raw;
  const start = slashIdx + 1;
  if (start >= raw.length) return raw;
  const nextSlash = raw.indexOf('/', start);
  const nextComma = raw.indexOf(',', start);
  const end =
    nextSlash !== -1 && nextComma !== -1
      ? Math.min(nextSlash, nextComma)
      : nextSlash !== -1
      ? nextSlash
      : nextComma;
  if (end === -1 || end <= start) return raw;
  const sub = decodeXhamsterHexCipher(raw.substring(start, end));
  return sub !== null ? raw.substring(0, start) + sub + raw.substring(end) : raw;
}

function applyXhamsterHostMap(
  urlStr: string,
  hostKey: string,
  hostMap?: Record<string, string> | null
): string {
  const sub = hostMap?.[hostKey];
  if (!urlStr || !sub || typeof sub !== 'string') return urlStr;
  const isProtoRel = urlStr.startsWith('//');
  try {
    const u = new URL(isProtoRel ? `https:${urlStr}` : urlStr);
    const parts = u.hostname.split('.');
    if (parts.length < 2) return urlStr;
    parts[0] = sub;
    u.hostname = parts.join('.');
    const next = u.toString();
    return isProtoRel ? next.replace(/^https:/, '') : next;
  } catch {
    return urlStr;
  }
}

function extractBalancedJsonAfter(text: string, pattern: RegExp): Record<string, unknown> | null {
  const m = pattern.exec(text);
  if (!m) return null;
  const startIdx = m.index + m[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(startIdx, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function mergeCookieStrings(existing: string | undefined, incomingPairs: string[]): string {
  const map = new Map<string, string>();
  const parseIntoMap = (raw: string) => {
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) map.set(k, v);
      }
    }
  };
  if (existing) parseIntoMap(existing);
  for (const pair of incomingPairs) parseIntoMap(pair);
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function captureResponseCookies(
  urlStr: string,
  res: Response,
  cookieJar: Map<string, string>
): void {
  const setCookies = res.headers.getSetCookie?.() || [];
  if (setCookies.length === 0) return;
  const pairs = setCookies.map((c) => c.split(';')[0]).filter(Boolean);
  if (pairs.length === 0) return;
  const parsed = new URL(urlStr);
  const rootKey = getPortalRootDomain(parsed.hostname);
  const merged = mergeCookieStrings(cookieJar.get(rootKey) || cookieJar.get(parsed.origin), pairs);
  cookieJar.set(rootKey, merged);
  cookieJar.set(parsed.origin, merged);
}

function isAntiBotChallenge(status: number, htmlSnippet: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!htmlSnippet) return false;
  return (
    /cf-browser-verification|__cf_chl_|Just a moment\.\.\.|Attention Required!\s*\|\s*Cloudflare|Enable JavaScript and cookies to continue|verify you are human|Checking your browser/i.test(
      htmlSnippet
    ) && !htmlSnippet.includes('window.initials') && !htmlSnippet.includes('flashvars_')
  );
}

export function deriveEmbedUrlFromPage(
  pageUrl: string,
  $?: cheerio.CheerioAPI,
  html?: string
): string | null {
  const knownOfficialEmbed = toOfficialEmbedUrl(pageUrl);
  if (knownOfficialEmbed) {
    return knownOfficialEmbed;
  }

  if ($) {
    const metaEmbed =
      $('meta[name="twitter:player"]').attr('content') ||
      $('meta[property="og:video:iframe"]').attr('content');
    if (metaEmbed) {
      const resolved = safeResolve(metaEmbed, pageUrl);
      if (resolved && resolved !== pageUrl) {
        return toOfficialEmbedUrl(resolved) || resolved;
      }
    }

    const iframeEl = $(
      'iframe[src*="embed"], iframe[src*="player"], iframe[src*="video"], iframe[data-src*="embed"], iframe[data-src*="player"]'
    ).first();
    const iframeSrc = iframeEl.attr('src') || iframeEl.attr('data-src');
    if (iframeSrc) {
      const resolved = safeResolve(iframeSrc, pageUrl);
      if (resolved && resolved !== pageUrl) {
        return toOfficialEmbedUrl(resolved) || resolved;
      }
    }
  }

  if (html) {
    const jsonLdEmbed = html.match(/"embedUrl"\s*:\s*"([^"]+)"/i);
    if (jsonLdEmbed) {
      const resolved = safeResolve(jsonLdEmbed[1], pageUrl);
      if (resolved && resolved !== pageUrl) {
        return toOfficialEmbedUrl(resolved) || resolved;
      }
    }
  }

  return null;
}

export async function fetchWithPortalCookies(
  targetUrl: string,
  cookieJar: Map<string, string>,
  timeoutMs = 14000
): Promise<Response> {
  const parsed = new URL(targetUrl);
  const origin = parsed.origin;
  const rootKey = getPortalRootDomain(parsed.hostname);
  const jarCookie = cookieJar.get(rootKey) || cookieJar.get(origin);
  const headers = buildPortalHeaders(targetUrl, jarCookie, origin + '/', 'same-origin');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(targetUrl, { headers, signal: controller.signal, redirect: 'follow' });
    captureResponseCookies(res.url || targetUrl, res, cookieJar);

    // Handle lightweight document.cookie JS redirect gates
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && contentType.includes('text/html')) {
      const cloneText = await res.clone().text();
      if (cloneText.length < 5000 && /document\.cookie\s*=/.test(cloneText)) {
        const cookieMatches = [...cloneText.matchAll(/document\.cookie\s*=\s*["']([^"';]+)/g)];
        if (cookieMatches.length > 0) {
          const jsCookies = cookieMatches.map((m) => m[1]);
          const merged = mergeCookieStrings(
            cookieJar.get(rootKey) || cookieJar.get(origin),
            jsCookies
          );
          cookieJar.set(rootKey, merged);
          cookieJar.set(origin, merged);
          res = await fetch(targetUrl, {
            headers: buildPortalHeaders(targetUrl, merged, origin + '/', 'same-origin'),
            signal: controller.signal,
            redirect: 'follow',
          });
          captureResponseCookies(res.url || targetUrl, res, cookieJar);
        }
      }
    }

    // Session warm-up retry if anti-bot / Cloudflare challenge or HTTP 403/429/503 encountered
    const peekText =
      res.ok && contentType.includes('text/html') ? (await res.clone().text()).slice(0, 6000) : '';
    if (isAntiBotChallenge(res.status, peekText)) {
      try {
        const warmRes = await fetch(origin + '/', {
          headers: buildPortalHeaders(
            origin + '/',
            cookieJar.get(rootKey) || cookieJar.get(origin),
            'https://www.google.com/',
            'cross-site'
          ),
          signal: controller.signal,
          redirect: 'follow',
        });
        captureResponseCookies(warmRes.url || origin + '/', warmRes, cookieJar);
        const warmedCookie = cookieJar.get(rootKey) || cookieJar.get(origin);
        res = await fetch(targetUrl, {
          headers: buildPortalHeaders(targetUrl, warmedCookie, origin + '/', 'same-origin'),
          signal: controller.signal,
          redirect: 'follow',
        });
        captureResponseCookies(res.url || targetUrl, res, cookieJar);
      } catch {
        // keep original response if warm-up fails
      }
    }

    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveVideoPageStream(
  watchPageUrl: string,
  depth = 0
): Promise<ResolvedStreamResult> {
  const cookieJar = new Map<string, string>();
  let res: Response;
  try {
    res = await fetchWithPortalCookies(watchPageUrl, cookieJar, 15000);
  } catch (err) {
    if (depth > 0) {
      throw err instanceof Error ? err : new Error('Erro ao abrir página do vídeo.');
    }
    const derivedEmbed = deriveEmbedUrlFromPage(watchPageUrl);
    return {
      streamUrl: derivedEmbed || watchPageUrl,
      streamType: 'embed',
      referer: watchPageUrl,
      qualities: [],
      embedFallbackUrl: derivedEmbed || watchPageUrl,
      fallbackMode: derivedEmbed ? 'embed' : 'page',
      fallbackReason:
        err instanceof Error ? err.message : 'Conexão direta bloqueada; abrindo em modo navegador.',
      directBlocked: true,
    };
  }

  const finalUrl = res.url || watchPageUrl;
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (!res.ok) {
    if (depth > 0) {
      throw new Error(`Servidor retornou HTTP ${res.status} ao abrir a página do vídeo.`);
    }
    const errHtml = contentType.includes('text/html') ? await res.text().catch(() => '') : '';
    const $err = errHtml ? cheerio.load(errHtml) : undefined;
    const derivedEmbed = deriveEmbedUrlFromPage(finalUrl, $err, errHtml);
    return {
      streamUrl: derivedEmbed || finalUrl,
      streamType: 'embed',
      referer: finalUrl,
      qualities: [],
      embedFallbackUrl: derivedEmbed || finalUrl,
      fallbackMode: derivedEmbed ? 'embed' : 'page',
      fallbackReason: `Servidor retornou HTTP ${res.status} (proteção anti-bot/Cloudflare). Abrindo em tela cheia integrada.`,
      directBlocked: true,
    };
  }

  // If URL already points directly to a video, HLS, or DASH stream
  if (contentType.startsWith('video/') || /\.mp4(\?|$)/i.test(finalUrl)) {
    return {
      streamUrl: finalUrl,
      streamType: 'video',
      referer: finalUrl,
      userAgent: BROWSER_USER_AGENT,
      qualities: [{ label: 'Original', url: finalUrl, streamType: 'video' }],
      embedFallbackUrl: finalUrl,
    };
  }
  if (contentType.includes('mpegurl') || /\.m3u8(\?|$)/i.test(finalUrl)) {
    return {
      streamUrl: finalUrl,
      streamType: 'hls',
      referer: finalUrl,
      userAgent: BROWSER_USER_AGENT,
      qualities: [{ label: 'HLS', url: finalUrl, streamType: 'hls' }],
      embedFallbackUrl: finalUrl,
    };
  }
  if (contentType.includes('dash+xml') || /\.mpd(\?|$)/i.test(finalUrl)) {
    return {
      streamUrl: finalUrl,
      streamType: 'dash',
      referer: finalUrl,
      userAgent: BROWSER_USER_AGENT,
      qualities: [{ label: 'DASH', url: finalUrl, streamType: 'dash' }],
      embedFallbackUrl: finalUrl,
    };
  }

  let html = await res.text();

  // If HTML still appears to be an anti-bot page without window.initials, try one more time with clean mobile/alternate Referer + session cookies
  if (isAntiBotChallenge(res.status, html) && depth === 0) {
    try {
      const parsed = new URL(finalUrl);
      const rootKey = getPortalRootDomain(parsed.hostname);
      const retryRes = await fetch(finalUrl, {
        headers: buildPortalHeaders(
          finalUrl,
          cookieJar.get(rootKey) || cookieJar.get(parsed.origin),
          finalUrl,
          'same-origin'
        ),
        redirect: 'follow',
      });
      if (retryRes.ok) {
        html = await retryRes.text();
      }
    } catch {
      // ignore retry failure
    }
  }

  return extractStreamsFromHtml(html, finalUrl, cookieJar, depth);
}

export async function extractStreamsFromHtml(
  html: string,
  finalUrl: string,
  cookieJar: Map<string, string> = new Map(),
  depth = 0
): Promise<ResolvedStreamResult> {
  const $ = cheerio.load(html);

  const pageTitle =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    undefined;
  const ogImage = $('meta[property="og:image"]').attr('content')?.trim();
  const thumbnail = ogImage ? safeResolve(ogImage, finalUrl) || undefined : undefined;

  const qualities: QualityOption[] = [];
  const seenUrls = new Set<string>();

  const pushQuality = (label: string, rawUrl: string, forcedType?: 'hls' | 'dash' | 'video') => {
    const resolved = safeResolve(rawUrl, finalUrl);
    if (!resolved || seenUrls.has(resolved)) return;
    if (isPreviewClipUrl(resolved)) return;
    seenUrls.add(resolved);
    const lower = resolved.toLowerCase();
    const isHls = forcedType === 'hls' || lower.includes('.m3u8') || /master\.m3u8/i.test(resolved);
    const isDash = forcedType === 'dash' || lower.includes('.mpd');
    const streamType: 'hls' | 'dash' | 'video' = isHls ? 'hls' : isDash ? 'dash' : 'video';
    qualities.push({
      label: label || (isHls ? 'HLS' : isDash ? 'DASH' : 'MP4'),
      url: resolved,
      streamType,
    });
  };

  // 1. Pornhub / Tube8 / RedTube flashvars JSON
  const flashvarsMatches = [...html.matchAll(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\});/g)];
  for (const match of flashvarsMatches) {
    try {
      const data = JSON.parse(match[1]) as {
        mediaDefinitions?: Array<{
          format?: string;
          videoUrl?: string;
          quality?: string | string[];
          remote?: boolean;
        }>;
      };
      if (Array.isArray(data.mediaDefinitions)) {
        for (const def of data.mediaDefinitions) {
          if (!def.videoUrl) continue;
          const qLabel = Array.isArray(def.quality)
            ? def.quality[0] || def.format || 'Auto'
            : String(def.quality || def.format || 'Auto');

          if (def.format === 'hls') {
            pushQuality(`${qLabel}p`.replace(/pp$/i, 'p'), def.videoUrl, 'hls');
          } else if (def.format === 'mp4') {
            if (def.remote && def.videoUrl.includes('get_media')) {
              // Fetch remote MP4 media definitions JSON
              try {
                const gmUrl = safeResolve(def.videoUrl, finalUrl);
                if (gmUrl) {
                  const gmRes = await fetchWithPortalCookies(gmUrl, cookieJar, 8000);
                  if (gmRes.ok) {
                    const gmText = await gmRes.text();
                    if (!gmText.trimStart().startsWith('<')) {
                      const gmJson = JSON.parse(gmText);
                      if (Array.isArray(gmJson)) {
                        for (const item of gmJson) {
                          if (item && typeof item.videoUrl === 'string' && item.videoUrl) {
                            const iq = String(item.quality || 'MP4');
                            pushQuality(`${iq}p`.replace(/pp$/i, 'p'), item.videoUrl, 'video');
                          }
                        }
                      }
                    }
                  }
                }
              } catch {
                // ignore remote get_media failure if HLS already exists
              }
            } else {
              pushQuality(`${qLabel}p`.replace(/pp$/i, 'p'), def.videoUrl, 'video');
            }
          }
        }
      }
    } catch {
      // ignore invalid JSON
    }
  }

  // 2. XVideos / XNXX html5player setters
  const hlsSetter = html.match(/html5player\.setVideoHLS\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (hlsSetter) pushQuality('HLS Auto', hlsSetter[1], 'hls');

  const highSetter = html.match(/html5player\.setVideoUrlHigh\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (highSetter) pushQuality('HD (MP4)', highSetter[1], 'video');

  const lowSetter = html.match(/html5player\.setVideoUrlLow\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (lowSetter) pushQuality('SD (MP4)', lowSetter[1], 'video');

  // 3. xHamster window.initials.xplayerSettings.sources (encrypted hex + hostMap)
  if (html.includes('window.initials')) {
    const initials = extractBalancedJsonAfter(html, /window\.initials\s*=\s*\{/);
    if (initials) {
      const hostMap =
        initials.hostMap && typeof initials.hostMap === 'object'
          ? (initials.hostMap as Record<string, string>)
          : undefined;
      const xplayerSettings = initials.xplayerSettings as
        | {
            sources?: {
              hls?: Record<string, { url?: string; fallback?: string }>;
              standard?: Record<
                string,
                Array<{ url?: string; fallback?: string; quality?: string; label?: string }>
              >;
            };
          }
        | undefined;
      const sources = xplayerSettings?.sources;
      if (sources) {
        // 3a. Prefer H.264 HLS adaptive stream first, then H.264 MP4s, then AV1 last
        const hlsMap = sources.hls || {};
        for (const codec of ['h264', 'av1', ...Object.keys(hlsMap).filter((c) => c !== 'h264' && c !== 'av1')]) {
          const entry = hlsMap[codec];
          if (!entry) continue;
          const codecTag = codec === 'av1' ? 'AV1' : 'H.264';
          if (entry.url) {
            const decoded = applyXhamsterHostMap(decodeXhamsterUrl(entry.url), `hls.${codec}`, hostMap);
            pushQuality(`HLS (${codecTag})`, decoded, 'hls');
          }
          if (entry.fallback) {
            const decodedFb = applyXhamsterHostMap(
              decodeXhamsterUrl(entry.fallback),
              `hls.${codec}.fallback`,
              hostMap
            );
            pushQuality(`HLS Backup (${codecTag})`, decodedFb, 'hls');
          }
        }

        // 3b. Standard MP4 qualities (H.264 first)
        const stdMap = sources.standard || {};
        for (const codec of ['h264', ...Object.keys(stdMap).filter((c) => c !== 'h264')]) {
          const list = stdMap[codec];
          if (!Array.isArray(list)) continue;
          const isAv1 = codec === 'av1';
          for (const item of list) {
            if (!item?.url) continue;
            const qKey = item.quality || item.label || 'auto';
            const decoded = applyXhamsterHostMap(
              decodeXhamsterUrl(item.url),
              `standard.${codec}.${qKey}.prime`,
              hostMap
            );
            const decodedFb = item.fallback
              ? applyXhamsterHostMap(
                  decodeXhamsterUrl(item.fallback),
                  `standard.${codec}.${qKey}.fallback`,
                  hostMap
                )
              : null;
            const isM3u8 = decoded.toLowerCase().includes('.m3u8');
            const labelBase =
              qKey === 'auto'
                ? isM3u8
                  ? `HLS Auto (${isAv1 ? 'AV1' : 'H.264'})`
                  : `Auto (${isAv1 ? 'AV1' : 'H.264'})`
                : isAv1
                ? `${qKey} (AV1)`
                : `${qKey} (MP4)`;
            pushQuality(labelBase, decoded, isM3u8 ? 'hls' : 'video');
            if (decodedFb && decodedFb !== decoded) {
              pushQuality(`${labelBase} Backup`, decodedFb, decodedFb.includes('.m3u8') ? 'hls' : 'video');
            }
          }
        }
      }
    }
  }

  // 4. Generic script patterns (sources / mp4File / hlsUrl)
  const scriptTexts = $('script')
    .map((_, el) => $(el).html() || '')
    .get()
    .join('\n');

  const labeledUrlPatterns: Array<{ re: RegExp; label: string; type?: 'hls' | 'video' }> = [
    { re: /["']hlsUrl["']\s*:\s*["'](https?:[^"']+)["']/gi, label: 'HLS', type: 'hls' },
    { re: /["']?1080p["']?\s*:\s*["'](https?:[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi, label: '1080p' },
    { re: /["']?720p["']?\s*:\s*["'](https?:[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi, label: '720p' },
    { re: /["']?480p["']?\s*:\s*["'](https?:[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi, label: '480p' },
    { re: /["'](?:file|video_url|mp4|src|contentUrl)["']\s*:\s*["'](https?:[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi, label: 'Stream' },
  ];

  for (const pat of labeledUrlPatterns) {
    for (const m of scriptTexts.matchAll(pat.re)) {
      pushQuality(pat.label, m[1], pat.type);
    }
  }

  // 5. <video> / <source> tags
  $('video source[src], video[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      const label = $(el).attr('label') || $(el).attr('res') || $(el).attr('title') || 'Video';
      pushQuality(label, src);
    }
  });

  // 6. OpenGraph og:video
  const ogVideo =
    $('meta[property="og:video:secure_url"]').attr('content') ||
    $('meta[property="og:video:url"]').attr('content') ||
    $('meta[property="og:video"]').attr('content');
  if (ogVideo && /\.(mp4|m3u8)/i.test(ogVideo)) {
    pushQuality('OG Video', ogVideo);
  }

  // 7. Generic fallback scan for any .m3u8, .mpd, or .mp4 URL in scripts/HTML
  if (qualities.length === 0) {
    const genericHls = [...html.matchAll(/https?:\\?\/\\?\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi)];
    for (const m of genericHls) {
      const rawUrl = m[0];
      // If xHamster only exposed an AV1 preload link in raw HTML, also try its H.264 sibling
      if (rawUrl.includes('.av1.mp4.m3u8')) {
        pushQuality('HLS (H.264)', rawUrl.replace('.av1.mp4.m3u8', '.h264.mp4.m3u8'), 'hls');
        pushQuality('HLS (AV1)', rawUrl, 'hls');
      } else {
        pushQuality('HLS', rawUrl, 'hls');
      }
    }
    const genericDash = [...html.matchAll(/https?:\\?\/\\?\/[^"'\s<>]+\.mpd[^"'\s<>]*/gi)];
    for (const m of genericDash) {
      pushQuality('DASH', m[0], 'dash');
    }
    const genericMp4 = [...scriptTexts.matchAll(/https?:\\?\/\\?\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi)];
    for (const m of genericMp4) {
      if (!isPreviewClipUrl(m[0])) {
        pushQuality('MP4', m[0], 'video');
      }
    }
  }

  // Sort qualities: prefer highest H.264 resolution first, AV1 last
  qualities.sort((a, b) => {
    const scoreDiff = parseQualityScore(b.label, b.url) - parseQualityScore(a.label, a.url);
    if (scoreDiff !== 0) return scoreDiff;
    if (a.streamType === 'hls' && b.streamType !== 'hls') return -1;
    if (b.streamType === 'hls' && a.streamType !== 'hls') return 1;
    return 0;
  });

  // Deduplicate and verify reachability (with Range GET fallback if HEAD is blocked)
  const verifiedQualities: QualityOption[] = [];
  await Promise.all(
    qualities.slice(0, 16).map(async (q) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        let checkRes = await fetch(q.url, {
          method: q.streamType === 'hls' ? 'GET' : 'HEAD',
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            'Referer': finalUrl,
          },
          signal: ctrl.signal,
        });
        if (q.streamType !== 'hls' && !checkRes.ok && checkRes.status !== 206) {
          checkRes = await fetch(q.url, {
            method: 'GET',
            headers: {
              'User-Agent': BROWSER_USER_AGENT,
              'Referer': finalUrl,
              'Range': 'bytes=0-1',
            },
            signal: ctrl.signal,
          });
        }
        clearTimeout(t);
        if (checkRes.ok || checkRes.status === 206) {
          const respCt = (checkRes.headers.get('content-type') || '').toLowerCase();
          if (respCt.includes('text/html') || respCt.includes('application/xhtml')) {
            return;
          }
          let updatedQ = q;
          if (q.streamType === 'hls') {
            const m3u8Text = await checkRes.text();
            if (!m3u8Text.includes('#EXTM3U')) return;
            const resMatches = [...m3u8Text.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => parseInt(m[1], 10));
            const maxH = resMatches.length > 0 ? Math.max(...resMatches) : 0;
            const playlistIsAv1 = isAv1Stream(q.label, q.url) || /CODECS="[^"]*av01/i.test(m3u8Text);
            if (maxH > 0) {
              updatedQ = {
                ...q,
                label: playlistIsAv1 ? `${maxH}p (HLS AV1)` : `${maxH}p (HLS)`,
              };
            }
          }
          verifiedQualities.push(updatedQ);
        }
      } catch {
        // skip unreachable candidate
      }
    })
  );

  const usableQualities = verifiedQualities.length > 0 ? verifiedQualities : qualities;
  usableQualities.sort((a, b) => {
    const scoreDiff = parseQualityScore(b.label, b.url) - parseQualityScore(a.label, a.url);
    if (scoreDiff !== 0) return scoreDiff;
    if (a.streamType === 'hls' && b.streamType !== 'hls') return -1;
    if (b.streamType === 'hls' && a.streamType !== 'hls') return 1;
    return 0;
  });

  const derivedEmbed = deriveEmbedUrlFromPage(finalUrl, $, html);

  if (usableQualities.length > 0) {
    return {
      streamUrl: usableQualities[0].url,
      streamType: usableQualities[0].streamType,
      referer: finalUrl,
      userAgent: BROWSER_USER_AGENT,
      title: pageTitle,
      thumbnail,
      qualities: usableQualities,
      embedFallbackUrl: derivedEmbed || finalUrl,
    };
  }

  // 8. Embed iframe fallback (unwrap one level deep to extract direct stream when possible; otherwise return embed/page fallback)
  if (derivedEmbed) {
    if (depth < 1) {
      try {
        const inner = await resolveVideoPageStream(derivedEmbed, depth + 1);
        if (inner.streamType !== 'embed' && inner.qualities.length > 0) {
          return {
            ...inner,
            title: inner.title || pageTitle,
            thumbnail: inner.thumbnail || thumbnail,
            embedFallbackUrl: derivedEmbed,
          };
        }
      } catch {
        // fall back to embed URL below
      }
    }
    return {
      streamUrl: derivedEmbed,
      streamType: 'embed',
      referer: finalUrl,
      title: pageTitle,
      thumbnail,
      qualities: [],
      embedFallbackUrl: derivedEmbed,
      fallbackMode: 'embed',
      fallbackReason: isAntiBotChallenge(200, html)
        ? 'Proteção Cloudflare/anti-bot detectada; exibindo player incorporado.'
        : 'Stream direto indisponível; exibindo player incorporado em tela cheia.',
    };
  }

  // 9. Ultimate fallback when depth === 0: open the watch page itself in fullscreen iframe mode
  if (depth === 0) {
    return {
      streamUrl: finalUrl,
      streamType: 'embed',
      referer: finalUrl,
      title: pageTitle,
      thumbnail,
      qualities: [],
      embedFallbackUrl: finalUrl,
      fallbackMode: 'page',
      fallbackReason: isAntiBotChallenge(200, html)
        ? 'Bloqueio anti-bot detectado; abrindo página do vídeo diretamente em tela cheia.'
        : 'Nenhum stream direto exposto; abrindo página do vídeo diretamente em tela cheia.',
      directBlocked: isAntiBotChallenge(200, html),
    };
  }

  throw new Error('Nenhum fluxo de vídeo (.m3u8, .mpd ou .mp4) foi encontrado nesta página.');
}
