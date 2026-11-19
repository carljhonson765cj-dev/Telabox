import { Play, Star } from 'lucide-react';
import type { MediaItem, WatchProgress } from '../types/media';
import { MediaPoster } from './MediaPoster';

interface MediaCardProps {
  item: MediaItem;
  isFavorite: boolean;
  progress?: WatchProgress;
  onPlay: (item: MediaItem) => void;
  onToggleFavorite?: (item: MediaItem) => void;
  compact?: boolean;
}

export function MediaCard({
  item,
  isFavorite,
  progress,
  onPlay,
  compact = false,
}: MediaCardProps) {
  const progressPct =
    progress && progress.duration > 10
      ? Math.min(100, Math.max(4, Math.round((progress.currentTime / progress.duration) * 100)))
      : 0;

  const badgeLabel =
    item.quality ||
    (item.format ? item.format.toUpperCase() : null) ||
    (item.streamType === 'hls' ? 'HLS' : item.streamType === 'dash' ? 'DASH' : null);

  const subMeta = [item.duration, item.category].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      data-tv-focusable="true"
      onClick={() => onPlay(item)}
      className={`group relative text-left rounded-lg bg-[#16181F] border-2 border-transparent hover:border-[#FFB800] focus:border-[#FFB800] transition-transform duration-150 ease-out hover:scale-105 focus:scale-105 hover:z-10 focus:z-20 overflow-hidden flex flex-col ${
        compact ? 'w-[152px] sm:w-[172px] lg:w-[192px] shrink-0 snap-start' : 'w-full'
      }`}
    >
      {/* Vertical 2:3 Poster Container */}
      <div className="relative aspect-[2/3] w-full bg-[#0E1016] overflow-hidden rounded-t-md">
        <MediaPoster src={item.thumbnail} alt={item.title} category={item.category} />

        {/* Subtle bottom contrast scrim */}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0B0C10]/85 via-transparent to-[#0B0C10]/25 opacity-75 group-hover:opacity-95 group-focus:opacity-95 transition-opacity" />

        {/* Discreet top-left quality/format badge */}
        {badgeLabel && (
          <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-[#0B0C10]/80 backdrop-blur-sm border border-white/10 text-[10px] font-mono font-semibold text-[#FFB800] tracking-wide uppercase max-w-[68%] truncate">
            {badgeLabel}
          </span>
        )}

        {/* Favorite corner marker */}
        {isFavorite && (
          <span
            className="absolute top-2 right-2 w-6 h-6 rounded bg-[#0B0C10]/80 backdrop-blur-sm border border-[#FFB800]/40 flex items-center justify-center text-[#FFB800]"
            aria-label="Favorito"
          >
            <Star className="w-3.5 h-3.5 fill-current" />
          </span>
        )}

        {/* Gold Play affordance on hover/focus */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-[#FFB800] text-[#0B0C10] flex items-center justify-center shadow-2xl">
            <Play className="w-5 h-5 fill-current ml-0.5" />
          </div>
        </div>

        {/* Watch progress bar */}
        {progressPct > 0 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-white/20">
            <div
              className="h-full bg-[#FFB800] transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>

      {/* Clean Title Below Poster */}
      <div className="p-2.5 sm:p-3 flex-1 flex flex-col justify-between bg-[#16181F]">
        <h3 className="font-display font-semibold text-xs sm:text-sm text-slate-100 leading-snug line-clamp-2 group-hover:text-[#FFB800] group-focus:text-[#FFB800] transition-colors">
          {item.title}
        </h3>
        {subMeta && (
          <p className="mt-1 text-[11px] text-slate-400 truncate font-mono tabular-nums">
            {subMeta}
          </p>
        )}
      </div>
    </button>
  );
}
