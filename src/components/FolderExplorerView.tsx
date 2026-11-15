import { useMemo, useState } from 'react';
import { Folder, FolderOpen, Play } from 'lucide-react';
import type { MediaItem, ServerProfile, WatchProgress } from '../types/media';
import { deduplicateMediaItems } from '../utils/dedupeMedia';
import { MediaCard } from './MediaCard';

interface FolderExplorerViewProps {
  server: ServerProfile;
  favoriteIds: Set<string>;
  progressMap: Record<string, WatchProgress>;
  onPlay: (item: MediaItem, list: MediaItem[]) => void;
}

export function FolderExplorerView({
  server,
  favoriteIds,
  progressMap,
  onPlay,
}: FolderExplorerViewProps) {
  const folders = useMemo(() => {
    const map = new Map<string, MediaItem[]>();
    for (const item of server.items) {
      const key = item.folderPath || '/';
      const existing = map.get(key) || [];
      existing.push(item);
      map.set(key, existing);
    }
    return Array.from(map.entries())
      .map(([path, list]) => [path, deduplicateMediaItems(list, { acrossCategories: true })] as [string, MediaItem[]])
      .sort(([a], [b]) => a.localeCompare(b, 'pt-BR'));
  }, [server.items]);

  const [selectedFolder, setSelectedFolder] = useState<string>(folders[0]?.[0] || '/');

  const activeFolderItems = useMemo(() => {
    const found = folders.find(([path]) => path === selectedFolder);
    return found ? found[1] : folders[0]?.[1] || [];
  }, [folders, selectedFolder]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left Folder Column */}
      <div className="lg:col-span-4 rounded-2xl bg-[#12151E] border border-white/8 p-4">
        <div className="flex items-center justify-between px-2 pb-3 mb-3 border-b border-white/8">
          <h2 className="font-display text-base font-semibold text-white">
            Pastas do Servidor
          </h2>
          <span className="text-xs font-mono tabular-nums text-slate-400">
            {folders.length}
          </span>
        </div>

        <div className="space-y-1.5 max-h-[65vh] overflow-y-auto pr-1">
          {folders.map(([folderPath, items]) => {
            const isSelected = folderPath === selectedFolder;
            return (
              <button
                key={folderPath}
                type="button"
                data-tv-focusable="true"
                onClick={() => setSelectedFolder(folderPath)}
                className={`w-full px-3.5 py-3 rounded-xl text-left flex items-center justify-between gap-3 border transition-colors ${
                  isSelected
                    ? 'bg-sky-500/15 border-sky-400/50 text-white'
                    : 'bg-[#161A26] border-white/5 text-slate-300 hover:bg-[#1D2232]'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {isSelected ? (
                    <FolderOpen className="w-4 h-4 text-sky-400 shrink-0" />
                  ) : (
                    <Folder className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                  <span className="text-sm font-medium truncate font-mono">
                    {folderPath === '/' ? 'Raiz (/)' : folderPath}
                  </span>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-400 shrink-0">
                  {items.length}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right Folder Contents */}
      <div className="lg:col-span-8">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
          <div>
            <h3 className="font-display text-xl font-semibold text-white">
              {selectedFolder === '/' ? 'Pasta Principal' : selectedFolder}
            </h3>
            <p className="text-sm text-slate-400 font-mono tabular-nums">
              {activeFolderItems.length}{' '}
              {activeFolderItems.length === 1 ? 'vídeo encontrado' : 'vídeos encontrados'}
            </p>
          </div>
          {activeFolderItems.length > 0 && (
            <button
              type="button"
              data-tv-focusable="true"
              onClick={() => onPlay(activeFolderItems[0], activeFolderItems)}
              className="h-11 px-5 rounded-xl bg-white text-[#090A0F] hover:bg-slate-200 font-semibold text-sm flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <Play className="w-4 h-4 fill-current" />
              Reproduzir Pasta
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {activeFolderItems.map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              isFavorite={favoriteIds.has(item.id)}
              progress={progressMap[item.id]}
              onPlay={(chosen) => onPlay(chosen, activeFolderItems)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
