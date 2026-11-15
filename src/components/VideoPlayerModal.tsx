import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  AlertCircle,
  Captions,
  ChevronLeft,
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
  const playBtnRef = useRef<HTMLButtonElement>(null);
  const errorRetryBtnRef = useRef<HTMLButtonElement>(null);
  const queueCloseBtnRef = useRef<HTMLButtonElement>(null);

  const [useProxy, setUseProxy] = useState(initialUseProxy);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [showQueue, setShowQueue] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);

  // Lazy stream resolution state (for 'page' portal items)
  const [resolving, setResolving] = useState(item.streamType === 'page');
  const [resolvedUrl, setResolvedUrl] = useState<string>(
    item.streamType === 'page' ? '' : item.url
  );
  const [resolvedType, setResolvedType] = useState<'video' | 'hls' | 'embed'>(
    item.streamType === 'page' ? 'hls' : item.streamType
  );
  const [resolvedReferer, setResolvedReferer] = useState<string>(item.sourcePageUrl || item.url);
  const [qualities, setQualities] = useState<QualityOption[]>(item.qualities || []);
  const [qualityIndex, setQualityIndex] = useState(() =>
    pickInitialQualityIndex(item.qualities || [])
  );

  const hideTimerRef = useRef<number | null>(null);
  const initialSeekRef = useRef<number>(initialTime);
  const appliedInitialSeekForIdRef = useRef<string | null>(null);
  const lastSavedAtRef = useRef<number>(0);
  const triedQualityCountRef = useRef<number>(0);
  const autoSwitchedRouteRef = useRef<boolean>(false);
  const [resolveAttempt, setResolveAttempt] = useState(0);

  useEffect(() => {
    triedQualityCountRef.current = 0;
    autoSwitchedRouteRef.current = false;
    if (appliedInitialSeekForIdRef.current !== item.id) {
      initialSeekRef.current = initialTime;
    }
  }, [item.id, initialTime]);

  const currentIndex = useMemo(
    () => playlist.findIndex((p) => p.id === item.id),
    [playlist, item.id]
  );

  const prevItem = currentIndex > 0 ? playlist[currentIndex - 1] : null;
  const nextItem =
    currentIndex >= 0 && currentIndex < playlist.length - 1
      ? playlist[currentIndex + 1]
      : null;

  // Resolve portal watch pages on demand
  useEffect(() => {
    let cancelled = false;
    setPlayerError(null);
    setCurrentTime(0);
    setDuration(0);

    if (item.streamType !== 'page') {
      setResolving(false);
      setResolvedUrl(item.url);
      setResolvedType(item.streamType);
      setResolvedReferer(item.sourcePageUrl || item.url);
      setQualities(item.qualities || []);
      setQualityIndex(pickInitialQualityIndex(item.qualities || []));
      return;
    }

    setResolving(true);
    setResolvedUrl('');

    (async () => {
      try {
        const { ok, data } = await fetchJson<{
          streamUrl?: string;
          streamType?: 'hls' | 'video' | 'embed';
          referer?: string;
          qualities?: QualityOption[];
          error?: string;
        }>(`/api/resolve?url=${encodeURIComponent(item.url)}`);
        if (cancelled) return;
        if (!ok || !data.streamUrl) {
          throw new Error(data.error || 'Não foi possível extrair o fluxo deste vídeo.');
        }
        const nextQualities = Array.isArray(data.qualities) ? data.qualities : [];
        setResolvedUrl(data.streamUrl);
        setResolvedType(data.streamType || 'hls');
        setResolvedReferer(data.referer || item.url);
        setQualities(nextQualities);
        setQualityIndex(pickInitialQualityIndex(nextQualities));
        setResolving(false);
      } catch (err) {
        if (cancelled) return;
        setResolving(false);
        setPlayerError(
          err instanceof Error ? err.message : 'Erro ao extrair fluxo de vídeo da página.'
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [item.id, item.url, item.streamType, item.sourcePageUrl, resolveAttempt]);

  const activeQuality = qualities[qualityIndex];
  const effectiveUrl = activeQuality ? activeQuality.url : resolvedUrl;
  const effectiveType = activeQuality ? activeQuality.streamType : resolvedType;

  const streamUrl = useMemo(() => {
    if (!effectiveUrl) return '';
    if (effectiveType === 'embed') return effectiveUrl;
    if (useProxy && !effectiveUrl.startsWith('/')) {
      const refPart = resolvedReferer
        ? `&referer=${encodeURIComponent(resolvedReferer)}`
        : '';
      return `/api/proxy?url=${encodeURIComponent(effectiveUrl)}${refPart}`;
    }
    return effectiveUrl;
  }, [effectiveUrl, effectiveType, useProxy, resolvedReferer]);

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
    const href = targetUrl.startsWith('/')
      ? targetUrl
      : `/api/proxy?url=${encodeURIComponent(targetUrl)}${refPart}&download=1&filename=${encodeURIComponent(fileName)}`;

    return {
      href,
      fileName,
      qualityLabel: bestVideoQuality?.label,
    };
  }, [resolving, effectiveType, activeQuality, qualities, effectiveUrl, item.title, resolvedReferer]);

  const wakeControls = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!showQueue) setShowControls(false);
    }, 4500);
  }, [showQueue]);

  useEffect(() => {
    wakeControls();
    const t = window.setTimeout(() => playBtnRef.current?.focus(), 60);
    return () => {
      window.clearTimeout(t);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [item.id, wakeControls]);

  useEffect(() => {
    if (playerError && !resolving) {
      const t = window.setTimeout(() => errorRetryBtnRef.current?.focus(), 40);
      return () => window.clearTimeout(t);
    }
  }, [playerError, resolving]);

  useEffect(() => {
    if (showQueue) {
      const t = window.setTimeout(() => queueCloseBtnRef.current?.focus(), 40);
      return () => window.clearTimeout(t);
    } else if (!playerError && !resolving) {
      const t = window.setTimeout(() => playBtnRef.current?.focus(), 40);
      return () => window.clearTimeout(t);
    }
  }, [showQueue, playerError, resolving]);

  const tryFallbackQuality = useCallback(
    (fallbackMsg: string) => {
      if (qualities.length > 1 && triedQualityCountRef.current < qualities.length - 1) {
        triedQualityCountRef.current += 1;
        if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
          initialSeekRef.current = videoRef.current.currentTime;
          appliedInitialSeekForIdRef.current = null;
        }
        setQualityIndex((prev) => (prev + 1) % qualities.length);
        return true;
      }

      // If all qualities failed on the current route (Direct vs Proxy), automatically try the opposite route once
      if (!autoSwitchedRouteRef.current && effectiveUrl && !effectiveUrl.startsWith('/')) {
        autoSwitchedRouteRef.current = true;
        triedQualityCountRef.current = 0;
        if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
          initialSeekRef.current = videoRef.current.currentTime;
          appliedInitialSeekForIdRef.current = null;
        }
        setQualityIndex(pickInitialQualityIndex(qualities));
        setUseProxy((p) => !p);
        return true;
      }

      setPlayerError(fallbackMsg);
      return false;
    },
    [qualities, effectiveUrl]
  );

  // Attach HLS or native HTML5 video source (lean memory settings for Xiaomi Mi TV Stick)
  useEffect(() => {
    if (resolving || !streamUrl || effectiveType === 'embed') return;
    const video = videoRef.current;
    if (!video) return;

    setPlayerError(null);
    let hls: Hls | null = null;
    let recoveredMediaError = false;
    let recoveredNetworkError = false;

    const isHlsStream =
      effectiveType === 'hls' || effectiveUrl.toLowerCase().includes('.m3u8');

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

    if (isHlsStream && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
        backBufferLength: 15,
      });
      video.addEventListener('loadedmetadata', applyResumeSeekOnce, { once: true });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        safeAutoPlay();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
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
        tryFallbackQuality('Não foi possível reproduzir este fluxo HLS neste modo.');
      });
    } else {
      video.src = streamUrl;
      video.load();
      video.addEventListener('loadedmetadata', applyResumeSeekOnce, { once: true });
      safeAutoPlay();
    }

    return () => {
      video.removeEventListener('loadedmetadata', applyResumeSeekOnce);
      if (hls) hls.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [item.id, resolving, streamUrl, effectiveType, effectiveUrl, tryFallbackQuality]);

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
    (delta: number) => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.duration)) return;
      v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration);
      setCurrentTime(v.currentTime);
      wakeControls();
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

  const cycleQuality = useCallback(() => {
    if (qualities.length <= 1) return;
    if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
      initialSeekRef.current = videoRef.current.currentTime;
      appliedInitialSeekForIdRef.current = null;
    }
    setQualityIndex((prev) => (prev + 1) % qualities.length);
    wakeControls();
  }, [qualities.length, wakeControls]);

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
        seekBy(15);
        return;
      }
      if (e.key === 'MediaRewind') {
        e.preventDefault();
        e.stopPropagation();
        seekBy(-15);
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

      // Close queue drawer on Back before closing entire player
      if (
        showQueue &&
        (e.key === 'Escape' ||
          e.key === 'Backspace' ||
          e.key === 'Back' ||
          e.key === 'BrowserBack' ||
          e.key === 'GoBack' ||
          e.key === 'XF86Back' ||
          e.keyCode === 4)
      ) {
        e.preventDefault();
        e.stopPropagation();
        setShowQueue(false);
        return;
      }

      // When OSD is hidden on Mi TV Stick, Left/Right seek, OK toggles Play/Pause, Up/Down wake OSD & focus controls
      if (!showControls && !showQueue && !playerError && effectiveType !== 'embed') {
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

      wakeControls();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [wakeControls, togglePlay, seekBy, toggleFullscreen, showControls, showQueue, playerError, effectiveType, nextItem, prevItem, onSelectItem]);

  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      ref={containerRef}
      data-tv-scope="modal"
      onMouseMove={wakeControls}
      className="fixed inset-0 z-50 bg-black overflow-hidden"
    >
      {/* Video Surface */}
      {effectiveType === 'embed' && streamUrl ? (
        <iframe
          src={streamUrl}
          title={item.title}
          allow="autoplay; fullscreen; encrypted-media"
          allowFullScreen
          className="absolute inset-0 w-full h-full border-0"
        />
      ) : (
        <video
          ref={videoRef}
          playsInline
          crossOrigin={useProxy ? 'anonymous' : undefined}
          onClick={togglePlay}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (!v) return;
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
            if (!resolving && streamUrl) {
              tryFallbackQuality(
                useProxy
                  ? 'Erro ao carregar este vídeo via proxy. Tente alternar qualidade ou usar Modo Direto.'
                  : 'Erro ao carregar este vídeo diretamente. Tente ativar o Proxy Integrado.'
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

      {/* Resolving Stream Spinner */}
      {resolving && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/85 z-10 pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-center px-6">
            <Loader2 className="w-10 h-10 text-sky-400 animate-spin" />
            <p className="font-display text-lg font-semibold text-white">
              Carregando fluxo de vídeo do servidor...
            </p>
            <p className="text-xs text-slate-400 font-mono truncate max-w-md">
              {item.title}
            </p>
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
                    setUseProxy((p) => !p);
                  }
                }}
                className="px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm whitespace-nowrap shrink-0"
              >
                {!effectiveUrl && item.streamType === 'page'
                  ? 'Tentar Extrair Novamente'
                  : useProxy
                  ? 'Tentar Modo Direto'
                  : 'Tentar via Proxy'}
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

      {/* Top OSD Bar — Voltar cleanly isolated on top-left, always accessible */}
      <div
        className="absolute top-0 inset-x-0 z-30 flex items-center justify-between gap-6 px-6 sm:px-8 py-5 bg-gradient-to-b from-black/90 via-black/50 to-transparent pointer-events-none"
      >
        <div className="flex items-center gap-4 min-w-0 pointer-events-auto">
          <button
            type="button"
            data-tv-focusable="true"
            onClick={onClose}
            className="h-12 px-5 rounded-xl bg-black/80 hover:bg-white/25 border border-white/25 text-white flex items-center gap-2 text-sm font-semibold whitespace-nowrap shrink-0 shadow-lg"
          >
            <ChevronLeft className="w-5 h-5" />
            Voltar
          </button>
          <div
            className={`min-w-0 transition-opacity duration-200 ${
              showControls || effectiveType === 'embed' ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <h2 className="font-display text-lg sm:text-xl font-semibold text-white truncate">
              {item.title}
            </h2>
            <p className="text-xs text-slate-300 truncate font-mono">
              {item.category} · {activeQuality?.label || item.quality || effectiveType.toUpperCase()}
              {item.duration ? ` · ${item.duration}` : ''}
            </p>
          </div>
        </div>

        <div
          className={`flex items-center gap-3 shrink-0 transition-opacity duration-200 ${
            showControls || effectiveType === 'embed'
              ? 'opacity-100 pointer-events-auto'
              : 'opacity-0 pointer-events-none'
          }`}
        >
          <button
            type="button"
            data-tv-focusable="true"
            onClick={() => onToggleFavorite(item)}
            className={`h-11 px-4 rounded-xl flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0 ${
              isFavorite
                ? 'bg-amber-500/20 text-amber-300 border border-amber-400/40'
                : 'bg-white/10 hover:bg-white/20 text-white'
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
              className="h-11 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
            >
              <ListVideo className="w-4 h-4" />
              Lista ({playlist.length})
            </button>
          )}
        </div>
      </div>

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
              <span>{duration > 0 ? formatTime(duration) : 'Stream'}</span>
            </div>
            <div
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                if (videoRef.current && duration > 0) {
                  videoRef.current.currentTime = ratio * duration;
                  setCurrentTime(videoRef.current.currentTime);
                }
              }}
              className="h-2.5 w-full rounded-full bg-white/20 overflow-hidden cursor-pointer"
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
              {qualities.length > 1 && (
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={cycleQuality}
                  className="h-12 px-4 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-xs font-mono font-medium text-sky-200 flex items-center gap-2 whitespace-nowrap shrink-0"
                >
                  <Settings2 className="w-4 h-4" />
                  Resolução: {activeQuality?.label}
                </button>
              )}

              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
                    initialSeekRef.current = videoRef.current.currentTime;
                    appliedInitialSeekForIdRef.current = null;
                  }
                  setUseProxy((p) => !p);
                }}
                className="h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0"
              >
                {useProxy ? 'Rota: Proxy' : 'Rota: Direto'}
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
