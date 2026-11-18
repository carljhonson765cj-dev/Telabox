import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import type { CategorySource, MediaItem, QualityOption, ScanMode, ServerKind, SubtitleTrack } from '../src/types/media.ts';
import {
  canonicalizeMediaUrl,
  deduplicateMediaItems,
  mergeMediaItemMeta,
  normalizeMediaTitle,
} from '../src/utils/dedupeMedia.ts';
import { fetchWithPortalCookies, resolveVideoPageStream } from './resolver.ts';

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.m3u8', '.ts', '.flv', '.ogv', '.3gp', '.mpg', '.mpeg'
]);

const SUBTITLE_EXTENSIONS = new Set(['.vtt', '.srt']);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

const IGNORED_PATH_PATTERNS = [
  /\/(login|signin|signup|register|logout|cart|checkout|wp-admin|wp-login|feed|rss|atom|privacy|terms|contact|about|cookie|support|information|premium|upgrade|contest|modelhub)/i,
  /\/(photos|gifs|stories|albums|cams|live)\//i,
  /\.(css|js|json|woff|woff2|ttf|eot|svg|ico|pdf|zip|rar|7z|tar|gz|exe|apk|dmg|iso|txt|xml)$/i,
];

const EMBED_HOST_PATTERNS = [
  /youtube\.com\/embed\//i,
  /youtube-nocookie\.com\/embed\//i,
  /player\.vimeo\.com\/video\//i,
  /dailymotion\.com\/embed\/video\//i,
  /ok\.ru\/videoembed\//i,
  /streamtape\.com\/e\//i,
  /dood\./i,
];

// Watch-page URL patterns on video tube portals (indexed as cards, resolved lazily on Play)
const WATCH_PAGE_PATTERNS = [
  /\/view_video\.php\?viewkey=/i,
  /\/video\.[a-z0-9]+(\/|$)/i,
  /\/video\d+\//i,
  /\/video\.[a-z0-9-]+-\d+/i,
  /^\/videos\/[^/?#]+-(?:xh[a-z0-9]+|\d+)(?:\/|$)/i,
  /\/videos\/[^/?#]+-\d+/i,
  /\/watch\/[a-zA-Z0-9_-]+/i,
  /\/watch\?v=/i,
  /\/demo-server\/[^/]+\/[^/]+\.html$/i,
];

const NON_VIDEO_LINK_PATTERNS = [
  /(?:^|\/)(model|models|pornstar|pornstars|creator|creators|channels?|users?|user|profiles?|actors?|playlists?|categories?|tags?|gifs?|photos?|albums?|stories|live|cam|cams|shorts)(?:\/|$)/i,
];

const CATEGORY_PRIORITY_PATTERNS = [
  /\/video\?c=\d+/i,
  /\/categories(\/|$)/i,
  /\/video\?o=/i,
  /\/hd(\/|$|\?)/i,
  /\/recommended/i,
  /\/channels/i,
  /\/best(\/|$)/i,
  /\/new(\/|$)/i,
  /\/newest(\/|$)/i,
  /\/c\/[a-z0-9_-]+/i,
  /\/tags?\//i,
];

const DEFAULT_INITIAL_SCAN_PAGES = 5;
const MAX_SCAN_PAGES_PER_REQUEST = 5;
const DEFAULT_BROWSE_BATCH_PAGES = 4;
const MAX_BROWSE_BATCH_PAGES = 5;
const PAGE_DELAY_MIN_MS = 320;
const PAGE_DELAY_MAX_MS = 480;
const MAX_HTML_BYTES = 4 * 1024 * 1024; // 4 MB safety cap per HTML page
const MAX_CRAWL_QUEUE_SIZE = 120;

function randomPageDelayMs(): number {
  return PAGE_DELAY_MIN_MS + Math.floor(Math.random() * (PAGE_DELAY_MAX_MS - PAGE_DELAY_MIN_MS + 1));
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CrawlOptions {
  url: string;
  mode: ScanMode;
  maxPages?: number;
  maxDepth?: number;
  localBaseUrl?: string;
  signal?: AbortSignal;
  onProgress?: (data: {
    pagesScanned: number;
    maxPages: number;
    foldersFound: number;
    itemsFound: number;
    currentUrl: string;
    categories: string[];
  }) => void;
  onItem?: (item: MediaItem) => void;
}

export interface CrawlResult {
  name: string;
  url: string;
  scannedAt: number;
  serverKind: ServerKind;
  scanMode: ScanMode;
  categories: string[];
  items: MediaItem[];
  pagesScanned: number;
  foldersFound: number;
  nextPageUrl?: string;
  latestUrl?: string;
  categorySources?: Record<string, CategorySource>;
}

export interface BrowseBatchResult {
  items: MediaItem[];
  nextPageUrl?: string;
  pagesFetched: number;
  visitedUrls: string[];
  categorySources?: Record<string, CategorySource>;
  hasMore: boolean;
}

function hashId(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 14);
}

export function normalizeTargetUrl(rawUrl: string, localBaseUrl?: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Informe o endereço do site ou servidor.');
  }
  if (trimmed.startsWith('/') && localBaseUrl) {
    return new URL(trimmed, localBaseUrl).toString();
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function getExtension(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const pathname = u.pathname.toLowerCase();
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1) return '';
    return pathname.slice(lastDot);
  } catch {
    return '';
  }
}

function isVideoUrl(urlStr: string): boolean {
  return VIDEO_EXTENSIONS.has(getExtension(urlStr));
}

function isSubtitleUrl(urlStr: string): boolean {
  return SUBTITLE_EXTENSIONS.has(getExtension(urlStr));
}

function isImageUrl(urlStr: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(urlStr));
}

function isEmbedUrl(urlStr: string): boolean {
  return EMBED_HOST_PATTERNS.some((re) => re.test(urlStr));
}

function isWatchPageUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (NON_VIDEO_LINK_PATTERNS.some((re) => re.test(parsed.pathname))) {
      return false;
    }
    const pathAndQuery = parsed.pathname + parsed.search;
    return WATCH_PAGE_PATTERNS.some((re) => re.test(pathAndQuery) || re.test(urlStr));
  } catch {
    return WATCH_PAGE_PATTERNS.some((re) => re.test(urlStr));
  }
}

function cleanMediaTitle(rawName: string): { title: string; quality?: string } {
  let decoded = rawName;
  try {
    decoded = decodeURIComponent(rawName);
  } catch {
    // keep rawName if malformed URI sequence
  }

  const noExt = decoded.replace(/\.(mp4|mkv|webm|mov|avi|m4v|m3u8|ts|flv|ogv|3gp|mpg|mpeg)$/i, '');
  const qualityMatch = noExt.match(/\b(4K|2160p|1080p|720p|480p|360p|FHD|HD|UHD)\b/i);
  const quality = qualityMatch ? qualityMatch[1].toUpperCase() : undefined;

  let cleaned = noExt
    .replace(/[\._]+/g, ' ')
    .replace(/\b(4K|2160p|1080p|720p|480p|360p|FHD|HD|UHD|x264|x265|HEVC|WEB-DL|WEBRip|BluRay|HDRip|AAC|MP3|DUAL|DUBLADO|LEGENDADO)\b/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    cleaned = noExt.replace(/[\._]+/g, ' ').trim() || 'Vídeo sem título';
  }

  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return { title: cleaned, quality };
}

function extractFilenameFromUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const segments = u.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || u.hostname;
  } catch {
    return urlStr;
  }
}

function deriveFolderAndCategory(pageUrl: string, rootUrl: string, fallbackCategory?: string): {
  folderPath: string;
  category: string;
} {
  try {
    const page = new URL(pageUrl);
    const root = new URL(rootUrl);

    let relPath = page.pathname;
    if (relPath.startsWith(root.pathname) && root.pathname !== '/') {
      relPath = relPath.slice(root.pathname.length);
    }

    const segments = relPath
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .filter((s) => !/\.(html?|php|aspx?|jsp)$/i.test(s));

    const folderPath = segments.length > 0 ? '/' + segments.join('/') : '/';
    if (fallbackCategory && fallbackCategory.trim()) {
      return { folderPath, category: fallbackCategory.trim() };
    }
    if (segments.length > 0) {
      const catRaw = segments[0].replace(/[-_]+/g, ' ').trim();
      const category = catRaw.charAt(0).toUpperCase() + catRaw.slice(1);
      return { folderPath, category };
    }
    return { folderPath, category: 'Acervo Principal' };
  } catch {
    return { folderPath: '/', category: fallbackCategory || 'Acervo Principal' };
  }
}

function parseSizeText(text: string): string | undefined {
  const match = text.match(/\b(\d+(?:[.,]\d+)?\s*(?:GB|MB|KB|GiB|MiB|B))\b/i);
  return match ? match[1].toUpperCase() : undefined;
}

function extractLazyThumb($el: cheerio.Cheerio<any>, baseUrl: string): string | undefined {
  const imgs = $el.is('img') ? $el : $el.find('img');
  for (let i = 0; i < imgs.length; i++) {
    const $img = imgs.eq(i);
    const candidates = [
      $img.attr('data-src'),
      $img.attr('data-thumb_url'),
      $img.attr('data-mediumthumb'),
      $img.attr('data-original'),
      $img.attr('data-lazy'),
      $img.attr('data-img'),
      $img.attr('data-poster'),
      $img.attr('src'),
    ];
    for (const c of candidates) {
      if (!c) continue;
      const trimmed = c.trim();
      if (
        !trimmed ||
        trimmed.startsWith('data:') ||
        /blank\.gif|spacer\.gif|loading\.gif|ajax-loader/i.test(trimmed)
      ) {
        continue;
      }
      const resolved = safeResolveUrl(trimmed, baseUrl);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function extractDurationFromCard($card: cheerio.Cheerio<any>): string | undefined {
  const explicit = $card
    .find('[data-role="video-duration"], .thumb-image-container__duration, .duration, .video-time, .thumb-duration, var.duration, .time, [data-duration]')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim();

  const colonMatch = explicit.match(/\b(\d{1,2}:)?\d{1,2}:\d{2}\b/);
  if (colonMatch) return colonMatch[0];

  const wordDurMatch = explicit.match(/\b\d+\s*(?:h|hora|horas|min|minutos|minuto|seg|segundos)\b/i);
  if (wordDurMatch) return wordDurMatch[0];

  const cardText = $card.text().replace(/\s+/g, ' ');
  const textMatch = cardText.match(/\b(\d{1,2}:)?\d{1,2}:\d{2}\b/);
  if (textMatch) return textMatch[0];

  const wordTextMatch = cardText.match(/\b\d+\s*(?:min|minutos|seg|segundos)\b/i);
  return wordTextMatch ? wordTextMatch[0] : undefined;
}

function formatSecondsDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function extractXhamsterInitialsVideos(
  html: string,
  pageUrl: string,
  fallbackCategory: string
): MediaItem[] {
  if (!html.includes('window.initials') || !html.includes('videoThumbProps')) return [];
  const match = /window\.initials\s*=\s*\{/.exec(html);
  if (!match) return [];
  const startIdx = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonStr: string | null = null;
  for (let i = startIdx; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        jsonStr = html.slice(startIdx, i + 1);
        break;
      }
    }
  }
  if (!jsonStr) return [];

  let initials: unknown = null;
  try {
    initials = JSON.parse(jsonStr);
  } catch {
    jsonStr = null;
    return [];
  }
  // Free raw JSON slice immediately after parsing
  jsonStr = null;

  const results: MediaItem[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const el of node) walk(el);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.videoThumbProps)) {
      for (const v of rec.videoThumbProps) {
        if (!v || typeof v !== 'object') continue;
        const item = v as Record<string, unknown>;
        const rawUrl = typeof item.pageURL === 'string' ? item.pageURL : '';
        const rawTitle = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '';
        if (!rawUrl || !rawTitle || seen.has(rawUrl)) continue;
        // Skip moments / shorts if not standard video page
        if (item.videoType && item.videoType !== 'video') continue;
        const resolved = safeResolveUrl(rawUrl, pageUrl);
        if (!resolved || !isWatchPageUrl(resolved)) continue;
        seen.add(rawUrl);

        const thumbRaw =
          (typeof item.imageURL === 'string' && item.imageURL) ||
          (typeof item.thumbURL === 'string' && item.thumbURL) ||
          undefined;
        const thumb = thumbRaw ? safeResolveUrl(thumbRaw, pageUrl) : undefined;
        const dur =
          typeof item.duration === 'number' ? formatSecondsDuration(item.duration) : undefined;
        const quality = item.isUHD ? '4K' : item.isHD ? 'HD' : undefined;

        results.push({
          id: hashId(resolved),
          title: rawTitle,
          rawTitle,
          url: resolved,
          streamType: 'page',
          category: fallbackCategory,
          folderPath: '/' + fallbackCategory,
          thumbnail: thumb,
          duration: dur,
          quality,
          format: 'PORTAL',
          sourcePageUrl: pageUrl,
        });
      }
    }
    for (const val of Object.values(rec)) {
      if (val && typeof val === 'object') walk(val);
    }
  };

  try {
    walk(initials);
  } finally {
    // Release parsed initials tree immediately so V8 can GC it before next page
    initials = null;
  }
  return results;
}

function parseM3U(content: string, sourceUrl: string): MediaItem[] {
  const lines = content.split(/\r?\n/);
  const items: MediaItem[] = [];

  let currentTitle = '';
  let currentGroup = 'Canais e Listas';
  let currentLogo: string | undefined;
  let currentDuration: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(',');
      const durMatch = line.match(/^#EXTINF:(-?\d+)/);

      currentGroup = groupMatch && groupMatch[1].trim() ? groupMatch[1].trim() : 'Canais e Listas';
      currentLogo = logoMatch && logoMatch[1].trim() ? logoMatch[1].trim() : undefined;
      currentTitle = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : '';

      if (durMatch) {
        const secs = parseInt(durMatch[1], 10);
        if (secs > 0) {
          const mins = Math.floor(secs / 60);
          const rem = secs % 60;
          currentDuration = `${mins}:${rem.toString().padStart(2, '0')}`;
        } else {
          currentDuration = 'Ao Vivo';
        }
      }
    } else if (!line.startsWith('#')) {
      try {
        const resolvedUrl = new URL(line, sourceUrl).toString();
        const ext = getExtension(resolvedUrl);
        const isHls = ext === '.m3u8' || resolvedUrl.toLowerCase().includes('.m3u8');
        const rawTitle = currentTitle || extractFilenameFromUrl(resolvedUrl);
        const { title, quality } = cleanMediaTitle(rawTitle);

        items.push({
          id: hashId(resolvedUrl),
          title,
          rawTitle,
          url: resolvedUrl,
          streamType: isHls ? 'hls' : 'video',
          category: currentGroup,
          folderPath: '/' + currentGroup,
          thumbnail: currentLogo,
          duration: currentDuration,
          quality,
          format: isHls ? 'HLS' : (ext ? ext.slice(1).toUpperCase() : 'STREAM'),
          sourcePageUrl: sourceUrl,
        });
      } catch {
        // ignore invalid line
      }
      currentTitle = '';
      currentLogo = undefined;
      currentDuration = undefined;
    }
  }

  return items;
}

function parseXmlFeed(content: string, sourceUrl: string): { siteTitle?: string; items: MediaItem[] } {
  const $ = cheerio.load(content, { xmlMode: true });
  const siteTitle = $('channel > title').first().text().trim() || $('feed > title').first().text().trim();
  const items: MediaItem[] = [];

  $('item, entry').each((_, el) => {
    const $el = $(el);
    const title = $el.find('title').first().text().trim();
    const description = $el.find('description, summary').first().text().replace(/<[^>]+>/g, ' ').trim().slice(0, 220);
    const category = $el.find('category').first().text().trim() || 'Feed de Vídeos';
    const thumb =
      $el.find('media\\:thumbnail, thumbnail').attr('url') ||
      $el.find('itunes\\:image').attr('href') ||
      undefined;

    const enclosureUrl =
      $el.find('enclosure[type^="video"]').attr('url') ||
      $el.find('media\\:content[medium="video"]').attr('url') ||
      $el.find('media\\:content').attr('url') ||
      $el.find('enclosure').attr('url');

    if (enclosureUrl) {
      try {
        const resolved = new URL(enclosureUrl, sourceUrl).toString();
        const ext = getExtension(resolved);
        const isHls = ext === '.m3u8';
        const cleaned = cleanMediaTitle(title || extractFilenameFromUrl(resolved));

        items.push({
          id: hashId(resolved),
          title: title || cleaned.title,
          rawTitle: title || extractFilenameFromUrl(resolved),
          url: resolved,
          streamType: isHls ? 'hls' : 'video',
          category,
          folderPath: '/' + category,
          thumbnail: thumb ? new URL(thumb, sourceUrl).toString() : undefined,
          quality: cleaned.quality,
          format: isHls ? 'HLS' : (ext ? ext.slice(1).toUpperCase() : 'VIDEO'),
          description: description || undefined,
          sourcePageUrl: sourceUrl,
        });
      } catch {
        // ignore invalid url
      }
    }
  });

  return { siteTitle, items };
}

function parseJsonMedia(data: unknown, sourceUrl: string): { siteTitle?: string; items: MediaItem[] } {
  const items: MediaItem[] = [];
  const seen = new Set<string>();
  let siteTitle: string | undefined;

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (typeof obj.title === 'string') siteTitle = obj.title;
    if (typeof obj.name === 'string') siteTitle = obj.name;

    if (Array.isArray(obj.files) && typeof obj.dir === 'string' && typeof obj.server === 'string') {
      const base = `https://${obj.server}${obj.dir}/`;
      for (const file of obj.files) {
        if (file && typeof file === 'object') {
          const f = file as Record<string, unknown>;
          const name = typeof f.name === 'string' ? f.name : '';
          if (name && isVideoUrl(name)) {
            const url = new URL(encodeURIComponent(name).replace(/%2F/g, '/'), base).toString();
            if (!seen.has(url)) {
              seen.add(url);
              const cleaned = cleanMediaTitle(name);
              items.push({
                id: hashId(url),
                title: typeof f.title === 'string' && f.title ? f.title : cleaned.title,
                rawTitle: name,
                url,
                streamType: getExtension(url) === '.m3u8' ? 'hls' : 'video',
                category: siteTitle || 'Arquivos',
                folderPath: '/',
                quality: cleaned.quality,
                format: getExtension(url).slice(1).toUpperCase(),
                sourcePageUrl: sourceUrl,
              });
            }
          }
        }
      }
    }
  }

  const walk = (node: unknown, hintTitle?: string, hintCat?: string, hintThumb?: string) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, hintTitle, hintCat, hintThumb);
      return;
    }
    if (typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      const t = typeof rec.title === 'string' ? rec.title : typeof rec.name === 'string' ? rec.name : hintTitle;
      const c = typeof rec.category === 'string' ? rec.category : typeof rec.genre === 'string' ? rec.genre : hintCat;
      const th = typeof rec.thumbnail === 'string' ? rec.thumbnail : typeof rec.poster === 'string' ? rec.poster : typeof rec.image === 'string' ? rec.image : hintThumb;

      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === 'string' && (isVideoUrl(v) || k === 'streamUrl' || k === 'videoUrl' || k === 'hlsUrl')) {
          try {
            const resolved = new URL(v, sourceUrl).toString();
            if (!seen.has(resolved)) {
              seen.add(resolved);
              const ext = getExtension(resolved);
              const cleaned = cleanMediaTitle(t || extractFilenameFromUrl(resolved));
              items.push({
                id: hashId(resolved),
                title: t || cleaned.title,
                rawTitle: extractFilenameFromUrl(resolved),
                url: resolved,
                streamType: ext === '.m3u8' || resolved.includes('.m3u8') ? 'hls' : 'video',
                category: c || 'Catálogo JSON',
                folderPath: '/' + (c || 'Catálogo JSON'),
                thumbnail: th ? new URL(th, sourceUrl).toString() : undefined,
                quality: cleaned.quality,
                format: ext ? ext.slice(1).toUpperCase() : 'STREAM',
                sourcePageUrl: sourceUrl,
              });
            }
          } catch {
            // skip invalid URL
          }
        } else if (typeof v === 'object') {
          walk(v, t, c, th);
        }
      }
    }
  };

  walk(data);
  return { siteTitle, items };
}

export async function crawlServer(options: CrawlOptions): Promise<CrawlResult> {
  const rootUrl = normalizeTargetUrl(options.url, options.localBaseUrl);
  const rootParsed = new URL(rootUrl);

  // Cap single crawl to 3-5 pages by default to stay well within 512MB RAM and avoid timeouts;
  // additional pages are fetched on demand via browseServerPagesBatch.
  const requestedPages =
    options.mode === 'quick' ? 1 : (options.maxPages ?? DEFAULT_INITIAL_SCAN_PAGES);
  const maxPages = Math.min(Math.max(1, requestedPages), MAX_SCAN_PAGES_PER_REQUEST);
  const maxDepth = options.mode === 'quick' ? 0 : Math.min(Math.max(0, options.maxDepth ?? 1), 3);

  const cookieJar = new Map<string, string>();
  const visitedPages = new Set<string>();
  const queuedUrls = new Set<string>([rootUrl]);
  const priorityQueue: Array<{ url: string; depth: number; categoryHint?: string }> = [
    { url: rootUrl, depth: 0 }
  ];
  const normalQueue: Array<{ url: string; depth: number; categoryHint?: string }> = [];

  const itemsMap = new Map<string, MediaItem>();
  const dedupeKeyToCanonUrl = new Map<string, string>();
  const categoriesSet = new Set<string>();
  const foldersSet = new Set<string>();
  const categorySourcesMap = new Map<string, CategorySource>();

  let detectedLatestUrl = resolveLatestFeedUrl(rootUrl);
  if (options.mode === 'full') {
    if (detectedLatestUrl !== rootUrl && !queuedUrls.has(detectedLatestUrl)) {
      queuedUrls.add(detectedLatestUrl);
      priorityQueue.push({
        url: detectedLatestUrl,
        depth: 1,
        categoryHint: 'Adicionados Recentemente',
      });
    } else if (rootParsed.hostname.toLowerCase().includes('xvideos')) {
      const xvNewestPage = `${rootParsed.origin}/new/1`;
      if (!queuedUrls.has(xvNewestPage)) {
        queuedUrls.add(xvNewestPage);
        priorityQueue.push({
          url: xvNewestPage,
          depth: 1,
          categoryHint: 'Adicionados Recentemente',
        });
      }
    }
  }

  let rootNextPageUrl: string | undefined;
  let pagesScanned = 0;
  let detectedKind: ServerKind = 'portal';
  let serverName = rootParsed.hostname;

  const emitProgress = (currentUrl: string) => {
    options.onProgress?.({
      pagesScanned,
      maxPages,
      foldersFound: foldersSet.size,
      itemsFound: itemsMap.size,
      currentUrl,
      categories: Array.from(categoriesSet),
    });
  };

  const addItem = (item: MediaItem) => {
    const canonUrl = canonicalizeMediaUrl(item.url);
    const normTitle = normalizeMediaTitle(item.title || item.rawTitle || '');
    const catKey = normalizeMediaTitle(item.category || '');
    const durKey = (item.duration || '').trim().toLowerCase();

    const lookupKeys = [`url:${canonUrl}`, `id:${item.id}`];
    if (normTitle.length >= 4 && durKey) {
      lookupKeys.push(`td:${normTitle}::${durKey}`);
    }
    if (normTitle.length >= 4 && catKey) {
      lookupKeys.push(`ct:${catKey}::${normTitle}`);
    }
    if (normTitle.length >= 18) {
      lookupKeys.push(`t:${normTitle}`);
    }

    let matchedCanon: string | undefined;
    for (const k of lookupKeys) {
      const found = dedupeKeyToCanonUrl.get(k);
      if (found) {
        matchedCanon = found;
        break;
      }
    }

    if (!matchedCanon) {
      const normalizedItem: MediaItem = {
        ...item,
        id: hashId(canonUrl),
      };
      itemsMap.set(canonUrl, normalizedItem);
      for (const k of lookupKeys) {
        dedupeKeyToCanonUrl.set(k, canonUrl);
      }
      categoriesSet.add(normalizedItem.category);
      options.onItem?.(normalizedItem);
    } else {
      const existing = itemsMap.get(matchedCanon);
      if (existing) {
        itemsMap.set(matchedCanon, mergeMediaItemMeta(existing, item));
      }
    }
  };

  // Process pages sequentially (1 at a time) with inter-page delay (320-480ms)
  // so only 1 raw HTML buffer and 1 Cheerio DOM ever exist in memory at once.
  while ((priorityQueue.length > 0 || normalQueue.length > 0) && pagesScanned < maxPages) {
    if (options.signal?.aborted) break;

    const task = priorityQueue.length > 0 ? priorityQueue.shift()! : normalQueue.shift()!;
    if (visitedPages.has(task.url)) continue;

    if (pagesScanned > 0) {
      await sleepWithAbort(randomPageDelayMs(), options.signal);
      if (options.signal?.aborted) break;
    }

    visitedPages.add(task.url);
    pagesScanned++;
    emitProgress(task.url);

    let bodyText: string | null = null;
    let cleanupCheerio: cheerio.CheerioAPI | null = null;

    try {
      const res = await fetchWithPortalCookies(task.url, cookieJar, 12000);
      if (!res.ok) continue;

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const finalUrl = res.url || task.url;

      // Direct video file URL entered directly
      if (contentType.startsWith('video/') || (isVideoUrl(finalUrl) && !finalUrl.toLowerCase().endsWith('.m3u8'))) {
        const rawTitle = extractFilenameFromUrl(finalUrl);
        const cleaned = cleanMediaTitle(rawTitle);
        addItem({
          id: hashId(finalUrl),
          title: cleaned.title,
          rawTitle,
          url: finalUrl,
          streamType: 'video',
          category: 'Vídeo Direto',
          folderPath: '/',
          quality: cleaned.quality,
          format: getExtension(finalUrl).slice(1).toUpperCase() || 'MP4',
          sourcePageUrl: task.url,
        });
        continue;
      }

      bodyText = await res.text();
      if (!bodyText) continue;
      if (bodyText.length > MAX_HTML_BYTES) {
        bodyText = bodyText.slice(0, MAX_HTML_BYTES);
      }

      // 1. M3U / M3U8 Playlist
      if (
        bodyText.trimStart().startsWith('#EXTM3U') ||
        contentType.includes('mpegurl') ||
        finalUrl.toLowerCase().endsWith('.m3u') ||
        finalUrl.toLowerCase().endsWith('.m3u8')
      ) {
        if (bodyText.includes('#EXT-X-STREAM-INF')) {
          const rawTitle = extractFilenameFromUrl(finalUrl);
          const cleaned = cleanMediaTitle(rawTitle);
          addItem({
            id: hashId(finalUrl),
            title: cleaned.title,
            rawTitle,
            url: finalUrl,
            streamType: 'hls',
            category: 'Streams HLS',
            folderPath: '/',
            quality: cleaned.quality || 'HLS',
            format: 'HLS',
            sourcePageUrl: task.url,
          });
          continue;
        }
        detectedKind = 'iptv';
        const parsedM3u = parseM3U(bodyText, finalUrl);
        for (const item of parsedM3u) addItem(item);
        continue;
      }

      // 2. JSON API
      if (contentType.includes('application/json') || bodyText.trimStart().startsWith('{') || bodyText.trimStart().startsWith('[')) {
        try {
          const json = JSON.parse(bodyText);
          const { siteTitle, items } = parseJsonMedia(json, finalUrl);
          if (siteTitle && task.depth === 0) serverName = siteTitle;
          for (const item of items) addItem(item);
          continue;
        } catch {
          // not valid JSON
        }
      }

      // 3. RSS / Atom XML
      if (contentType.includes('xml') || bodyText.trimStart().startsWith('<?xml') || bodyText.includes('<rss')) {
        detectedKind = 'feed';
        const { siteTitle, items } = parseXmlFeed(bodyText, finalUrl);
        if (siteTitle && task.depth === 0) serverName = siteTitle;
        for (const item of items) addItem(item);
        continue;
      }

      // 4. Direct Watch Page entered at depth === 0 (e.g. user pasted a single video link)
      if (task.depth === 0 && isWatchPageUrl(finalUrl)) {
        try {
          const resolved = await resolveVideoPageStream(finalUrl);
          const rawTitle = resolved.title || extractFilenameFromUrl(finalUrl);
          addItem({
            id: hashId(finalUrl),
            title: rawTitle,
            rawTitle,
            url: resolved.streamUrl,
            streamType: resolved.streamType,
            category: 'Vídeo Selecionado',
            folderPath: '/',
            thumbnail: resolved.thumbnail,
            quality: resolved.qualities[0]?.label,
            format: resolved.streamType.toUpperCase(),
            qualities: resolved.qualities,
            sourcePageUrl: finalUrl,
          });
          continue;
        } catch {
          // continue normal HTML parsing
        }
      }

      // 5. HTML Page (Open Directory or Video Portal)
      const $ = cheerio.load(bodyText);
      cleanupCheerio = $;
      const pageTitle = $('title').first().text().trim();
          const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
          const ogImage = $('meta[property="og:image"]').attr('content')?.trim();
          const ogVideo =
            $('meta[property="og:video:secure_url"]').attr('content')?.trim() ||
            $('meta[property="og:video:url"]').attr('content')?.trim() ||
            $('meta[property="og:video"]').attr('content')?.trim();
          const ogDescription =
            $('meta[property="og:description"]').attr('content')?.trim() ||
            $('meta[name="description"]').attr('content')?.trim();

          const isIndexDirectory =
            /^index of\s+/i.test(pageTitle) ||
            $('h1').first().text().trim().toLowerCase().startsWith('index of') ||
            ($('pre a').length > 3 && $('article, nav, main').length === 0);

          if (isIndexDirectory) {
            detectedKind = 'directory';
          }

          if (task.depth === 0) {
            if (isIndexDirectory) {
              serverName = `${rootParsed.hostname} (Diretório)`;
            } else if (pageTitle) {
              serverName = pageTitle.split(/[|\-–—:]/)[0].trim() || rootParsed.hostname;
            }
          }

          const resolvedOgImage = ogImage ? safeResolveUrl(ogImage, finalUrl) : undefined;
          const h1Title = $('h1').first().text().replace(/\s+/g, ' ').trim();
          const { folderPath, category: derivedCat } = deriveFolderAndCategory(
            finalUrl,
            rootUrl,
            task.categoryHint || (task.depth > 0 && h1Title && h1Title.length < 40 ? h1Title : undefined)
          );

          const discoveredNextPage =
            extractNextPageUrl($, finalUrl) ||
            (itemsMap.size > 8 ? inferNextPaginatedUrl(finalUrl) : undefined);
          if (task.depth === 0) {
            if (discoveredNextPage) rootNextPageUrl = discoveredNextPage;
            const htmlLatest = detectLatestLinkInHtml($, finalUrl, rootParsed);
            if (htmlLatest && detectedLatestUrl === rootUrl) {
              detectedLatestUrl = htmlLatest;
              if (options.mode === 'full' && !queuedUrls.has(htmlLatest) && !visitedPages.has(htmlLatest)) {
                queuedUrls.add(htmlLatest);
                priorityQueue.unshift({
                  url: htmlLatest,
                  depth: 1,
                  categoryHint: 'Adicionados Recentemente',
                });
              }
            }
          }
          if (task.categoryHint) {
            const prevSource = categorySourcesMap.get(task.categoryHint);
            categorySourcesMap.set(task.categoryHint, {
              name: task.categoryHint,
              url: prevSource?.url || task.url,
              nextPageUrl: discoveredNextPage || prevSource?.nextPageUrl,
              pageLoaded: (prevSource?.pageLoaded || 0) + 1,
            });
          }

          // Discover full list of site categories & their URLs for on-demand full-site browsing
          const discoveredCats = extractCategorySources($, finalUrl, rootParsed);
          for (const catSrc of discoveredCats) {
            if (!categorySourcesMap.has(catSrc.name)) {
              categorySourcesMap.set(catSrc.name, catSrc);
            }
          }

          const pageSubtitles: Array<{ base: string; url: string; label: string }> = [];
          const pageImages: Array<{ base: string; url: string }> = [];

          $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const resolved = safeResolveUrl(href, finalUrl);
            if (!resolved) return;

            if (isSubtitleUrl(resolved)) {
              const fn = extractFilenameFromUrl(resolved);
              const base = fn.replace(/\.(vtt|srt)$/i, '').toLowerCase();
              pageSubtitles.push({ base, url: resolved, label: fn });
            } else if (isImageUrl(resolved)) {
              const fn = extractFilenameFromUrl(resolved);
              const base = fn.replace(/\.(jpg|jpeg|png|webp|avif)$/i, '').toLowerCase();
              pageImages.push({ base, url: resolved });
            }
          });

          // A0. Extract xHamster window.initials hydrated videoThumbProps (captures SSR-lazy cards too)
          const initialsCat =
            task.categoryHint ||
            (derivedCat !== 'Acervo Principal' ? derivedCat : 'Em Alta');
          const initialsVideos = extractXhamsterInitialsVideos(bodyText, finalUrl, initialsCat);
          for (const vItem of initialsVideos) {
            foldersSet.add('/' + vItem.category);
            addItem(vItem);
          }

          // A. Extract JSON-LD VideoObject / Movie
          $('script[type="application/ld+json"]').each((_, el) => {
            try {
              const rawJson = $(el).text();
              if (!rawJson) return;
              const parsed = JSON.parse(rawJson);
              const entries = Array.isArray(parsed) ? parsed : [parsed];
              for (const entry of entries) {
                if (entry && typeof entry === 'object') {
                  const contentUrl = entry.contentUrl || entry.embedUrl;
                  if (typeof contentUrl === 'string') {
                    const resolved = safeResolveUrl(contentUrl, finalUrl);
                    if (resolved) {
                      const isEmbed = !isVideoUrl(resolved) && isEmbedUrl(resolved);
                      const isHls = getExtension(resolved) === '.m3u8' || resolved.includes('.m3u8');
                      const rawTitle = entry.name || pageTitle || extractFilenameFromUrl(resolved);
                      addItem({
                        id: hashId(resolved),
                        title: String(rawTitle),
                        rawTitle: String(rawTitle),
                        url: resolved,
                        streamType: isEmbed ? 'embed' : isHls ? 'hls' : 'video',
                        category: entry.genre || derivedCat,
                        folderPath,
                        thumbnail: typeof entry.thumbnailUrl === 'string'
                          ? safeResolveUrl(entry.thumbnailUrl, finalUrl)
                          : Array.isArray(entry.thumbnailUrl) && typeof entry.thumbnailUrl[0] === 'string'
                          ? safeResolveUrl(entry.thumbnailUrl[0], finalUrl)
                          : resolvedOgImage,
                        description: typeof entry.description === 'string' ? entry.description.slice(0, 220) : ogDescription,
                        format: isEmbed ? 'EMBED' : isHls ? 'HLS' : 'VIDEO',
                        sourcePageUrl: finalUrl,
                      });
                    }
                  }
                }
              }
            } catch {
              // ignore malformed JSON-LD
            }
          });

          // B. Extract OpenGraph Video
          if (ogVideo) {
            const resolved = safeResolveUrl(ogVideo, finalUrl);
            if (resolved && (isVideoUrl(resolved) || isEmbedUrl(resolved))) {
              const isEmbed = !isVideoUrl(resolved) && isEmbedUrl(resolved);
              const isHls = getExtension(resolved) === '.m3u8' || resolved.includes('.m3u8');
              const titleText = ogTitle || pageTitle || extractFilenameFromUrl(resolved);
              addItem({
                id: hashId(resolved),
                title: titleText,
                rawTitle: titleText,
                url: resolved,
                streamType: isEmbed ? 'embed' : isHls ? 'hls' : 'video',
                category: derivedCat,
                folderPath,
                thumbnail: resolvedOgImage,
                description: ogDescription,
                format: isEmbed ? 'EMBED' : isHls ? 'HLS' : getExtension(resolved).slice(1).toUpperCase() || 'VIDEO',
                sourcePageUrl: finalUrl,
              });
            }
          }

          // C. Extract <video> and <source> tags
          $('video').each((_, el) => {
            const $video = $(el);
            const posterAttr = $video.attr('poster');
            const posterUrl = posterAttr ? safeResolveUrl(posterAttr, finalUrl) : resolvedOgImage;
            const tracks: SubtitleTrack[] = [];

            $video.find('track[src]').each((__, trackEl) => {
              const tSrc = $(trackEl).attr('src');
              if (tSrc) {
                const resolvedTrack = safeResolveUrl(tSrc, finalUrl);
                if (resolvedTrack) {
                  tracks.push({
                    label: $(trackEl).attr('label') || $(trackEl).attr('srclang') || 'Legenda',
                    lang: $(trackEl).attr('srclang') || 'pt',
                    url: resolvedTrack,
                  });
                }
              }
            });

            const sources: string[] = [];
            const directSrc = $video.attr('src');
            if (directSrc) sources.push(directSrc);
            $video.find('source[src]').each((__, sEl) => {
              const s = $(sEl).attr('src');
              if (s) sources.push(s);
            });

            const contextCard = $video.closest('article, section, .card, .video-card, .video-item, li, div');
            const cardHeading =
              $video.attr('title') ||
              $video.attr('data-title') ||
              contextCard.find('h1, h2, h3, h4, .title').first().text().trim() ||
              ogTitle ||
              pageTitle;

            const resolvedSources: string[] = [];
            for (const src of sources) {
              const resolved = safeResolveUrl(src, finalUrl);
              if (resolved && !resolvedSources.includes(resolved)) {
                resolvedSources.push(resolved);
              }
            }

            if (resolvedSources.length > 0) {
              const primaryUrl = resolvedSources[0];
              const isHls = getExtension(primaryUrl) === '.m3u8' || primaryUrl.includes('.m3u8');
              const rawTitle = cardHeading || extractFilenameFromUrl(primaryUrl);
              const cleaned = cleanMediaTitle(rawTitle);

              const qualityOptions: QualityOption[] =
                resolvedSources.length > 1
                  ? resolvedSources.map((u, idx) => {
                      const qMatch = u.match(/\b(2160p|1440p|1080p|720p|480p|360p|4K|HD)\b/i);
                      const uIsHls = getExtension(u) === '.m3u8' || u.includes('.m3u8');
                      return {
                        label: qMatch ? qMatch[1].toUpperCase() : uIsHls ? 'HLS' : `Fonte ${idx + 1}`,
                        url: u,
                        streamType: uIsHls ? 'hls' : 'video',
                      };
                    })
                  : [];

              addItem({
                id: hashId(canonicalizeMediaUrl(primaryUrl)),
                title: cardHeading && !isVideoUrl(cardHeading) ? cardHeading : cleaned.title,
                rawTitle,
                url: primaryUrl,
                streamType: isHls ? 'hls' : 'video',
                category: derivedCat,
                folderPath,
                thumbnail: posterUrl,
                quality: cleaned.quality || qualityOptions[0]?.label,
                format: isHls ? 'HLS' : getExtension(primaryUrl).slice(1).toUpperCase() || 'VIDEO',
                description: ogDescription,
                subtitles: tracks.length > 0 ? tracks : undefined,
                qualities: qualityOptions.length > 1 ? qualityOptions : undefined,
                sourcePageUrl: finalUrl,
              });
            }
          });

          // D. Extract <iframe> embeds
          $('iframe[src]').each((_, el) => {
            const src = $(el).attr('src');
            if (!src) return;
            const resolved = safeResolveUrl(src, finalUrl);
            if (!resolved || !isEmbedUrl(resolved)) return;
            const titleText = $(el).attr('title') || ogTitle || pageTitle || 'Player Externo';
            addItem({
              id: hashId(resolved),
              title: titleText,
              rawTitle: titleText,
              url: resolved,
              streamType: 'embed',
              category: derivedCat,
              folderPath,
              thumbnail: resolvedOgImage,
              description: ogDescription,
              format: 'EMBED',
              sourcePageUrl: finalUrl,
            });
          });

          // E. Extract <a href="..."> video links, portal video cards, & discover sub-pages / categories
          $('a[href]').each((_, el) => {
            const $a = $(el);
            const href = $a.attr('href');
            if (!href) return;
            if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) return;

            const anchorText = $a.text().replace(/\s+/g, ' ').trim();
            if (anchorText === '../' || anchorText === '..' || /^parent directory$/i.test(anchorText)) return;

            const resolved = safeResolveUrl(href, finalUrl);
            if (!resolved) return;

            let resolvedParsed: URL;
            try {
              resolvedParsed = new URL(resolved);
            } catch {
              return;
            }
            if (resolvedParsed.protocol !== 'http:' && resolvedParsed.protocol !== 'https:') return;

            // 1) Direct link to a video file or HLS stream
            if (isVideoUrl(resolved)) {
              const fn = extractFilenameFromUrl(resolved);
              const baseName = fn.replace(/\.(mp4|mkv|webm|mov|avi|m4v|m3u8|ts|flv|ogv|3gp|mpg|mpeg)$/i, '').toLowerCase();

              const cardEl = $a.closest('article, li, .card, .video-card, .item, tr');
              const thumb = extractLazyThumb($a, finalUrl) || extractLazyThumb(cardEl, finalUrl) || pageImages.find((im) => im.base === baseName)?.url || resolvedOgImage;

              const rowText = $a.parent().text() + ' ' + ($a.closest('tr').text() || '');
              const size = parseSizeText(rowText);

              const matchedSubs: SubtitleTrack[] = pageSubtitles
                .filter((s) => s.base === baseName || s.base.startsWith(baseName + '.'))
                .map((s) => ({ label: s.label, url: s.url, lang: 'pt' }));

              const rawTitle = (anchorText && anchorText.length > 2 && !/^download$/i.test(anchorText))
                ? anchorText
                : fn;
              const cleaned = cleanMediaTitle(rawTitle);
              const isHls = getExtension(resolved) === '.m3u8' || resolved.includes('.m3u8');

              addItem({
                id: hashId(resolved),
                title: cleaned.title,
                rawTitle,
                url: resolved,
                streamType: isHls ? 'hls' : 'video',
                category: $a.attr('data-category') || derivedCat,
                folderPath,
                thumbnail: thumb,
                quality: cleaned.quality,
                size,
                format: isHls ? 'HLS' : getExtension(resolved).slice(1).toUpperCase(),
                subtitles: matchedSubs.length > 0 ? matchedSubs : undefined,
                sourcePageUrl: finalUrl,
              });
              return;
            }

            // 2) Portal Video Card linking to a watch page (e.g., Pornhub view_video, XVideos /video123, xHamster /videos/...-xh...)
            const $cardContainer = $a.closest('li, article, .video-card, .video-item, .video-thumb, .thumb-list__item, .thumb-block, .videoblock, .videoBox, .wrap, .card');
            const anchorOwnThumb = extractLazyThumb($a, finalUrl);
            const cardThumb = anchorOwnThumb || extractLazyThumb($cardContainer, finalUrl);
            const cardDuration = extractDurationFromCard($cardContainer.length ? $cardContainer : $a);
            const isNonVideoProfileLink = NON_VIDEO_LINK_PATTERNS.some((re) => re.test(resolvedParsed.pathname));
            const looksLikeVideoCard =
              !isNonVideoProfileLink &&
              (isWatchPageUrl(resolved) ||
                (Boolean(anchorOwnThumb) &&
                  (Boolean(cardDuration) || $cardContainer.hasClass('video-card') || Boolean($a.attr('data-category'))) &&
                  resolvedParsed.origin === rootParsed.origin &&
                  !resolved.endsWith('/')));

            if (looksLikeVideoCard) {
              const titleLink = $cardContainer.find('.video-thumb-info__name, .title a, p.title a').first();
              const rawTitle = (
                titleLink.attr('title')?.trim() ||
                titleLink.text().trim() ||
                $a.attr('title')?.trim() ||
                $a.attr('aria-label')?.trim() ||
                $a.find('img').attr('alt')?.trim() ||
                $cardContainer.find('h2, h3, h4').first().text().trim() ||
                anchorText.replace(/\b(\d{1,2}:)?\d{1,2}:\d{2}\b/g, '').trim()
              ).replace(/\s+/g, ' ');

              if (
                rawTitle &&
                rawTitle.length >= 3 &&
                !/^\d+$/.test(rawTitle) &&
                !/^(4K|2160p|1440p|1080p|720p|480p|360p|HD)$/i.test(rawTitle)
              ) {
                const sectionHeading = $cardContainer
                  .closest('section, .sectionWrapper, .container')
                  .find('h1, h2, .sectionTitle')
                  .first()
                  .text()
                  .replace(/\s+/g, ' ')
                  .trim();

                const cleanSection =
                  sectionHeading && sectionHeading.length > 2 && sectionHeading.length < 40
                    ? sectionHeading
                    : undefined;

                const category =
                  $a.attr('data-category') ||
                  task.categoryHint ||
                  cleanSection ||
                  (derivedCat !== 'Acervo Principal' ? derivedCat : 'Em Alta');

                const cardText = $cardContainer.text();
                const qualityMatch = cardText.match(/\b(4K|2160p|1440p|1080p|720p|HD)\b/i);

                foldersSet.add('/' + category);

                addItem({
                  id: hashId(resolved),
                  title: rawTitle,
                  rawTitle,
                  url: resolved,
                  streamType: 'page',
                  category,
                  folderPath: '/' + category,
                  thumbnail: cardThumb,
                  duration: cardDuration,
                  quality: qualityMatch ? qualityMatch[1].toUpperCase() : undefined,
                  format: 'PORTAL',
                  sourcePageUrl: finalUrl,
                });
              }
              return;
            }

            // 3) Link to an M3U playlist file
            if (getExtension(resolved) === '.m3u') {
              if (!visitedPages.has(resolved) && !queuedUrls.has(resolved)) {
                queuedUrls.add(resolved);
                priorityQueue.push({ url: resolved, depth: task.depth + 1, categoryHint: anchorText || derivedCat });
              }
              return;
            }

            // 4) Internal page / category / folder crawling (bounded queue, skip deep numbered pagination)
            if (
              task.depth < maxDepth &&
              resolvedParsed.origin === rootParsed.origin &&
              queuedUrls.size < MAX_CRAWL_QUEUE_SIZE
            ) {
              resolvedParsed.hash = '';
              const cleanNext = resolvedParsed.toString();

              if (visitedPages.has(cleanNext) || queuedUrls.has(cleanNext)) return;
              if (IGNORED_PATH_PATTERNS.some((re) => re.test(cleanNext))) return;
              if (isImageUrl(cleanNext) || isSubtitleUrl(cleanNext)) return;
              if (!isIndexDirectory && /[?&](?:page|p)=\d+|\/page\/\d+/i.test(cleanNext)) return;

              if (isIndexDirectory && !resolvedParsed.pathname.startsWith(rootParsed.pathname)) return;
              if (isIndexDirectory && /^[?;]?(C=[NMSD];O=[AD]|sort=)/.test(resolvedParsed.search.slice(1))) return;

              if (cleanNext.endsWith('/') && isIndexDirectory) {
                foldersSet.add(resolvedParsed.pathname);
              } else if (resolvedParsed.pathname.split('/').filter(Boolean).length > 1) {
                foldersSet.add(resolvedParsed.pathname);
              }

              const isPriorityCategory = CATEGORY_PRIORITY_PATTERNS.some((re) => re.test(cleanNext));
              const nextCatHint =
                $a.attr('data-category') ||
                (isPriorityCategory && anchorText && anchorText.length > 2 && anchorText.length < 32
                  ? anchorText
                  : undefined);

              queuedUrls.add(cleanNext);
              if (isPriorityCategory) {
                priorityQueue.push({
                  url: cleanNext,
                  depth: task.depth + 1,
                  categoryHint: nextCatHint,
                });
              } else {
                normalQueue.push({
                  url: cleanNext,
                  depth: task.depth + 1,
                  categoryHint: nextCatHint,
                });
              }
            }
          });
    } catch {
      // Skip unreachable / timed-out subpages gracefully
    } finally {
      // Explicitly release raw HTML string & Cheerio DOM tree after extracting titles/thumbs/links
      if (cleanupCheerio) {
        try {
          cleanupCheerio.root().empty();
        } catch {
          // ignore DOM clear error
        }
        cleanupCheerio = null;
      }
      bodyText = null;
    }
  }

  const items = Array.from(itemsMap.values());
  const categories = Array.from(new Set(items.map((i) => i.category))).sort((a, b) =>
    a.localeCompare(b, 'pt-BR')
  );

  if (!categorySourcesMap.has('Adicionados Recentemente')) {
    categorySourcesMap.set('Adicionados Recentemente', {
      name: 'Adicionados Recentemente',
      url: detectedLatestUrl,
      pageLoaded: 0,
    });
  }

  const categorySources: Record<string, CategorySource> = {};
  for (const [k, v] of categorySourcesMap.entries()) {
    categorySources[k] = v;
  }

  return {
    name: serverName,
    url: rootUrl,
    scannedAt: Date.now(),
    serverKind: detectedKind,
    scanMode: options.mode,
    categories,
    items,
    pagesScanned,
    foldersFound: Math.max(foldersSet.size, categories.length),
    nextPageUrl: rootNextPageUrl,
    latestUrl: detectedLatestUrl,
    categorySources: Object.keys(categorySources).length > 0 ? categorySources : undefined,
  };
}

function safeResolveUrl(target: string, base: string): string | undefined {
  try {
    return new URL(target, base).toString();
  } catch {
    return undefined;
  }
}

function cleanCategoryLabel(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\b\d[\d.,]*\s*(?:vídeos?|videos?)\b/gi, '')
    .replace(/\(\s*\d[\d.,]*\s*\)$/g, '')
    .trim();
}

function extractNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | undefined {
  const selectors = [
    'link[rel="next"]',
    'a[rel="next"]',
    '.page_next a',
    'li.page_next a',
    'a.next-page',
    '.pagination a.next',
    '.pagination li.active + li a',
    '.pagination li.current + li a',
    'a[title*="Próxim" i]',
    'a[title*="Next" i]',
  ];

  for (const sel of selectors) {
    const href = $(sel).first().attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      const resolved = safeResolveUrl(href, currentUrl);
      if (resolved && resolved !== currentUrl) return resolved;
    }
  }

  // Fallback: detect XVideos /new/N or ?page=N pagination links inside .pagination
  try {
    const cur = new URL(currentUrl);
    const curPageParam = Number(cur.searchParams.get('page') || cur.searchParams.get('p') || '1');
    const xvNewMatch = cur.pathname.match(/^\/new\/(\d+)\/?$/i);
    const xvCatMatch = cur.pathname.match(/^(\/c\/[^/]+)(?:\/(\d+))?\/?$/i);

    let candidate: string | undefined;
    $('.pagination a[href], nav.pagination a[href]').each((_, el) => {
      if (candidate) return;
      const href = $(el).attr('href');
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!href || href.startsWith('#')) return;
      const resolved = safeResolveUrl(href, currentUrl);
      if (!resolved || resolved === currentUrl) return;

      if (/^(próxima|proxima|next|>>|›|avançar)$/i.test(text)) {
        candidate = resolved;
        return;
      }
      if (cur.pathname === '/' && /\/new\/1\/?$/i.test(resolved)) {
        candidate = resolved;
        return;
      }
      if (xvNewMatch) {
        const nextNum = Number(xvNewMatch[1]) + 1;
        if (resolved.endsWith(`/new/${nextNum}`) || resolved.endsWith(`/new/${nextNum}/`)) {
          candidate = resolved;
          return;
        }
      }
      if (xvCatMatch) {
        const curNum = xvCatMatch[2] ? Number(xvCatMatch[2]) : 0;
        const nextNum = curNum + 1;
        if (resolved.includes(`${xvCatMatch[1]}/${nextNum}`)) {
          candidate = resolved;
          return;
        }
      }
      if (text === String(curPageParam + 1)) {
        candidate = resolved;
      }
    });
    if (candidate) return candidate;

    // Fallback for query-based pagination (e.g. xHamster search ?page=2)
    const nextNum = String(curPageParam + 1);
    const nextHref =
      $(`a[data-page="${nextNum}"]`).first().attr('href') ||
      $(`a[href*="page=${nextNum}"]`).first().attr('href');
    if (nextHref && !nextHref.startsWith('#')) {
      const resolvedNext = safeResolveUrl(nextHref, currentUrl);
      if (resolvedNext && resolvedNext !== currentUrl) return resolvedNext;
    }
  } catch {
    // ignore URL parse error
  }

  return undefined;
}

function extractCategorySources(
  $: cheerio.CheerioAPI,
  currentUrl: string,
  rootParsed: URL
): CategorySource[] {
  const found = new Map<string, CategorySource>();
  const categoryHrefPattern =
    /(\/video\?c=\d+|\/categories\/[^/?#]+|\/c\/[^/?#]+|\/category\/[^/?#]+|\/genre\/[^/?#]+)/i;

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    const resolved = safeResolveUrl(href, currentUrl);
    if (!resolved) return;

    let parsed: URL;
    try {
      parsed = new URL(resolved);
    } catch {
      return;
    }
    if (parsed.origin !== rootParsed.origin) return;
    if (IGNORED_PATH_PATTERNS.some((re) => re.test(resolved))) return;
    if (/\/(photos|gifs|stories|shorts)\//i.test(parsed.pathname)) return;
    if (isWatchPageUrl(resolved)) return;
    if (!categoryHrefPattern.test(resolved) && !$a.attr('data-category')) return;

    const rawText = $a.attr('data-category') || $a.attr('title') || $a.text();
    const name = cleanCategoryLabel(rawText);
    if (
      !name ||
      name.length < 2 ||
      name.length > 36 ||
      /^\d+$/.test(name) ||
      /^(todas|todos|ver tudo|more|ver mais|categorias|categories)$/i.test(name)
    ) {
      return;
    }

    if (!found.has(name)) {
      parsed.hash = '';
      found.set(name, {
        name,
        url: parsed.toString(),
        pageLoaded: 0,
      });
    }
  });

  return Array.from(found.values());
}

export function resolveLatestFeedUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('pornhub')) return `${parsed.origin}/video?o=cm`;
    if (host.includes('xvideos')) return `${parsed.origin}/`;
    if (host.includes('xhamster')) return `${parsed.origin}/newest`;
    if (host.includes('redtube')) return `${parsed.origin}/newest`;
    if (host.includes('eporner')) return `${parsed.origin}/recent/`;
    if (host.includes('spankbang')) return `${parsed.origin}/new_videos/`;
    return serverUrl;
  } catch {
    return serverUrl;
  }
}

function detectLatestLinkInHtml(
  $: cheerio.CheerioAPI,
  currentUrl: string,
  rootParsed: URL
): string | undefined {
  let matched: string | undefined;
  $('a[href]').each((_, el) => {
    if (matched) return;
    const $a = $(el);
    const href = $a.attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    const text = $a.text().replace(/\s+/g, ' ').trim();
    if (
      !/\b(recentes|adicionados recentemente|novos vídeos|novidades|newest|recent videos|latest)\b/i.test(text) &&
      !/\/(newest|recent|latest|new_videos)\b|[?&]o=cm\b/i.test(href)
    ) {
      return;
    }
    const resolved = safeResolveUrl(href, currentUrl);
    if (!resolved) return;
    try {
      const p = new URL(resolved);
      if (p.origin === rootParsed.origin && !isWatchPageUrl(resolved)) {
        matched = resolved;
      }
    } catch {
      // ignore
    }
  });
  return matched;
}

function inferNextPaginatedUrl(currentUrl: string): string | undefined {
  try {
    const parsed = new URL(currentUrl);
    // 1) Explicit ?page=N or ?p=N query param
    if (parsed.searchParams.has('page')) {
      const cur = Math.max(1, Number(parsed.searchParams.get('page')) || 1);
      parsed.searchParams.set('page', String(cur + 1));
      return parsed.toString();
    }
    if (parsed.searchParams.has('p')) {
      const cur = Math.max(0, Number(parsed.searchParams.get('p')) || 0);
      parsed.searchParams.set('p', String(cur + 1));
      return parsed.toString();
    }

    // 2) Pathname /page/N/
    const wpMatch = parsed.pathname.match(/^(.*)\/page\/(\d+)(\/?)$/i);
    if (wpMatch) {
      parsed.pathname = `${wpMatch[1]}/page/${Number(wpMatch[2]) + 1}${wpMatch[3] || '/'}`;
      return parsed.toString();
    }

    // 3) XVideos /new/N or /c/slug/N
    const host = parsed.hostname.toLowerCase();
    if (host.includes('xvideos')) {
      const xvNew = parsed.pathname.match(/^\/new\/(\d+)\/?$/i);
      if (xvNew) {
        parsed.pathname = `/new/${Number(xvNew[1]) + 1}`;
        return parsed.toString();
      }
      const xvCat = parsed.pathname.match(/^(\/c\/[^/]+)(?:\/(\d+))?\/?$/i);
      if (xvCat) {
        const nextNum = (xvCat[2] ? Number(xvCat[2]) : 0) + 1;
        parsed.pathname = `${xvCat[1]}/${nextNum}`;
        return parsed.toString();
      }
      if (parsed.pathname === '/' || parsed.pathname === '') {
        parsed.pathname = '/new/1';
        return parsed.toString();
      }
    }

    // 4) Trailing numeric segment on known video portals (e.g. xHamster /newest/2, ePorner /2/)
    if (/(xhamster|eporner|spankbang|xnxx)/i.test(host)) {
      const numMatch = parsed.pathname.match(/^(.*)\/(\d+)(\/?)$/);
      if (numMatch && Number(numMatch[2]) < 10000) {
        parsed.pathname = `${numMatch[1]}/${Number(numMatch[2]) + 1}${numMatch[3] || ''}`;
        return parsed.toString();
      }
    }

    // 5) First page of a known multi-page portal listing -> ?page=2
    if (/(xhamster|pornhub|redtube|youporn)/i.test(host)) {
      parsed.searchParams.set('page', '2');
      return parsed.toString();
    }
  } catch {
    // ignore URL parse error
  }
  return undefined;
}

export async function browseServerPagesBatch(options: {
  pageUrl: string;
  pages?: number;
  categoryName?: string;
  localBaseUrl?: string;
  signal?: AbortSignal;
}): Promise<BrowseBatchResult> {
  const targetPages = Math.min(
    Math.max(1, options.pages ?? DEFAULT_BROWSE_BATCH_PAGES),
    MAX_BROWSE_BATCH_PAGES
  );
  const startUrl = normalizeTargetUrl(options.pageUrl, options.localBaseUrl);
  const visited = new Set<string>();
  const collectedItems: MediaItem[] = [];
  const mergedCategorySources: Record<string, CategorySource> = {};
  const visitedUrls: string[] = [];

  let currentUrl: string | undefined = startUrl;
  let pagesFetched = 0;
  let nextPageUrl: string | undefined;

  for (let i = 0; i < targetPages && currentUrl; i++) {
    if (options.signal?.aborted) break;
    if (visited.has(currentUrl)) break;

    if (i > 0) {
      await sleepWithAbort(randomPageDelayMs(), options.signal);
      if (options.signal?.aborted) break;
    }

    visited.add(currentUrl);
    visitedUrls.push(currentUrl);

    const single: CrawlResult = await crawlServer({
      url: currentUrl,
      mode: 'quick',
      maxPages: 1,
      maxDepth: 0,
      localBaseUrl: options.localBaseUrl,
      signal: options.signal,
    });

    pagesFetched++;

    const mapped = options.categoryName
      ? single.items.map((item) => ({
          ...item,
          category: options.categoryName!,
          folderPath: '/' + options.categoryName!,
        }))
      : single.items;

    for (const item of mapped) {
      collectedItems.push(item);
    }

    if (single.categorySources) {
      for (const [k, v] of Object.entries(single.categorySources)) {
        if (!mergedCategorySources[k]) {
          mergedCategorySources[k] = v;
        }
      }
    }

    const candidateNext: string | undefined =
      single.nextPageUrl ||
      (single.items.length > 0 ? inferNextPaginatedUrl(currentUrl) : undefined);

    if (candidateNext && !visited.has(candidateNext) && single.items.length > 0) {
      nextPageUrl = candidateNext;
      currentUrl = candidateNext;
    } else {
      nextPageUrl = undefined;
      currentUrl = undefined;
      break;
    }
  }

  const dedupedItems = deduplicateMediaItems(collectedItems, { acrossCategories: true });

  return {
    items: dedupedItems,
    nextPageUrl,
    pagesFetched,
    visitedUrls,
    categorySources:
      Object.keys(mergedCategorySources).length > 0 ? mergedCategorySources : undefined,
    hasMore: Boolean(nextPageUrl) && dedupedItems.length > 0,
  };
}

export async function browseServerPage(options: {
  pageUrl: string;
  categoryName?: string;
  localBaseUrl?: string;
}): Promise<{
  items: MediaItem[];
  nextPageUrl?: string;
  categorySources?: Record<string, CategorySource>;
}> {
  const batch = await browseServerPagesBatch({
    ...options,
    pages: 1,
  });

  return {
    items: batch.items,
    nextPageUrl: batch.nextPageUrl,
    categorySources: batch.categorySources,
  };
}

export async function fetchLatestServerUpdates(options: {
  serverUrl: string;
  latestUrl?: string;
  localBaseUrl?: string;
}): Promise<{
  items: MediaItem[];
  latestUrl: string;
  nextPageUrl?: string;
  checkedAt: number;
}> {
  const normalizedServer = normalizeTargetUrl(options.serverUrl, options.localBaseUrl);
  const targetLatestUrl = options.latestUrl
    ? normalizeTargetUrl(options.latestUrl, options.localBaseUrl)
    : resolveLatestFeedUrl(normalizedServer);

  const browsed = await browseServerPage({
    pageUrl: targetLatestUrl,
    categoryName: 'Adicionados Recentemente',
    localBaseUrl: options.localBaseUrl,
  });

  return {
    items: browsed.items,
    latestUrl: targetLatestUrl,
    nextPageUrl: browsed.nextPageUrl,
    checkedAt: Date.now(),
  };
}

export async function searchServerContent(options: {
  serverUrl: string;
  query: string;
  page?: number;
  pages?: number;
  localBaseUrl?: string;
  signal?: AbortSignal;
}): Promise<{
  items: MediaItem[];
  searchUrl: string;
  page: number;
  nextPage: number;
  pagesFetched: number;
  hasMore: boolean;
  nextPageUrl?: string;
}> {
  const rootUrl = normalizeTargetUrl(options.serverUrl, options.localBaseUrl);
  const rootParsed = new URL(rootUrl);
  const host = rootParsed.hostname.toLowerCase();
  const q = options.query.trim();
  const startPage = Math.max(1, options.page || 1);
  const batchPages = Math.min(Math.max(1, options.pages ?? 3), MAX_BROWSE_BATCH_PAGES);

  if (!q) {
    return {
      items: [],
      searchUrl: rootUrl,
      page: startPage,
      nextPage: startPage + 1,
      pagesFetched: 0,
      hasMore: false,
    };
  }

  const encoded = encodeURIComponent(q);

  const buildSearchCandidates = async (targetPage: number): Promise<string[]> => {
    const candidates: string[] = [];
    if (host.includes('pornhub')) {
      candidates.push(
        targetPage === 1
          ? `${rootParsed.origin}/video/search?search=${encoded}`
          : `${rootParsed.origin}/video/search?search=${encoded}&page=${targetPage}`
      );
    } else if (host.includes('xvideos')) {
      candidates.push(
        targetPage === 1
          ? `${rootParsed.origin}/?k=${encoded}`
          : `${rootParsed.origin}/?k=${encoded}&p=${targetPage - 1}`
      );
    } else if (host.includes('xhamster')) {
      candidates.push(
        targetPage === 1
          ? `${rootParsed.origin}/search/${encoded}`
          : `${rootParsed.origin}/search/${encoded}?page=${targetPage}`
      );
    } else if (host.includes('redtube')) {
      candidates.push(
        targetPage === 1
          ? `${rootParsed.origin}/?search=${encoded}`
          : `${rootParsed.origin}/?search=${encoded}&page=${targetPage}`
      );
    } else if (host.includes('eporner')) {
      candidates.push(
        targetPage === 1
          ? `${rootParsed.origin}/search/${encoded}/`
          : `${rootParsed.origin}/search/${encoded}/${targetPage}/`
      );
    } else if (host.includes('spankbang')) {
      candidates.push(
        targetPage === 1
          ? `${rootParsed.origin}/s/${encoded}/`
          : `${rootParsed.origin}/s/${encoded}/${targetPage}/`
      );
    } else {
      try {
        const cookieJar = new Map<string, string>();
        const res = await fetchWithPortalCookies(rootUrl, cookieJar, 8000);
        if (res.ok) {
          let html: string | null = await res.text();
          let $: cheerio.CheerioAPI | null = cheerio.load(html);
          $('form').each((_, formEl) => {
            if (!$) return;
            const $form = $(formEl);
            const action = $form.attr('action') || rootUrl;
            const input = $form.find('input[type="search"], input[name="q"], input[name="s"], input[name="search"], input[name="k"], input[name="query"]').first();
            const paramName = input.attr('name');
            if (paramName) {
              try {
                const target = new URL(action, rootUrl);
                target.searchParams.set(paramName, q);
                if (targetPage > 1) target.searchParams.set('page', String(targetPage));
                candidates.push(target.toString());
              } catch {
                // ignore invalid action
              }
            }
          });
          try {
            $.root().empty();
          } catch {
            // ignore
          }
          $ = null;
          html = null;
        }
      } catch {
        // ignore form inspection errors
      }

      if (candidates.length === 0) {
        const pageSuffix = targetPage > 1 ? `&page=${targetPage}` : '';
        candidates.push(`${rootParsed.origin}/?s=${encoded}${pageSuffix}`);
        candidates.push(`${rootParsed.origin}/search?q=${encoded}${pageSuffix}`);
      }
    }
    return candidates;
  };

  const collected: MediaItem[] = [];
  let primarySearchUrl = rootUrl;
  let discoveredNextUrl: string | undefined;
  let lastLoadedPage = startPage;
  let pagesFetched = 0;

  for (let offset = 0; offset < batchPages; offset++) {
    if (options.signal?.aborted) break;
    const currentPageNum = startPage + offset;

    if (offset > 0) {
      await sleepWithAbort(randomPageDelayMs(), options.signal);
      if (options.signal?.aborted) break;
    }

    const candidates = await buildSearchCandidates(currentPageNum);
    if (offset === 0 && candidates[0]) {
      primarySearchUrl = candidates[0];
    }

    let pageItemsCount = 0;
    let pageNextUrl: string | undefined;

    for (const searchPageUrl of candidates.slice(0, 2)) {
      try {
        const result = await crawlServer({
          url: searchPageUrl,
          mode: 'quick',
          maxPages: 1,
          maxDepth: 0,
          localBaseUrl: options.localBaseUrl,
          signal: options.signal,
        });

        if (result.nextPageUrl) pageNextUrl = result.nextPageUrl;
        for (const item of result.items) {
          collected.push({
            ...item,
            category: `Busca: ${q}`,
            folderPath: `/Busca/${q}`,
          });
          pageItemsCount++;
        }
        if (pageItemsCount > 0) break;
      } catch {
        // continue trying next candidate
      }
    }

    if (pageItemsCount === 0 && offset > 0) {
      discoveredNextUrl = undefined;
      break;
    }

    pagesFetched++;
    lastLoadedPage = currentPageNum;
    discoveredNextUrl = pageNextUrl;

    if (pageItemsCount === 0) {
      break;
    }
  }

  const deduped = deduplicateMediaItems(collected, { acrossCategories: true });
  return {
    items: deduped,
    searchUrl: primarySearchUrl,
    page: lastLoadedPage,
    nextPage: lastLoadedPage + 1,
    pagesFetched,
    hasMore: Boolean(discoveredNextUrl) || (pagesFetched === batchPages && deduped.length >= 16),
    nextPageUrl: discoveredNextUrl,
  };
}

