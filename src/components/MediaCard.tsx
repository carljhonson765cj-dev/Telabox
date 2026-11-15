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

  const metaParts = [
    item.category,
    item.quality,
    item.format,
    item.duration,
    item.size,
  ].filter(Boolean);

  return (
    <button
      type="button"
      data-tv-focusable="true"
      onClick={() => onPlay(item)}
      className={`group relative text-left rounded-xl bg-[#12151E] border border-white/8 overflow-hidden transition-transform duration-150 focus:scale-[1.03] hover:scale-[1.02] hover:border-white/25 focus:z-10 ${
        compact ? 'w-[260px] shrink-0' : 'w-full'
      }`}
    >
      <div className="relative aspect-video w-full bg-[#0D1017] overflow-hidden">
        <MediaPoster src={item.thumbnail} alt={item.title} category={item.category} />

        {/* Subtle bottom scrim for legibility of hover/focus play cue */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent opacity-80 group-hover:opacity-100 group-focus:opacity-100 transition-opacity" />

        {/* Center play affordance visible on focus/hover */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-white text-[#090A0F] flex items-center justify-center shadow-xl">
            <Play className="w-5 h-5 fill-current ml-0.5" />
          </div>
        </div>

        {/* Favorite subtle corner marker if favorited */}
        {isFavorite && (
          <div className="absolute top-2.5 right-2.5 w-7 h-7 rounded-lg bg-black/70 border border-white/15 flex items-center justify-center text-amber-400">
            <Star className="w-3.5 h-3.5 fill-current" />
          </div>
        )}

        {/* Watch progress bar */}
        {progressPct > 0 && (
          <div className="absolute bottom-0 inset-x-0 h-1 bg-white/20">
            <div
              className="h-full bg-sky-400 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>

      <div className="p-3.5">
        <h3 className="font-display font-semibold text-[15px] text-slate-100 leading-snug line-clamp-1 group-focus:text-white">
          {item.title}
        </h3>
        <p className="mt-1 text-xs text-slate-400 truncate font-mono tabular-nums">
          {metaParts.slice(0, 3).join(' · ') || 'Vídeo'}
        </p>
      </div>
    </button>
  );
}
