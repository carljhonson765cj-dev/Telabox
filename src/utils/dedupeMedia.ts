import type { MediaItem, QualityOption } from '../types/media';

const TRACKING_PARAMS = new Set([
  'pkey',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'ref',
  'from',
  'sid',
  'list',
  'index',
  't',
]);

export function canonicalizeMediaUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim());
    u.hash = '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathLower = u.pathname.toLowerCase();

    // Pornhub watch URL canonical identity is viewkey
    if (pathLower.includes('/view_video.php')) {
      const viewkey = u.searchParams.get('viewkey');
      if (viewkey) {
        return `https://${host}/view_video.php?viewkey=${viewkey}`;
      }
    }

    // XVideos watch URL canonical identity is /video.<id> or /video<id>
    const xvMatch = u.pathname.match(/\/(video\.[a-z0-9]+|video\d+)(?:\/|$)/i);
    if (xvMatch) {
      return `https://${host}/${xvMatch[1].toLowerCase()}`;
    }

    // YouTube watch URL canonical identity is v
    if (pathLower === '/watch' && u.searchParams.has('v')) {
      return `https://${host}/watch?v=${u.searchParams.get('v')}`;
    }

    for (const key of Array.from(u.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
      }
    }

    u.searchParams.sort();
    const cleanPath =
      u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    const search = u.searchParams.toString();
    return `${u.protocol}//${host}${cleanPath}${search ? `?${search}` : ''}`;
  } catch {
    return rawUrl.trim();
  }
}

export function normalizeMediaTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function mergeMediaItemMeta(existing: MediaItem, incoming: MediaItem): MediaItem {
  let mergedQualities = existing.qualities;
  if (incoming.qualities && incoming.qualities.length > 0) {
    const qMap = new Map<string, QualityOption>();
    for (const q of existing.qualities || []) qMap.set(q.url, q);
    for (const q of incoming.qualities) {
      if (!qMap.has(q.url)) qMap.set(q.url, q);
    }
    mergedQualities = Array.from(qMap.values());
  }

  return {
    ...existing,
    thumbnail: existing.thumbnail || incoming.thumbnail,
    description: existing.description || incoming.description,
    duration: existing.duration || incoming.duration,
    quality: existing.quality || incoming.quality,
    size: existing.size || incoming.size,
    subtitles:
      existing.subtitles && existing.subtitles.length > 0
        ? existing.subtitles
        : incoming.subtitles,
    qualities: mergedQualities,
  };
}

export function deduplicateMediaItems(
  items: MediaItem[],
  options?: { acrossCategories?: boolean }
): MediaItem[] {
  const result: MediaItem[] = [];
  const keyToIndex = new Map<string, number>();

  for (const item of items) {
    const canonUrl = canonicalizeMediaUrl(item.url);
    const normTitle = normalizeMediaTitle(item.title || item.rawTitle || '');
    const catKey = normalizeMediaTitle(item.category || '');
    const durKey = (item.duration || '').trim().toLowerCase();

    const keys: string[] = [
      `url:${canonUrl}`,
      `id:${item.id}`,
    ];
    if (normTitle.length >= 4 && durKey) {
      keys.push(`td:${normTitle}::${durKey}`);
    }
    if (normTitle.length >= 4 && catKey) {
      keys.push(`ct:${catKey}::${normTitle}`);
    }
    if (normTitle.length >= (options?.acrossCategories ? 10 : 18)) {
      keys.push(`t:${normTitle}`);
    }

    let existingIdx: number | undefined;
    for (const k of keys) {
      const found = keyToIndex.get(k);
      if (found !== undefined) {
        existingIdx = found;
        break;
      }
    }

    if (existingIdx !== undefined) {
      result[existingIdx] = mergeMediaItemMeta(result[existingIdx], item);
    } else {
      const idx = result.length;
      result.push(item);
      for (const k of keys) {
        keyToIndex.set(k, idx);
      }
    }
  }

  return result;
}
