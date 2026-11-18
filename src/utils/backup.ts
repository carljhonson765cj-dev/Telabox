import type { MediaItem, ServerKind, ServerProfile } from '../types/media';
import { deduplicateMediaItems } from './dedupeMedia';

export interface TelaBoxBackupPayload {
  app: 'TelaBox';
  version: number;
  exportedAt: string;
  servers: ServerProfile[];
  favorites: MediaItem[];
}

export function buildBackupJson(servers: ServerProfile[], favorites: MediaItem[]): string {
  const payload: TelaBoxBackupPayload = {
    app: 'TelaBox',
    version: 1,
    exportedAt: new Date().toISOString(),
    servers,
    favorites,
  };
  return JSON.stringify(payload, null, 2);
}

function sanitizeMediaItem(raw: unknown): MediaItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const url = typeof obj.url === 'string' ? obj.url.trim() : '';
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  if (!url || !title) return null;

  const streamType =
    obj.streamType === 'hls' ||
    obj.streamType === 'dash' ||
    obj.streamType === 'video' ||
    obj.streamType === 'page' ||
    obj.streamType === 'embed'
      ? obj.streamType
      : 'page';

  const id =
    typeof obj.id === 'string' && obj.id.trim()
      ? obj.id.trim()
      : `item_${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    title,
    rawTitle:
      typeof obj.rawTitle === 'string' && obj.rawTitle.trim() ? obj.rawTitle.trim() : title,
    url,
    sourcePageUrl:
      typeof obj.sourcePageUrl === 'string' && obj.sourcePageUrl.trim()
        ? obj.sourcePageUrl.trim()
        : url,
    streamType,
    thumbnail: typeof obj.thumbnail === 'string' ? obj.thumbnail : undefined,
    duration: typeof obj.duration === 'string' ? obj.duration : undefined,
    quality: typeof obj.quality === 'string' ? obj.quality : undefined,
    size: typeof obj.size === 'string' ? obj.size : undefined,
    format: typeof obj.format === 'string' ? obj.format : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    category: typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : 'Geral',
    folderPath:
      typeof obj.folderPath === 'string' && obj.folderPath.trim() ? obj.folderPath.trim() : '/',
    subtitles: Array.isArray(obj.subtitles) ? obj.subtitles : undefined,
    qualities: Array.isArray(obj.qualities) ? obj.qualities : undefined,
  };
}

function sanitizeServerProfile(raw: unknown): ServerProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const url = typeof obj.url === 'string' ? obj.url.trim() : '';
  if (!url) return null;

  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = deduplicateMediaItems(
    rawItems.map(sanitizeMediaItem).filter((item): item is MediaItem => item !== null)
  );
  const derivedCategories = Array.from(new Set(items.map((i) => i.category))).sort((a, b) =>
    a.localeCompare(b, 'pt-BR')
  );
  const rawCategories = Array.isArray(obj.categories)
    ? obj.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  const categories = Array.from(new Set([...derivedCategories, ...rawCategories]));

  const id =
    typeof obj.id === 'string' && obj.id.trim()
      ? obj.id.trim()
      : `srv_${Math.random().toString(36).slice(2, 10)}`;

  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : url.replace(/^https?:\/\//i, '').split('/')[0] || 'Servidor Importado';

  const serverKind: ServerKind =
    obj.serverKind === 'directory' ||
    obj.serverKind === 'portal' ||
    obj.serverKind === 'iptv' ||
    obj.serverKind === 'feed'
      ? obj.serverKind
      : 'portal';

  const scannedAt =
    typeof obj.scannedAt === 'number' && Number.isFinite(obj.scannedAt)
      ? obj.scannedAt
      : Date.now();

  return {
    id,
    name,
    url,
    scannedAt,
    scanMode: obj.scanMode === 'quick' ? 'quick' : 'full',
    useProxy: typeof obj.useProxy === 'boolean' ? obj.useProxy : true,
    serverKind,
    pagesScanned: typeof obj.pagesScanned === 'number' ? obj.pagesScanned : 1,
    foldersFound: typeof obj.foldersFound === 'number' ? obj.foldersFound : 0,
    categories,
    items,
    categorySources:
      obj.categorySources && typeof obj.categorySources === 'object'
        ? (obj.categorySources as ServerProfile['categorySources'])
        : undefined,
    nextPageUrl: typeof obj.nextPageUrl === 'string' ? obj.nextPageUrl : undefined,
    latestUrl: typeof obj.latestUrl === 'string' ? obj.latestUrl : undefined,
    lastUpdatedAt:
      typeof obj.lastUpdatedAt === 'number' ? obj.lastUpdatedAt : scannedAt,
  };
}

export function parseBackupJson(rawText: string): {
  servers: ServerProfile[];
  favorites: MediaItem[];
} {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('Cole o texto JSON ou selecione um arquivo de backup válido.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('O conteúdo não é um JSON válido. Verifique se o texto foi copiado por completo.');
  }

  let rawServers: unknown[] = [];
  let rawFavorites: unknown[] = [];

  if (Array.isArray(parsed)) {
    rawServers = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.servers)) rawServers = obj.servers;
    if (Array.isArray(obj.favorites)) rawFavorites = obj.favorites;
  } else {
    throw new Error('Formato de backup não reconhecido.');
  }

  const servers = rawServers
    .map(sanitizeServerProfile)
    .filter((s): s is ServerProfile => s !== null);
  const favorites = deduplicateMediaItems(
    rawFavorites.map(sanitizeMediaItem).filter((f): f is MediaItem => f !== null),
    { acrossCategories: true }
  );

  if (servers.length === 0 && favorites.length === 0) {
    throw new Error('Nenhum servidor ou favorito válido encontrado neste backup.');
  }

  return { servers, favorites };
}
