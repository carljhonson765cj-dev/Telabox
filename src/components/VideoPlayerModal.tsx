import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  AlertCircle,
  Captions,
  Check,
  ChevronLeft,
  ChevronUp,
  Download,
  ListVideo,
  Loader2,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipBack,
  SkipForward,
  Star,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { MediaItem, QualityOption, WatchProgress } from '../types/media';
import { fetchJson } from '../utils/safeFetch';
import { toOfficialEmbedUrl } from '../utils/embedUrl';

interface VideoPlayerModalProps {
  item: MediaItem;
  playlist: MediaItem[];
  initialUseProxy: boolean;
  initialTime?: number;
  isFavorite: boolean;
  onToggleFavorite: (item: MediaItem) => void;
  onSelectItem: (item: MediaItem) => void;
  onSaveProgress: (progress: WatchProgress) => void;
  onClose: () => void;
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '00:00';
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function pickInitialQualityIndex(options: QualityOption[]): number {
  if (options.length <= 1) return 0;

  // Avoid starting on AV1 if any H.264 / standard codec option is available
  const firstH264Idx = options.findIndex(
    (q) => !/\bav1\b/i.test(q.label) && !/\.av1\b/i.test(q.url)
  );
  const safePool =
    firstH264Idx >= 0
      ? options
          .map((q, idx) => ({ q, idx }))
          .filter(({ q }) => !/\bav1\b/i.test(q.label) && !/\.av1\b/i.test(q.url))
      : options.map((q, idx) => ({ q, idx }));

  const isConstrainedTv =
    (typeof window !== 'undefined' && window.screen?.height <= 1080) ||
    (typeof navigator !== 'undefined' &&
      /Android|TV|MiStick|MIBOX|AFT|BRAVIA/i.test(navigator.userAgent));
  if (!isConstrainedTv) return safePool[0].idx;

  // On Mi TV Stick (1080p hardware decoder, 1GB RAM), avoid starting on 1440p/4K MP4
  const idx1080 = safePool.find(({ q }) => /1080/i.test(q.label));
  if (idx1080) return idx1080.idx;
  const idxHls = safePool.find(({ q }) => q.streamType === 'hls');
  if (idxHls) return idxHls.idx;
  const idx720 = safePool.find(({ q }) => /720/i.test(q.label));
  if (idx720) return idx720.idx;
  return safePool[0].idx;
}

export function VideoPlayerModal({
  item,
  playlist,
  initialUseProxy,
  initialTime = 0,
  isFavorite,
  onToggleFavorite,
  onSelectItem,
  onSaveProgress,
  onClose,
}: VideoPlayerModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const voltarBtnRef = useRef<HTMLButtonElement>(null);
  const playBtnRef = useRef<HTMLButtonElement>(null);
  const errorRetryBtnRef = useRef<HTMLButtonElement>(null);
  const queueCloseBtnRef = useRef<HTMLButtonElement>(null);
  const qualityBtnRef = useRef<HTMLButtonElement>(null);
  const activeQualityItemRef = useRef<HTMLButtonElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const embedFirstControlRef = useRef<HTMLButtonElement>(null);
  const seekIndicatorTimerRef = useRef<number | null>(null);

  const [playbackMode, setPlaybackMode] = useState<'direct' | 'proxy' | 'embed'>(() =>
    item.streamType === 'embed' ? 'embed' : initialUseProxy ? 'proxy' : 'direct'
  );
  const useProxy = playbackMode === 'proxy';
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [showQueue, setShowQueue] = useState(false);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [seekIndicator, setSeekIndicator] = useState<{
    delta: number;
    targetTime: number;
    key: number;
  } | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  // Lazy stream resolution & automatic embed/iframe fallback state
  const [resolving, setResolving] = useState(item.streamType === 'page');
  const [resolvedUrl, setResolvedUrl] = useState<string>(
    item.streamType === 'page' ? '' : item.url
  );
  const [resolvedType, setResolvedType] = useState<'video' | 'hls' | 'dash' | 'embed'>(
    item.streamType === 'page' ? 'hls' : item.streamType
  );
  const [resolvedReferer, setResolvedReferer] = useState<string>(item.sourcePageUrl || item.url);
  const [resolvedUserAgent, setResolvedUserAgent] = useState<string>('');
  const [qualities, setQualities] = useState<QualityOption[]>(item.qualities || []);
  const [qualityIndex, setQualityIndex] = useState(() =>
    pickInitialQualityIndex(item.qualities || [])
  );
  const [embedFallbackUrl, setEmbedFallbackUrl] = useState<string>(
    () => toOfficialEmbedUrl(item.sourcePageUrl || item.url) || item.sourcePageUrl || item.url
  );
  const [iframeDirectMode, setIframeDirectMode] = useState<boolean>(() =>
    Boolean(toOfficialEmbedUrl(item.sourcePageUrl || item.url))
  );
  const [iframeTargetMode, setIframeTargetMode] = useState<'embed' | 'page'>('embed');
  const [iframeReloadNonce, setIframeReloadNonce] = useState<number>(0);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [controlsActivityTick, setControlsActivityTick] = useState<number>(0);

  const hideTimerRef = useRef<number | null>(null);
  const frameStallTimerRef = useRef<number | null>(null);
  const hasFirstFrameRef = useRef<boolean>(false);
  const initialSeekRef = useRef<number>(initialTime);
  const appliedInitialSeekForIdRef = useRef<string | null>(null);
  const lastSavedAtRef = useRef<number>(0);
  const triedQualityCountRef = useRef<number>(0);
  const autoSwitchedRouteRef = useRef<boolean>(false);
  const autoSwitchedToEmbedRef = useRef<boolean>(false);
  const [resolveAttempt, setResolveAttempt] = useState(0);

  useEffect(() => {
    triedQualityCountRef.current = 0;
    autoSwitchedRouteRef.current = false;
    autoSwitchedToEmbedRef.current = false;
    hasFirstFrameRef.current = false;
    setHasFirstFrame(false);
    setPlaybackMode(item.streamType === 'embed' ? 'embed' : initialUseProxy ? 'proxy' : 'direct');
    setResolvedUserAgent('');
    setIframeDirectMode(Boolean(toOfficialEmbedUrl(item.sourcePageUrl || item.url)));
    setIframeTargetMode('embed');
    setFallbackNotice(null);
    setShowQualityMenu(false);
    setSeekIndicator(null);
    if (appliedInitialSeekForIdRef.current !== item.id) {
      initialSeekRef.current = initialTime;
    }
  }, [item.id, item.url, item.sourcePageUrl, item.streamType, initialTime, initialUseProxy]);

  const currentIndex = useMemo(
    () => playlist.findIndex((p) => p.id === item.id),
    [playlist, item.id]
  );

  const prevItem = currentIndex > 0 ? playlist[currentIndex - 1] : null;
  const nextItem =
    currentIndex >= 0 && currentIndex < playlist.length - 1
      ? playlist[currentIndex + 1]
      : null;

  // Resolve portal watch pages on demand (with automatic embed/page fallback on anti-bot or extraction failure)
  useEffect(() => {
    let cancelled = false;
    setPlayerError(null);
    setCurrentTime(0);
    setDuration(0);

    if (item.streamType !== 'page') {
      const sourceCandidate = item.sourcePageUrl || item.url;
      const officialEmbed = toOfficialEmbedUrl(sourceCandidate) || toOfficialEmbedUrl(item.url);
      const resolvedInitialUrl =
        item.streamType === 'embed' && officialEmbed ? officialEmbed : item.url;
      setResolving(false);
      setResolvedUrl(resolvedInitialUrl);
      setResolvedType(item.streamType);
      setResolvedReferer(sourceCandidate);
      setResolvedUserAgent('');
      setEmbedFallbackUrl(officialEmbed || sourceCandidate);
      setQualities(item.qualities || []);
      setQualityIndex(pickInitialQualityIndex(item.qualities || []));
      setPlaybackMode(item.streamType === 'embed' ? 'embed' : initialUseProxy ? 'proxy' : 'direct');
      if (item.streamType === 'embed') {
        setIframeTargetMode(officialEmbed ? 'embed' : 'page');
        setIframeDirectMode(Boolean(officialEmbed));
      }
      return;
    }

    setResolving(true);
    setResolvedUrl('');

    (async () => {
      try {
        const { ok, data } = await fetchJson<{
          streamUrl?: string;
          streamType?: 'hls' | 'dash' | 'video' | 'embed';
          referer?: string;
          userAgent?: string;
          qualities?: QualityOption[];
          embedFallbackUrl?: string;
          fallbackMode?: 'embed' | 'page';
          fallbackReason?: string;
          directBlocked?: boolean;
          error?: string;
        }>(`/api/resolve?url=${encodeURIComponent(item.url)}`);
        if (cancelled) return;
        if (!ok || !data.streamUrl) {
          throw new Error(data.error || 'Não foi possível extrair o fluxo deste vídeo.');
        }
        const nextQualities = Array.isArray(data.qualities) ? data.qualities : [];
        const rawFallback = data.embedFallbackUrl || item.sourcePageUrl || item.url;
        const officialEmbed =
          toOfficialEmbedUrl(rawFallback) ||
          toOfficialEmbedUrl(item.sourcePageUrl || item.url);
        const fallbackTarget = officialEmbed || rawFallback;
        setEmbedFallbackUrl(fallbackTarget);
        setResolvedUrl(
          data.streamType === 'embed' ? officialEmbed || data.streamUrl : data.streamUrl
        );
        setResolvedType(data.streamType || 'hls');
        setResolvedReferer(data.referer || item.url);
        setResolvedUserAgent(data.userAgent || '');
        setQualities(nextQualities);
        setQualityIndex(pickInitialQualityIndex(nextQualities));
        if (data.streamType === 'embed') {
          autoSwitchedToEmbedRef.current = true;
          const useOfficialEmbed = Boolean(officialEmbed) || data.fallbackMode !== 'page';
          setPlaybackMode('embed');
          setIframeTargetMode(useOfficialEmbed ? 'embed' : 'page');
          setIframeDirectMode(Boolean(officialEmbed) || data.fallbackMode === 'embed');
          setFallbackNotice(
            data.fallbackReason ||
              'Stream direto indisponível — exibindo player incorporado em tela cheia.'
          );
        } else {
          setPlaybackMode(initialUseProxy ? 'proxy' : 'direct');
        }
        setResolving(false);
      } catch (err) {
        if (cancelled) return;
        setResolving(false);
        const canFallbackToPage =
          item.url.startsWith('http://') ||
          item.url.startsWith('https://') ||
          item.url.startsWith('/demo-server');
        if (canFallbackToPage && !autoSwitchedToEmbedRef.current) {
          autoSwitchedToEmbedRef.current = true;
          const sourcePage = item.sourcePageUrl || item.url;
          const officialEmbed = toOfficialEmbedUrl(sourcePage);
          const targetUrl = officialEmbed || sourcePage;
          setEmbedFallbackUrl(targetUrl);
          setResolvedUrl(targetUrl);
          setResolvedType('embed');
          setResolvedReferer(sourcePage);
          setPlaybackMode('embed');
          setIframeTargetMode(officialEmbed ? 'embed' : 'page');
          setIframeDirectMode(Boolean(officialEmbed));
          setFallbackNotice(
            officialEmbed
              ? 'Abrindo player oficial incorporado em tela cheia.'
              : err instanceof Error
              ? `${err.message} Abrindo página do vídeo via proxy em tela cheia.`
              : 'Extração direta bloqueada — abrindo página do vídeo via proxy.'
          );
        } else {
          setPlayerError(
            err instanceof Error ? err.message : 'Erro ao extrair fluxo de vídeo da página.'
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [item.id, item.url, item.streamType, item.sourcePageUrl, initialUseProxy, resolveAttempt]);

  const activeQuality = qualities[qualityIndex];
  const baseStreamUrl = activeQuality ? activeQuality.url : resolvedUrl;
  const baseStreamType = activeQuality ? activeQuality.streamType : resolvedType;
  const effectiveType: 'video' | 'hls' | 'dash' | 'embed' =
    playbackMode === 'embed' ? 'embed' : baseStreamType;
  const effectiveUrl =
    playbackMode === 'embed'
      ? embedFallbackUrl || item.sourcePageUrl || item.url || baseStreamUrl
      : baseStreamUrl;

  const activeIframeTargetUrl = useMemo(() => {
    if (effectiveType !== 'embed') return '';
    const rawWatchUrl = item.sourcePageUrl || item.url;
    if (iframeTargetMode === 'page') {
      return rawWatchUrl || embedFallbackUrl || effectiveUrl;
    }
    const candidate = embedFallbackUrl || effectiveUrl || rawWatchUrl;
    return toOfficialEmbedUrl(candidate) || toOfficialEmbedUrl(rawWatchUrl) || candidate;
  }, [effectiveType, iframeTargetMode, item.sourcePageUrl, item.url, embedFallbackUrl, effectiveUrl]);

  const streamUrl = useMemo(() => {
    if (!effectiveUrl) return '';
    if (effectiveType === 'embed') {
      const target = activeIframeTargetUrl || effectiveUrl;
      const convertedTarget =
        iframeTargetMode === 'embed' ? toOfficialEmbedUrl(target) || target : target;
      if (convertedTarget.startsWith('/')) {
        return convertedTarget;
      }
      const isOfficialEmbed =
        Boolean(toOfficialEmbedUrl(convertedTarget)) || iframeTargetMode === 'embed';
      if (iframeDirectMode && isOfficialEmbed) {
        return convertedTarget;
      }
      return `/api/browser?url=${encodeURIComponent(convertedTarget)}&_r=${iframeReloadNonce}`;
    }
    if (useProxy && !effectiveUrl.startsWith('/')) {
      const refPart = resolvedReferer
        ? `&referer=${encodeURIComponent(resolvedReferer)}`
        : '';
      const uaPart = resolvedUserAgent
        ? `&ua=${encodeURIComponent(resolvedUserAgent)}`
        : '';
      return `/api/proxy?url=${encodeURIComponent(effectiveUrl)}${refPart}${uaPart}`;
    }
    return effectiveUrl;
  }, [
    effectiveUrl,
    effectiveType,
    activeIframeTargetUrl,
    iframeTargetMode,
    iframeDirectMode,
    iframeReloadNonce,
    useProxy,
    resolvedReferer,
    resolvedUserAgent,
  ]);

  const downloadInfo = useMemo(() => {
    if (resolving || effectiveType === 'embed') return null;

    // Prefer active quality if it's a direct video file; otherwise pick best H.264 MP4 from qualities
    const bestVideoQuality =
      activeQuality?.streamType === 'video'
        ? activeQuality
        : qualities.find(
            (q) =>
              q.streamType === 'video' &&
              !/\bav1\b/i.test(q.label) &&
              !/\.av1\b/i.test(q.url)
          ) || qualities.find((q) => q.streamType === 'video');

    const targetUrl = bestVideoQuality?.url || effectiveUrl;
    const targetType = bestVideoQuality ? 'video' : effectiveType;
    if (!targetUrl) return null;

    const extMatch = targetUrl.split('?')[0].match(/\.(mp4|mkv|webm|mov|m4v|avi|m3u8)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : targetType === 'hls' ? 'm3u8' : 'mp4';
    const baseName = (item.title || 'video')
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'video';
    const fileName = `${baseName}.${ext}`;

    const refPart = resolvedReferer
      ? `&referer=${encodeURIComponent(resolvedReferer)}`
      : '';
    const uaPart = resolvedUserAgent
      ? `&ua=${encodeURIComponent(resolvedUserAgent)}`
      : '';
    const href = targetUrl.startsWith('/')
      ? targetUrl
      : `/api/proxy?url=${encodeURIComponent(targetUrl)}${refPart}${uaPart}&download=1&filename=${encodeURIComponent(fileName)}`;

    return {
      href,
      fileName,
      qualityLabel: bestVideoQuality?.label,
    };
  }, [resolving, effectiveType, activeQuality, qualities, effectiveUrl, item.title, resolvedReferer, resolvedUserAgent]);

  const wakeControls = useCallback(() => {
    setShowControls(true);
    setControlsActivityTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (!showControls || showQueue || showQualityMenu || playerError || resolving) {
      return;
    }
    // Hide controls automatically only when native <video> is actively playing, or hide bottom TV drawer in embed mode
    const shouldAutoHide = effectiveType === 'embed' || (isPlaying && hasFirstFrame);
    if (!shouldAutoHide) return;

    hideTimerRef.current = window.setTimeout(() => {
      setShowControls(false);
    }, 3000);

    return () => {
      if (hideTimerRef.current) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [
    showControls,
    controlsActivityTick,
    showQueue,
    showQualityMenu,
    playerError,
    resolving,
    effectiveType,
    isPlaying,
    hasFirstFrame,
  ]);

  useEffect(() => {
    wakeControls();
    const t = window.setTimeout(() => playBtnRef.current?.focus(), 60);
    return () => {
      window.clearTimeout(t);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (seekIndicatorTimerRef.current) window.clearTimeout(seekIndicatorTimerRef.current);
    };
  }, [item.id, wakeControls]);

  useEffect(() => {
    if (playerError && !resolving) {
      const t = window.setTimeout(() => errorRetryBtnRef.current?.focus(), 40);
      return () => window.clearTimeout(t);
    }
  }, [playerError, resolving]);

  // Auto-hide fallback notice toast after 6s
  useEffect(() => {
    if (!fallbackNotice) return;
    const t = window.setTimeout(() => setFallbackNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [fallbackNotice]);

  // Listen for bridge events from /api/browser when in embed mode (anti-bot auto-switch to direct iframe or native stream capture)
  useEffect(() => {
    if (effectiveType !== 'embed') return;
    const onMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      const msg = event.data as {
        type?: string;
        url?: string;
        streams?: QualityOption[];
      };
      if (msg.type === 'telabox:blocked' && !iframeDirectMode) {
        setIframeDirectMode(true);
        setFallbackNotice(
          'Bloqueio anti-bot no proxy — carregando iframe diretamente no dispositivo.'
        );
      } else if (
        msg.type === 'telabox:streams' &&
        Array.isArray(msg.streams) &&
        msg.streams.length > 0 &&
        qualities.length === 0
      ) {
        // Native stream captured dynamically inside embed browser — make it available cleanly
        setQualities(msg.streams);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [effectiveType, iframeDirectMode, qualities.length]);

  useEffect(() => {
    if (showQualityMenu) {
      const t = window.setTimeout(() => activeQualityItemRef.current?.focus(), 40);
      return () => window.clearTimeout(t);
    }
    if (showQueue) {
      const t = window.setTimeout(() => queueCloseBtnRef.current?.focus(), 40);
      return () => window.clearTimeout(t);
    } else if (!playerError && !resolving) {
      const target = effectiveType === 'embed' ? voltarBtnRef.current : playBtnRef.current;
      const t = window.setTimeout(() => target?.focus(), 40);
      return () => window.clearTimeout(t);
    }
  }, [showQueue, showQualityMenu, playerError, resolving, effectiveType]);

  const switchToEmbedFallback = useCallback(
    (noticeMsg: string) => {
      const rawCandidate = embedFallbackUrl || item.sourcePageUrl || item.url;
      const officialEmbed =
        toOfficialEmbedUrl(rawCandidate) ||
        toOfficialEmbedUrl(item.sourcePageUrl || item.url);
      const fallbackTarget = officialEmbed || rawCandidate;
      const canFallbackToIframe =
        Boolean(fallbackTarget) &&
        (fallbackTarget.startsWith('http://') ||
          fallbackTarget.startsWith('https://') ||
          fallbackTarget.startsWith('/demo-server'));
      if (!canFallbackToIframe) return false;
      autoSwitchedToEmbedRef.current = true;
      setPlayerError(null);
      setEmbedFallbackUrl(fallbackTarget);
      setPlaybackMode('embed');
      const hasEmbedFormat =
        Boolean(officialEmbed) || (fallbackTarget !== item.url && /embed/i.test(fallbackTarget));
      setIframeTargetMode(hasEmbedFormat ? 'embed' : 'page');
      setIframeDirectMode(Boolean(officialEmbed) || hasEmbedFormat);
      setIframeReloadNonce((n) => n + 1);
      setFallbackNotice(noticeMsg);
      return true;
    },
    [embedFallbackUrl, item.sourcePageUrl, item.url]
  );

  const tryFallbackQuality = useCallback(
    (fallbackMsg: string, options?: { isStallTimeout?: boolean }) => {
      const isStallTimeout = Boolean(options?.isStallTimeout);

      // 1) If in Direct mode and it errored or stalled >6s without loading first frame -> auto-retry same URL via /api/proxy with Referer + User-Agent
      if (
        playbackMode === 'direct' &&
        !autoSwitchedRouteRef.current &&
        baseStreamUrl &&
        !baseStreamUrl.startsWith('/')
      ) {
        autoSwitchedRouteRef.current = true;
        if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
          initialSeekRef.current = videoRef.current.currentTime;
          appliedInitialSeekForIdRef.current = null;
        }
        setPlaybackMode('proxy');
        setFallbackNotice(
          isStallTimeout
            ? 'Vídeo demorou mais de 6s no modo Direto — tentando automaticamente via Proxy.'
            : 'Erro no modo Direto — tentando automaticamente via Proxy com Referer/User-Agent originais.'
        );
        return true;
      }

      // 2) If already in Proxy mode and an explicit stream/codec error happened (not a 5s stall timeout), try another extracted quality once before embed
      if (
        !isStallTimeout &&
        playbackMode === 'proxy' &&
        qualities.length > 1 &&
        triedQualityCountRef.current < qualities.length - 1
      ) {
        triedQualityCountRef.current += 1;
        if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
          initialSeekRef.current = videoRef.current.currentTime;
          appliedInitialSeekForIdRef.current = null;
        }
        setQualityIndex((prev) => (prev + 1) % qualities.length);
        return true;
      }

      // 3) If even via Proxy the video fails or takes >5s without starting -> switch automatically to embed / <iframe>
      if (
        !autoSwitchedToEmbedRef.current &&
        switchToEmbedFallback(
          isStallTimeout
            ? 'Proxy sem resposta após 5s — alternando automaticamente para player incorporado (<iframe>).'
            : 'Reprodução direta/proxy indisponível — alternando automaticamente para player incorporado (<iframe>).'
        )
      ) {
        return true;
      }

      setPlayerError(fallbackMsg);
      return false;
    },
    [playbackMode, baseStreamUrl, qualities.length, switchToEmbedFallback]
  );

  const cyclePlaybackMode = useCallback(() => {
    if (videoRef.current && Number.isFinite(videoRef.current.currentTime) && effectiveType !== 'embed') {
      initialSeekRef.current = videoRef.current.currentTime;
      appliedInitialSeekForIdRef.current = null;
    }
    setPlayerError(null);
    triedQualityCountRef.current = 0;

    const hasDirectSource = Boolean(baseStreamUrl) && baseStreamType !== 'embed';
    if (!hasDirectSource) {
      // No extracted direct stream yet: toggle between embed proxy vs direct iframe or re-resolve
      setPlaybackMode('embed');
      setIframeDirectMode((d) => !d);
      setIframeReloadNonce((n) => n + 1);
      wakeControls();
      return;
    }

    setPlaybackMode((prev) => {
      const next: 'direct' | 'proxy' | 'embed' =
        prev === 'direct' ? 'proxy' : prev === 'proxy' ? 'embed' : 'direct';
      if (next === 'embed') {
        autoSwitchedToEmbedRef.current = true;
        const rawCandidate = embedFallbackUrl || item.sourcePageUrl || item.url;
        const officialEmbed =
          toOfficialEmbedUrl(rawCandidate) ||
          toOfficialEmbedUrl(item.sourcePageUrl || item.url);
        const fallbackTarget = officialEmbed || rawCandidate;
        setEmbedFallbackUrl(fallbackTarget);
        const hasEmbedFormat =
          Boolean(officialEmbed) || (fallbackTarget !== item.url && /embed/i.test(fallbackTarget));
        setIframeTargetMode(hasEmbedFormat ? 'embed' : 'page');
        setIframeDirectMode(Boolean(officialEmbed) || hasEmbedFormat);
        setIframeReloadNonce((n) => n + 1);
        setFallbackNotice('Modo manual: Player incorporado (<iframe>).');
      } else if (next === 'proxy') {
        autoSwitchedRouteRef.current = true;
        setFallbackNotice('Modo manual: Reprodução via Proxy (/api/proxy).');
      } else {
        autoSwitchedRouteRef.current = false;
        autoSwitchedToEmbedRef.current = false;
        setFallbackNotice('Modo manual: Reprodução Direta.');
      }
      return next;
    });
    wakeControls();
  }, [effectiveType, baseStreamUrl, baseStreamType, embedFallbackUrl, item.sourcePageUrl, item.url, wakeControls]);

  // Attach HLS (hls.js + native fallback), MPEG-DASH, or native HTML5 video source with 6s Direct / 5s Proxy anti-black-screen timers
  useEffect(() => {
    if (resolving || !streamUrl || effectiveType === 'embed') {
      if (frameStallTimerRef.current) {
        window.clearTimeout(frameStallTimerRef.current);
        frameStallTimerRef.current = null;
      }
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    setPlayerError(null);
    hasFirstFrameRef.current = false;
    setHasFirstFrame(false);

    let hls: Hls | null = null;
    let dash: { destroy: () => void } | null = null;
    let cancelled = false;
    let recoveredMediaError = false;
    let recoveredNetworkError = false;

    const clearFrameStallTimer = () => {
      if (frameStallTimerRef.current) {
        window.clearTimeout(frameStallTimerRef.current);
        frameStallTimerRef.current = null;
      }
    };

    const markFirstFrameReady = () => {
      if (cancelled) return;
      hasFirstFrameRef.current = true;
      setHasFirstFrame(true);
      setPlaybackStarted(true);
      clearFrameStallTimer();
    };

    // 6s timeout in Direct mode -> auto switch to /api/proxy; 5s timeout in Proxy mode -> auto switch to embed <iframe>
    const stallTimeoutMs = playbackMode === 'direct' ? 6000 : 5000;
    clearFrameStallTimer();
    frameStallTimerRef.current = window.setTimeout(() => {
      if (cancelled || hasFirstFrameRef.current) return;
      tryFallbackQuality(
        playbackMode === 'direct'
          ? 'Tempo limite ao iniciar vídeo no modo Direto.'
          : 'Tempo limite ao iniciar vídeo via Proxy.',
        { isStallTimeout: true }
      );
    }, stallTimeoutMs);

    const lowerEffective = effectiveUrl.toLowerCase();
    const isHlsStream = effectiveType === 'hls' || lowerEffective.includes('.m3u8');
    const isDashStream = effectiveType === 'dash' || lowerEffective.includes('.mpd');

    const applyResumeSeekOnce = () => {
      if (appliedInitialSeekForIdRef.current === item.id) return;
      appliedInitialSeekForIdRef.current = item.id;
      const resumeAt = initialSeekRef.current;
      if (resumeAt > 5 && Number.isFinite(video.duration) && resumeAt < video.duration - 10) {
        video.currentTime = resumeAt;
      }
    };

    const safeAutoPlay = () => {
      video.play().catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          video.muted = true;
          setIsMuted(true);
          video.play().catch(() => setIsPlaying(false));
        } else {
          setIsPlaying(false);
        }
      });
    };

    video.addEventListener('loadeddata', markFirstFrameReady);
    video.addEventListener('playing', markFirstFrameReady);

    if (isDashStream) {
      video.addEventListener('loadedmetadata', applyResumeSeekOnce, { once: true });
      void import('dashjs')
        .then(({ MediaPlayer }) => {
          if (cancelled) return;
          const instance = MediaPlayer().create();
          dash = instance;
          instance.on(MediaPlayer.events.ERROR, () => {
            if (!cancelled) {
              clearFrameStallTimer();
              tryFallbackQuality('Não foi possível reproduzir este fluxo DASH neste modo.');
            }
          });
          instance.initialize(video, streamUrl, true);
        })
        .catch(() => {
          if (!cancelled) {
            clearFrameStallTimer();
            tryFallbackQuality('Não foi possível inicializar o motor DASH interno.');
          }
        });
    } else if (isHlsStream) {
      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          capLevelToPlayerSize: true,
          maxBufferLength: 20,
          maxMaxBufferLength: 40,
          backBufferLength: 15,
          manifestLoadingTimeOut: 6000,
          levelLoadingTimeOut: 6000,
          fragLoadingTimeOut: 8000,
        });
        video.addEventListener('loadedmetadata', applyResumeSeekOnce, { once: true });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          safeAutoPlay();
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || cancelled) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError && hls) {
            recoveredMediaError = true;
            hls.recoverMediaError();
            return;
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !recoveredNetworkError && hls) {
            recoveredNetworkError = true;
            hls.startLoad();
            return;
          }
          clearFrameStallTimer();
          tryFallbackQuality('Não foi possível reproduzir este fluxo HLS (.m3u8) neste modo.');
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS fallback (Safari / iOS / Android WebView)
        video.src = streamUrl;
        video.load();
        video.addEventListener('loadedmetadata', applyResumeSeekOnce, { once: true });
        safeAutoPlay();
      } else {
        clearFrameStallTimer();
        tryFallbackQuality('Fluxo HLS (.m3u8) não suportado diretamente neste modo.');
      }
    } else {
      video.src = streamUrl;
      video.load();
      video.addEventListener('loadedmetadata', applyResumeSeekOnce, { once: true });
      safeAutoPlay();
    }

    return () => {
      cancelled = true;
      clearFrameStallTimer();
      video.removeEventListener('loadeddata', markFirstFrameReady);
      video.removeEventListener('playing', markFirstFrameReady);
      video.removeEventListener('loadedmetadata', applyResumeSeekOnce);
      if (hls) hls.destroy();
      if (dash) dash.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [item.id, resolving, streamUrl, playbackMode, effectiveType, effectiveUrl, tryFallbackQuality]);

  // Irreversible 2.5s safety timer per video item: once playbackStarted becomes true, loading overlay is permanently removed from DOM
  useEffect(() => {
    setPlaybackStarted(false);
    const safetyTimer = window.setTimeout(() => {
      setPlaybackStarted(true);
    }, 2500);
    return () => window.clearTimeout(safetyTimer);
  }, [item.id]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
    wakeControls();
  }, [wakeControls]);

  const seekBy = useCallback(
    (delta: number, options?: { wakeOsd?: boolean }) => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.duration)) return;
      const nextTime = Math.min(Math.max(0, v.currentTime + delta), v.duration);
      v.currentTime = nextTime;
      setCurrentTime(nextTime);
      setSeekIndicator((prev) => {
        const sameDirection =
          prev && ((prev.delta > 0 && delta > 0) || (prev.delta < 0 && delta < 0));
        return {
          delta: sameDirection ? prev.delta + delta : delta,
          targetTime: nextTime,
          key: Date.now(),
        };
      });
      if (seekIndicatorTimerRef.current) {
        window.clearTimeout(seekIndicatorTimerRef.current);
      }
      seekIndicatorTimerRef.current = window.setTimeout(() => {
        setSeekIndicator(null);
      }, 1050);

      if (options?.wakeOsd !== false) {
        wakeControls();
      }
    },
    [wakeControls]
  );

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
    wakeControls();
  }, [wakeControls]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
    wakeControls();
  }, [wakeControls]);

  const selectQuality = useCallback(
    (index: number) => {
      if (index < 0 || index >= qualities.length) return;
      if (index !== qualityIndex && videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
        initialSeekRef.current = videoRef.current.currentTime;
        appliedInitialSeekForIdRef.current = null;
      }
      setQualityIndex(index);
      setShowQualityMenu(false);
      wakeControls();
      window.setTimeout(() => qualityBtnRef.current?.focus(), 40);
    },
    [qualities.length, qualityIndex, wakeControls]
  );

  const cycleQuality = useCallback(() => {
    if (qualities.length <= 1) return;
    selectQuality((qualityIndex + 1) % qualities.length);
  }, [qualities.length, qualityIndex, selectQuality]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Media transport & HDMI-CEC keys work regardless of OSD state
      if (e.key === 'MediaPlayPause' || e.key === 'k' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
        return;
      }
      if (e.key === 'MediaPlay') {
        e.preventDefault();
        e.stopPropagation();
        videoRef.current?.play().catch(() => {});
        setIsPlaying(true);
        wakeControls();
        return;
      }
      if (e.key === 'MediaPause' || e.key === 'MediaStop') {
        e.preventDefault();
        e.stopPropagation();
        videoRef.current?.pause();
        setIsPlaying(false);
        wakeControls();
        return;
      }
      if (e.key === 'MediaFastForward') {
        e.preventDefault();
        e.stopPropagation();
        seekBy(15, { wakeOsd: false });
        return;
      }
      if (e.key === 'MediaRewind') {
        e.preventDefault();
        e.stopPropagation();
        seekBy(-15, { wakeOsd: false });
        return;
      }
      if (e.key === 'MediaTrackNext' && nextItem) {
        e.preventDefault();
        e.stopPropagation();
        onSelectItem(nextItem);
        return;
      }
      if (e.key === 'MediaTrackPrevious' && prevItem) {
        e.preventDefault();
        e.stopPropagation();
        onSelectItem(prevItem);
        return;
      }
      if (e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreen();
        return;
      }
      if ((e.key === 'q' || e.key === 'Q') && qualities.length > 1 && effectiveType !== 'embed') {
        e.preventDefault();
        e.stopPropagation();
        setShowQualityMenu((prev) => !prev);
        wakeControls();
        return;
      }

      const isBackKey =
        e.key === 'Escape' ||
        e.key === 'Backspace' ||
        e.key === 'Back' ||
        e.key === 'BrowserBack' ||
        e.key === 'GoBack' ||
        e.key === 'XF86Back' ||
        e.keyCode === 4;

      // Close quality menu on Back before closing queue or player
      if (showQualityMenu && isBackKey) {
        e.preventDefault();
        e.stopPropagation();
        setShowQualityMenu(false);
        window.setTimeout(() => qualityBtnRef.current?.focus(), 40);
        return;
      }

      // Close queue drawer on Back before closing entire player
      if (showQueue && isBackKey) {
        e.preventDefault();
        e.stopPropagation();
        setShowQueue(false);
        return;
      }

      // Seek 15s when OSD progress bar is explicitly focused
      if (
        showControls &&
        !showQueue &&
        !showQualityMenu &&
        !playerError &&
        effectiveType !== 'embed' &&
        document.activeElement === progressBarRef.current
      ) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          seekBy(-15);
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          seekBy(15);
          return;
        }
      }

      // When OSD is hidden on Mi TV Stick, Left/Right seek ±15s smoothly with visual indicator, OK toggles Play/Pause, Up/Down wake OSD & focus controls
      if (!showControls && !showQueue && !showQualityMenu && !playerError && effectiveType !== 'embed') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          seekBy(-15, { wakeOsd: false });
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          seekBy(15, { wakeOsd: false });
          return;
        }
        if (
          e.key === 'Enter' ||
          e.key === 'Select' ||
          e.key === 'DPAD_CENTER' ||
          e.keyCode === 23 ||
          e.keyCode === 66
        ) {
          e.preventDefault();
          e.stopPropagation();
          togglePlay();
          window.setTimeout(() => playBtnRef.current?.focus(), 40);
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          wakeControls();
          window.setTimeout(() => playBtnRef.current?.focus(), 40);
          return;
        }
      }

      // In embed/iframe mode, Back closes bottom TV controls drawer if open; Up/Down/Menu open TV controls & focus pills
      if (effectiveType === 'embed' && !showQueue && !playerError) {
        if (showControls && isBackKey) {
          e.preventDefault();
          e.stopPropagation();
          setShowControls(false);
          window.setTimeout(() => voltarBtnRef.current?.focus(), 40);
          return;
        }
        if (!showControls && (e.key === 'ArrowDown' || e.key === 'Menu' || e.key === 'ContextMenu')) {
          e.preventDefault();
          e.stopPropagation();
          wakeControls();
          window.setTimeout(() => embedFirstControlRef.current?.focus(), 40);
          return;
        }
        if (!showControls && e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          window.setTimeout(() => voltarBtnRef.current?.focus(), 40);
          return;
        }
      }

      wakeControls();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [wakeControls, togglePlay, seekBy, toggleFullscreen, showControls, showQueue, showQualityMenu, qualities.length, playerError, effectiveType, nextItem, prevItem, onSelectItem]);

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      ref={containerRef}
      data-tv-scope="modal"
      onMouseMove={wakeControls}
      onTouchStart={wakeControls}
      className="fixed inset-0 z-50 bg-black overflow-hidden"
    >
      {/* Video Surface */}
      {effectiveType === 'embed' && streamUrl ? (
        <iframe
          key={`${streamUrl}_${iframeReloadNonce}`}
          src={streamUrl}
          title={item.title}
          onLoad={() => setPlaybackStarted(true)}
          {...(iframeDirectMode
            ? {}
            : { sandbox: 'allow-scripts allow-forms allow-same-origin allow-presentation' })}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
          referrerPolicy="no-referrer-when-downgrade"
          className="absolute inset-0 w-full h-full border-0 bg-black"
        />
      ) : (
        <video
          ref={videoRef}
          playsInline
          crossOrigin={useProxy ? 'anonymous' : undefined}
          onClick={togglePlay}
          onPlay={() => setIsPlaying(true)}
          onPlaying={() => {
            setPlaybackStarted(true);
            setIsPlaying(true);
            hasFirstFrameRef.current = true;
            setHasFirstFrame(true);
            if (frameStallTimerRef.current) {
              window.clearTimeout(frameStallTimerRef.current);
              frameStallTimerRef.current = null;
            }
          }}
          onLoadedData={() => {
            setPlaybackStarted(true);
            hasFirstFrameRef.current = true;
            setHasFirstFrame(true);
            if (frameStallTimerRef.current) {
              window.clearTimeout(frameStallTimerRef.current);
              frameStallTimerRef.current = null;
            }
          }}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (!v) return;
            if (v.currentTime > 0) {
              setPlaybackStarted(true);
            }
            if (!hasFirstFrameRef.current && (v.currentTime > 0 || v.readyState >= 2)) {
              hasFirstFrameRef.current = true;
              setHasFirstFrame(true);
              if (frameStallTimerRef.current) {
                window.clearTimeout(frameStallTimerRef.current);
                frameStallTimerRef.current = null;
              }
            }
            setCurrentTime(v.currentTime);
            const now = Date.now();
            if (now - lastSavedAtRef.current >= 5000 && v.duration > 10) {
              lastSavedAtRef.current = now;
              onSaveProgress({
                itemId: item.id,
                currentTime: v.currentTime,
                duration: v.duration,
                updatedAt: now,
              });
            }
          }}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (v && Number.isFinite(v.duration)) {
              setDuration(v.duration);
            }
          }}
          onEnded={() => {
            if (nextItem) {
              onSelectItem(nextItem);
            }
          }}
          onError={() => {
            const v = videoRef.current;
            if (!resolving && streamUrl && v && (v.currentSrc || v.src)) {
              tryFallbackQuality(
                useProxy
                  ? 'Erro ao carregar este vídeo via proxy. Tente alternar modo ou qualidade.'
                  : 'Erro ao carregar este vídeo diretamente. Tentando via Proxy.'
              );
            }
          }}
          className="absolute inset-0 w-full h-full object-contain bg-black"
        >
          {subtitlesEnabled &&
            item.subtitles?.map((sub, i) => (
              <track
                key={sub.url}
                kind="subtitles"
                label={sub.label}
                srcLang={sub.lang || 'pt'}
                src={`/api/proxy?url=${encodeURIComponent(sub.url)}`}
                default={i === 0}
              />
            ))}
        </video>
      )}

      {/* Initial Loading Overlay (unmounted permanently from DOM once playbackStarted is true) */}
      {!playbackStarted && !playerError && (resolving || Boolean(streamUrl)) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-center px-6">
            <Loader2 className="w-10 h-10 text-sky-400 animate-spin" />
            <p className="font-display text-lg font-semibold text-white">
              {resolving
                ? 'Carregando fluxo de vídeo do servidor...'
                : effectiveType === 'embed'
                ? 'Carregando player incorporado...'
                : playbackMode === 'proxy'
                ? 'Carregando vídeo via Proxy...'
                : 'Iniciando vídeo em modo Direto...'}
            </p>
            <p className="text-xs text-slate-400 font-mono truncate max-w-md">
              {item.title}
            </p>
          </div>
        </div>
      )}

      {/* Automatic Fallback Notice Toast */}
      {fallbackNotice && !resolving && !playerError && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-30 max-w-xl px-4 py-2.5 rounded-xl bg-amber-500/20 border border-amber-400/45 text-xs font-medium text-amber-100 backdrop-blur-md shadow-xl pointer-events-none text-center">
          {fallbackNotice}
        </div>
      )}

      {/* Centered On-Screen Visual Seek Indicator (±15s D-Pad / Remote Feedback) */}
      {seekIndicator && !resolving && !playerError && effectiveType !== 'embed' && (
        <div
          key={seekIndicator.key}
          className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none"
        >
          <div className="px-6 py-4 rounded-2xl bg-[#0B0D14]/90 border border-white/15 backdrop-blur-md shadow-2xl flex flex-col items-center gap-2 min-w-[200px]">
            <div className="flex items-center gap-2.5 text-white">
              {seekIndicator.delta < 0 ? (
                <RotateCcw className="w-6 h-6 text-sky-400" />
              ) : (
                <RotateCw className="w-6 h-6 text-sky-400" />
              )}
              <span className="font-display text-2xl font-bold tabular-nums">
                {seekIndicator.delta > 0 ? `+${seekIndicator.delta}s` : `${seekIndicator.delta}s`}
              </span>
            </div>
            <div className="text-xs font-mono tabular-nums text-slate-300">
              {formatTime(seekIndicator.targetTime)}
              {duration > 0 ? ` / ${formatTime(duration)}` : ''}
            </div>
            {duration > 0 && (
              <div className="w-40 h-1.5 rounded-full bg-white/15 overflow-hidden mt-0.5">
                <div
                  className="h-full bg-sky-400 rounded-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, (seekIndicator.targetTime / duration) * 100))}%`,
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error Recovery Banner */}
      {playerError && !resolving && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6 z-20 pointer-events-none">
          <div className="pointer-events-auto max-w-lg w-full rounded-2xl bg-[#12151E] border border-white/15 p-6 text-center shadow-2xl">
            <AlertCircle className="w-10 h-10 text-amber-400 mx-auto mb-3" />
            <h3 className="font-display text-xl font-semibold text-white">
              Falha na reprodução
            </h3>
            <p className="mt-2 text-sm text-slate-300 leading-relaxed">{playerError}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                ref={errorRetryBtnRef}
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  setPlayerError(null);
                  triedQualityCountRef.current = 0;
                  autoSwitchedRouteRef.current = false;
                  if (!effectiveUrl && item.streamType === 'page') {
                    setResolveAttempt((a) => a + 1);
                  } else {
                    cyclePlaybackMode();
                  }
                }}
                className="px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm whitespace-nowrap shrink-0"
              >
                {!effectiveUrl && item.streamType === 'page'
                  ? 'Tentar Extrair Novamente'
                  : 'Alternar Modo (Direto / Proxy / Embed)'}
              </button>
              {qualities.length > 1 && (
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => {
                    setPlayerError(null);
                    cycleQuality();
                  }}
                  className="px-5 py-2.5 rounded-xl bg-white/15 hover:bg-white/25 text-white font-medium text-sm whitespace-nowrap shrink-0"
                >
                  Trocar Qualidade
                </button>
              )}
              <button
                type="button"
                data-tv-focusable="true"
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium text-sm whitespace-nowrap shrink-0"
              >
                Voltar ao Catálogo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top Corner Floating Pills (always visible in Embed/Iframe mode without any dark strip; synced with auto-hide during native <video> playback) */}
      {effectiveType === 'embed' ? (
        <div className="absolute top-3 inset-x-3 sm:top-4 sm:inset-x-4 z-40 flex items-center justify-between gap-3 pointer-events-none">
          <button
            ref={voltarBtnRef}
            type="button"
            data-tv-focusable="true"
            onClick={onClose}
            className="pointer-events-auto h-9 px-3.5 rounded-full bg-[#090A0F]/65 hover:bg-[#090A0F]/90 backdrop-blur-md border border-white/25 text-white flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 shadow-lg transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Voltar
          </button>

          <div className="pointer-events-auto flex items-center gap-2">
            {showControls && (
              <>
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => onToggleFavorite(item)}
                  className={`h-9 px-3.5 rounded-full backdrop-blur-md border flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 shadow-lg transition-colors ${
                    isFavorite
                      ? 'bg-amber-500/25 text-amber-300 border-amber-400/50'
                      : 'bg-[#090A0F]/65 hover:bg-[#090A0F]/90 border-white/25 text-white'
                  }`}
                >
                  <Star className={`w-3.5 h-3.5 ${isFavorite ? 'fill-current' : ''}`} />
                  {isFavorite ? 'Favorito' : 'Favoritar'}
                </button>
                {playlist.length > 1 && (
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => setShowQueue((q) => !q)}
                    className="h-9 px-3.5 rounded-full bg-[#090A0F]/65 hover:bg-[#090A0F]/90 backdrop-blur-md border border-white/25 text-white flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 shadow-lg transition-colors"
                  >
                    <ListVideo className="w-3.5 h-3.5" />
                    Lista ({playlist.length})
                  </button>
                )}
              </>
            )}

            <button
              type="button"
              data-tv-focusable="true"
              onClick={() => {
                if (showControls) {
                  setShowControls(false);
                } else {
                  wakeControls();
                  window.setTimeout(() => embedFirstControlRef.current?.focus(), 40);
                }
              }}
              className={`h-9 px-3.5 rounded-full backdrop-blur-md border flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 shadow-lg transition-colors ${
                showControls
                  ? 'bg-sky-500/90 hover:bg-sky-400 text-slate-950 border-sky-300/60'
                  : 'bg-[#090A0F]/65 hover:bg-[#090A0F]/90 border-white/25 text-white'
              }`}
            >
              <Settings2 className={`w-3.5 h-3.5 ${showControls ? 'text-slate-950' : 'text-sky-400'}`} />
              Controles TV
            </button>
          </div>
        </div>
      ) : (
        <div
          aria-hidden={!showControls}
          className={`absolute top-0 inset-x-0 z-30 flex items-center justify-between gap-6 px-6 sm:px-8 py-5 transition-opacity duration-200 ${
            showControls
              ? 'opacity-100 pointer-events-auto'
              : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className="flex items-center gap-4 min-w-0">
            <button
              ref={voltarBtnRef}
              type="button"
              data-tv-focusable="true"
              onClick={onClose}
              className="h-12 px-5 rounded-xl bg-black/75 hover:bg-white/25 border border-white/25 text-white flex items-center gap-2 text-sm font-semibold whitespace-nowrap shrink-0 shadow-lg"
            >
              <ChevronLeft className="w-5 h-5" />
              Voltar
            </button>
            <div className="min-w-0">
              <h2 className="font-display text-lg sm:text-xl font-semibold text-white truncate drop-shadow">
                {item.title}
              </h2>
              <p className="text-xs text-slate-300 truncate font-mono drop-shadow">
                {item.category} · {activeQuality?.label || item.quality || effectiveType.toUpperCase()}
                {item.duration ? ` · ${item.duration}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              data-tv-focusable="true"
              onClick={() => onToggleFavorite(item)}
              className={`h-11 px-4 rounded-xl flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0 ${
                isFavorite
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-400/40'
                  : 'bg-black/75 hover:bg-white/20 border border-white/15 text-white'
              }`}
            >
              <Star className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
              {isFavorite ? 'Favorito' : 'Favoritar'}
            </button>
            {playlist.length > 1 && (
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setShowQueue((q) => !q)}
                className="h-11 px-4 rounded-xl bg-black/75 hover:bg-white/20 border border-white/15 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                <ListVideo className="w-4 h-4" />
                Lista ({playlist.length})
              </button>
            )}
          </div>
        </div>
      )}

      {/* TV-Box Optimized Bottom OSD Controls for Fullscreen Iframe / Embed Fallback */}
      {effectiveType === 'embed' && (
        <div
          className={`absolute bottom-0 inset-x-0 z-30 px-6 sm:px-8 pb-6 pt-12 bg-gradient-to-t from-black/95 via-black/75 to-transparent transition-opacity duration-200 ${
            showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                ref={prevItem ? embedFirstControlRef : undefined}
                type="button"
                data-tv-focusable="true"
                disabled={!prevItem}
                onClick={() => prevItem && onSelectItem(prevItem)}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-35 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                <SkipBack className="w-4 h-4" />
                Anterior
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                disabled={!nextItem}
                onClick={() => nextItem && onSelectItem(nextItem)}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-35 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                Próximo
                <SkipForward className="w-4 h-4" />
              </button>

              <button
                ref={!prevItem ? embedFirstControlRef : undefined}
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  setIframeReloadNonce((n) => n + 1);
                  wakeControls();
                }}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                <RotateCw className="w-4 h-4" />
                Recarregar Player
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  setIframeTargetMode((m) => {
                    const next = m === 'embed' ? 'page' : 'embed';
                    if (next === 'embed') {
                      const official =
                        toOfficialEmbedUrl(item.sourcePageUrl || item.url) || embedFallbackUrl;
                      if (official) setEmbedFallbackUrl(official);
                      setIframeDirectMode(Boolean(official));
                    } else {
                      setIframeDirectMode(false);
                    }
                    return next;
                  });
                  setIframeReloadNonce((n) => n + 1);
                  wakeControls();
                }}
                className="h-12 px-4 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-xs font-medium text-sky-200 whitespace-nowrap shrink-0"
              >
                {iframeTargetMode === 'embed' ? 'Ver Página Completa' : 'Ver Player Embed'}
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  setIframeDirectMode((d) => !d);
                  setIframeReloadNonce((n) => n + 1);
                  wakeControls();
                }}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0"
              >
                {iframeDirectMode ? 'Frame: Direto' : 'Frame: Proxy Interno'}
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                onClick={cyclePlaybackMode}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0"
                title="Alternar entre reprodução Direta, Proxy ou Embed"
              >
                Alternar Modo (Direto / Proxy / Embed) · Embed
              </button>

              {item.streamType === 'page' && (
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => {
                    autoSwitchedToEmbedRef.current = false;
                    setResolveAttempt((a) => a + 1);
                    wakeControls();
                  }}
                  className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0"
                >
                  Reextrair Stream
                </button>
              )}

              <button
                type="button"
                data-tv-focusable="true"
                onClick={toggleFullscreen}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                <Maximize className="w-4 h-4" />
                Tela Cheia
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom OSD Controls (includes Resolution & Route separated from Voltar) */}
      {effectiveType !== 'embed' && (
        <div
          className={`absolute bottom-0 inset-x-0 z-30 px-6 sm:px-8 pb-6 pt-16 bg-gradient-to-t from-black/95 via-black/75 to-transparent transition-opacity duration-200 ${
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className="mb-5">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-300 mb-2">
              <span>{formatTime(currentTime)}</span>
              <span className="hidden sm:inline text-[11px] text-slate-400 font-sans">
                Setas Esq/Dir com barra oculta: ±15s
              </span>
              <span>{duration > 0 ? formatTime(duration) : 'Stream'}</span>
            </div>
            <div
              ref={progressBarRef}
              role="slider"
              tabIndex={0}
              data-tv-focusable="true"
              aria-label="Barra de progresso do vídeo"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration || 0)}
              aria-valuenow={Math.round(currentTime)}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                if (videoRef.current && duration > 0) {
                  videoRef.current.currentTime = ratio * duration;
                  setCurrentTime(videoRef.current.currentTime);
                }
              }}
              className="h-3 w-full rounded-full bg-white/20 overflow-hidden cursor-pointer focus:ring-2 focus:ring-sky-400"
            >
              <div
                className="h-full bg-sky-400 rounded-full transition-all duration-100"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                data-tv-focusable="true"
                disabled={!prevItem}
                onClick={() => prevItem && onSelectItem(prevItem)}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-35 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                <SkipBack className="w-4 h-4" />
                Anterior
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => seekBy(-15)}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center gap-1.5 text-sm font-mono tabular-nums whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-4 h-4" />
                -15s
              </button>

              <button
                ref={playBtnRef}
                type="button"
                data-tv-focusable="true"
                onClick={togglePlay}
                className="h-12 px-6 rounded-xl bg-white text-[#090A0F] hover:bg-slate-200 flex items-center gap-2 text-sm font-bold whitespace-nowrap shrink-0"
              >
                {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                {isPlaying ? 'Pausar' : 'Reproduzir'}
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => seekBy(15)}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center gap-1.5 text-sm font-mono tabular-nums whitespace-nowrap shrink-0"
              >
                +15s
                <RotateCw className="w-4 h-4" />
              </button>

              <button
                type="button"
                data-tv-focusable="true"
                disabled={!nextItem}
                onClick={() => nextItem && onSelectItem(nextItem)}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-35 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                Próximo
                <SkipForward className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {qualities.length > 0 && (
                <div className="relative">
                  {showQualityMenu && qualities.length > 1 && (
                    <div className="absolute bottom-14 right-0 z-40 w-60 rounded-2xl bg-[#0E1119]/98 border border-white/15 p-2 shadow-2xl">
                      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
                        <span className="text-xs font-display font-semibold text-white">
                          Qualidade do Vídeo
                        </span>
                        <span className="text-[11px] font-mono text-slate-400">
                          {qualities.length} opções
                        </span>
                      </div>
                      <div className="mt-1.5 space-y-1 max-h-60 overflow-y-auto">
                        {qualities.map((q, idx) => {
                          const isCurrent = idx === qualityIndex;
                          return (
                            <button
                              key={`${q.label}_${idx}`}
                              ref={isCurrent ? activeQualityItemRef : undefined}
                              type="button"
                              data-tv-focusable="true"
                              onClick={() => selectQuality(idx)}
                              className={`w-full h-10 px-3 rounded-xl flex items-center justify-between text-xs font-mono transition-colors ${
                                isCurrent
                                  ? 'bg-sky-500 text-slate-950 font-bold'
                                  : 'bg-white/5 hover:bg-white/15 text-slate-200'
                              }`}
                            >
                              <span className="truncate">{q.label}</span>
                              <span className="flex items-center gap-1.5 shrink-0">
                                <span
                                  className={`text-[10px] uppercase ${
                                    isCurrent ? 'text-slate-900' : 'text-slate-400'
                                  }`}
                                >
                                  {q.streamType}
                                </span>
                                {isCurrent && <Check className="w-3.5 h-3.5" />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <button
                    ref={qualityBtnRef}
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => {
                      if (qualities.length > 1) {
                        setShowQualityMenu((prev) => !prev);
                        wakeControls();
                      }
                    }}
                    className={`h-12 px-4 rounded-xl border text-xs font-mono font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
                      showQualityMenu
                        ? 'bg-sky-500 text-slate-950 border-sky-400 font-bold'
                        : 'bg-sky-500/20 hover:bg-sky-500/30 border-sky-400/40 text-sky-200'
                    }`}
                  >
                    <Settings2 className="w-4 h-4" />
                    Qualidade: {activeQuality?.label || item.quality || effectiveType.toUpperCase()}
                    {qualities.length > 1 && (
                      <ChevronUp
                        className={`w-3.5 h-3.5 transition-transform ${
                          showQualityMenu ? 'rotate-180' : ''
                        }`}
                      />
                    )}
                  </button>
                </div>
              )}

              <button
                type="button"
                data-tv-focusable="true"
                onClick={cyclePlaybackMode}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0"
                title="Alternar entre reprodução Direta, Proxy ou Embed"
              >
                Alternar Modo (Direto / Proxy / Embed) ·{' '}
                {playbackMode === 'direct' ? 'Direto' : playbackMode === 'proxy' ? 'Proxy' : 'Embed'}
              </button>

              {item.subtitles && item.subtitles.length > 0 && (
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => setSubtitlesEnabled((s) => !s)}
                  className={`h-12 px-4 rounded-xl flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0 ${
                    subtitlesEnabled
                      ? 'bg-sky-500/25 text-sky-300 border border-sky-400/40'
                      : 'bg-white/10 text-slate-300'
                  }`}
                >
                  <Captions className="w-4 h-4" />
                  Legendas
                </button>
              )}

              <button
                type="button"
                data-tv-focusable="true"
                onClick={toggleMute}
                className="h-12 w-12 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center shrink-0"
                aria-label={isMuted ? 'Ativar som' : 'Silenciar'}
              >
                {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>

              {downloadInfo && (
                <a
                  href={downloadInfo.href}
                  download={downloadInfo.fileName}
                  data-tv-focusable="true"
                  onClick={() => wakeControls()}
                  className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
                  title={
                    downloadInfo.qualityLabel
                      ? `Baixar (${downloadInfo.qualityLabel})`
                      : 'Baixar vídeo'
                  }
                >
                  <Download className="w-4 h-4" />
                  Download
                </a>
              )}

              <button
                type="button"
                data-tv-focusable="true"
                onClick={toggleFullscreen}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                <Maximize className="w-4 h-4" />
                Tela Cheia
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Side Episode / Playlist Drawer */}
      {showQueue && (
        <aside className="absolute top-0 right-0 bottom-0 z-40 w-96 max-w-full bg-[#0E1119]/98 border-l border-white/10 flex flex-col">
          <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
            <h3 className="font-display font-semibold text-base text-white">
              Lista do Servidor ({playlist.length})
            </h3>
            <button
              ref={queueCloseBtnRef}
              type="button"
              data-tv-focusable="true"
              onClick={() => setShowQueue(false)}
              className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0"
            >
              Fechar
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {playlist.map((entry, idx) => {
              const active = entry.id === item.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => onSelectItem(entry)}
                  className={`w-full text-left px-3.5 py-3 rounded-xl border transition-colors ${
                    active
                      ? 'bg-sky-500/20 border-sky-400/50 text-white'
                      : 'bg-[#141824] border-white/8 text-slate-300 hover:bg-[#1A2030]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs tabular-nums text-slate-500 w-6">
                      {(idx + 1).toString().padStart(2, '0')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{entry.title}</p>
                      <p className="text-xs text-slate-400 truncate">
                        {entry.category} · {entry.quality || entry.format || 'VIDEO'}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>
      )}
    </div>
  );
}
