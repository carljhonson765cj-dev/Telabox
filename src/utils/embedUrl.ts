/**
 * Converts standard video watch-page URLs (which commonly send X-Frame-Options: DENY/SAMEORIGIN)
 * into their official iframe-embeddable player URLs so Embed/Iframe mode never renders a black screen.
 */
export function toOfficialEmbedUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))) {
    return null;
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }

  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const proto = u.protocol === 'http:' ? 'https:' : u.protocol;

  // Already an official embed URL on supported portals
  if (host.includes('pornhub')) {
    const embedPathMatch = path.match(/\/embed\/([a-zA-Z0-9_-]+)/i);
    if (embedPathMatch) {
      const targetHost = host.endsWith('.org') ? 'www.pornhub.org' : 'www.pornhub.com';
      return `https://${targetHost}/embed/${embedPathMatch[1]}`;
    }
    const viewKey =
      u.searchParams.get('viewkey') || trimmed.match(/[?&]viewkey=([a-zA-Z0-9_-]+)/i)?.[1];
    if (viewKey) {
      const targetHost = host.endsWith('.org') ? 'www.pornhub.org' : 'www.pornhub.com';
      return `https://${targetHost}/embed/${viewKey}`;
    }
  }

  // Generic viewkey= link fallback -> Pornhub embed format
  const genericViewKey =
    u.searchParams.get('viewkey') || trimmed.match(/[?&]viewkey=([a-zA-Z0-9_-]+)/i)?.[1];
  if (genericViewKey) {
    return `${proto}//${u.host}/embed/${genericViewKey}`;
  }

  // xHamster watch URLs -> https://xhamster.com/embed/<id>
  if (host.includes('xhamster')) {
    const normalizeXhamsterOrigin = () => {
      if (host === 'xhamster.com' || host.endsWith('.xhamster.com')) {
        return 'https://xhamster.com';
      }
      return `${proto}//${host.replace(/^(?:m|pt|br|es|fr|de|it|ru|pl|nl|jp)\./, '')}`;
    };

    const existingEmbed = path.match(/\/embed\/([a-zA-Z0-9_-]+)/i);
    if (existingEmbed) {
      return `${normalizeXhamsterOrigin()}/embed/${existingEmbed[1]}`;
    }

    const xhVideoMatch = path.match(/-(xh[a-zA-Z0-9]+|\d{4,})(?:\.html?)?\/?$/i);
    if (xhVideoMatch) {
      return `${normalizeXhamsterOrigin()}/embed/${xhVideoMatch[1]}`;
    }

    const xhMovieMatch = path.match(/\/movies\/(\d+)(?:\/|$)/i);
    if (xhMovieMatch) {
      return `${normalizeXhamsterOrigin()}/embed/${xhMovieMatch[1]}`;
    }
  }

  // XVideos / XNXX watch URLs -> /embedframe/<id>
  if (host.includes('xvideos') || host.includes('xnxx')) {
    const cleanHost = host.replace(/^m\./, 'www.');
    if (/\/embedframe\//i.test(path)) {
      return `${proto}//${cleanHost}${path}`;
    }
    const xvMatch =
      path.match(/\/video\.([a-zA-Z0-9]+)(?:\/|$)/i) ||
      path.match(/\/video-([a-zA-Z0-9]+)(?:\/|$)/i) ||
      path.match(/\/video(\d+)(?:\/|$)/i);
    if (xvMatch) {
      return `${proto}//${cleanHost}/embedframe/${xvMatch[1]}`;
    }
  }

  // RedTube watch URLs -> https://embed.redtube.com/?id=<id>
  if (host.includes('redtube')) {
    if (host.startsWith('embed.') && u.searchParams.get('id')) {
      return `https://embed.redtube.com/?id=${u.searchParams.get('id')}`;
    }
    const rtMatch = path.match(/\/(\d{4,})(?:\/|$)/);
    if (rtMatch) {
      return `https://embed.redtube.com/?id=${rtMatch[1]}`;
    }
  }

  // YouPorn watch URLs -> https://www.youporn.com/embed/<id>
  if (host.includes('youporn')) {
    const ypEmbed = path.match(/\/embed\/(\d+)/i);
    if (ypEmbed) {
      return `https://www.youporn.com/embed/${ypEmbed[1]}`;
    }
    const ypMatch = path.match(/\/watch\/(\d+)/i);
    if (ypMatch) {
      return `https://www.youporn.com/embed/${ypMatch[1]}`;
    }
  }

  // SpankBang watch URLs -> /<id>/embed/
  if (host.includes('spankbang')) {
    if (/^\/[a-zA-Z0-9]+\/embed\/?$/i.test(path)) {
      return `${proto}//${u.host}${path}`;
    }
    const sbMatch = path.match(/^\/([a-zA-Z0-9]+)\/video(?:\/|$)/i);
    if (sbMatch) {
      return `${proto}//${u.host}/${sbMatch[1]}/embed/`;
    }
  }

  // Eporner watch URLs -> https://www.eporner.com/embed/<id>/
  if (host.includes('eporner')) {
    const epEmbed = path.match(/\/embed\/([a-zA-Z0-9]+)/i);
    if (epEmbed) {
      return `https://www.eporner.com/embed/${epEmbed[1]}/`;
    }
    const epMatch =
      path.match(/\/(?:video|hd-porn)-([a-zA-Z0-9]+)(?:\/|$)/i) ||
      path.match(/\/hd-porn\/([a-zA-Z0-9]+)(?:\/|$)/i);
    if (epMatch) {
      return `https://www.eporner.com/embed/${epMatch[1]}/`;
    }
  }

  // Tube8 watch URLs -> https://www.tube8.com/embed/<cat>/<slug>/<id>/
  if (host.includes('tube8')) {
    if (/\/embed\//i.test(path)) {
      return `https://www.tube8.com${path}`;
    }
    const t8Match = path.match(/\/([^/]+\/[^/]+\/\d+)\/?$/i);
    if (t8Match) {
      return `https://www.tube8.com/embed/${t8Match[1]}/`;
    }
  }

  // Generic already-embed path detection
  if (/\/(?:embed|embedframe)\//i.test(path)) {
    return trimmed;
  }

  return null;
}
