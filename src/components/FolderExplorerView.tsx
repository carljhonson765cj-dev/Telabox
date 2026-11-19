import { useMemo, useState } from 'react';
import { Folder, FolderOpen, Layers, Play } from 'lucide-react';
import type { MediaItem, ServerProfile, WatchProgress } from '../types/media';
import { deduplicateMediaItems } from '../utils/dedupeMedia';
import { MediaCard } from './MediaCard';

interface FolderExplorerViewProps {
  server: ServerProfile;
  favoriteIds: Set<string>;
  progressMap: Record<string, WatchProgress>;
  onPlay: (item: MediaItem, list: MediaItem[]) => void;
  onSelectCategory?: (category: string) => void;
}

export function FolderExplorerView({
  server,
  favoriteIds,
  progressMap,
  onPlay,
  onSelectCategory,
}: FolderExplorerViewProps) {
  const [viewMode, setViewMode] = useState<'categories' | 'folders'>('categories');

  const categoryGroups = useMemo(() => {
    const map = new Map<string, MediaItem[]>();
    for (const item of server.items) {
      const cat = item.category || 'Geral';
      const list = map.get(cat) || [];
      list.push(item);
      map.set(cat, list);
    }
    const orderedCats = Array.from(
      new Set([
        ...server.categories,
        ...Object.keys(server.categorySources || {}),
        ...Array.from(map.keys()),
      ])
    ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    return orderedCats.map((name) => ({
      name,
      items: deduplicateMediaItems(map.get(name) || [], { acrossCategories: true }),
    }));
  }, [server.items, server.categories, server.categorySources]);

  const folders = useMemo(() => {
    const map = new Map<string, MediaItem[]>();
    for (const item of server.items) {
      const key = item.folderPath || '/';
      const existing = map.get(key) || [];
      existing.push(item);
      map.set(key, existing);
    }
    return Array.from(map.entries())
      .map(
        ([path, list]) =>
          [path, deduplicateMediaItems(list, { acrossCategories: true })] as [string, MediaItem[]]
      )
      .sort(([a], [b]) => a.localeCompare(b, 'pt-BR'));
  }, [server.items]);

  const [selectedFolder, setSelectedFolder] = useState<string>(folders[0]?.[0] || '/');

  const activeFolderItems = useMemo(() => {
    const found = folders.find(([path]) => path === selectedFolder);
    return found ? found[1] : folders[0]?.[1] || [];
  }, [folders, selectedFolder]);

  return (
    <div className="space-y-6">
      {/* Header + Mode Switcher (Categorias vs Pastas do Servidor) */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Categorias &amp; Pastas
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Explore as categorias do catálogo ou navegue diretamente pela estrutura de pastas do servidor.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#16181F] border border-white/10">
          <button
            type="button"
            data-tv-focusable="true"
            onClick={() => setViewMode('categories')}
            className={`px-4 py-2 rounded-md text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
              viewMode === 'categories'
                ? 'bg-[#FFB800] text-[#0B0C10]'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Layers className="w-4 h-4" />
            Categorias ({categoryGroups.length})
          </button>
          <button
            type="button"
            data-tv-focusable="true"
            onClick={() => setViewMode('folders')}
            className={`px-4 py-2 rounded-md text-xs font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
              viewMode === 'folders'
                ? 'bg-[#FFB800] text-[#0B0C10]'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Folder className="w-4 h-4" />
            Pastas ({folders.length})
          </button>
        </div>
      </div>

      {viewMode === 'categories' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3.5">
          {categoryGroups.map((cat) => (
            <button
              key={cat.name}
              type="button"
              data-tv-focusable="true"
              onClick={() => {
                if (onSelectCategory) {
                  onSelectCategory(cat.name);
                } else if (cat.items.length > 0) {
                  onPlay(cat.items[0], cat.items);
                }
              }}
              className="group p-4 rounded-lg bg-[#16181F] border-2 border-white/8 hover:border-[#FFB800] focus:border-[#FFB800] hover:scale-105 focus:scale-105 transition-transform duration-150 text-left flex flex-col justify-between min-h-[104px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="w-8 h-8 rounded-md bg-[#FFB800]/12 text-[#FFB800] flex items-center justify-center shrink-0">
                  <Layers className="w-4 h-4" />
                </span>
                <span className="text-xs font-mono tabular-nums text-slate-400 group-hover:text-[#FFB800] group-focus:text-[#FFB800]">
                  {cat.items.length > 0 ? `${cat.items.length}` : 'Abrir'}
                </span>
              </div>
              <span className="mt-3 font-display font-semibold text-sm text-white line-clamp-2 group-hover:text-[#FFB800] group-focus:text-[#FFB800]">
                {cat.name}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Folder Column */}
          <div className="lg:col-span-4 rounded-lg bg-[#16181F] border border-white/8 p-4">
            <div className="flex items-center justify-between px-2 pb-3 mb-3 border-b border-white/8">
              <h2 className="font-display text-base font-semibold text-white">
                Pastas do Servidor
              </h2>
              <span className="text-xs font-mono tabular-nums text-[#FFB800]">
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
                    className={`w-full px-3.5 py-3 rounded-lg text-left flex items-center justify-between gap-3 border-2 transition-all ${
                      isSelected
                        ? 'bg-[#FFB800]/12 border-[#FFB800] text-white'
                        : 'bg-[#0B0C10] border-white/6 text-slate-300 hover:border-white/25'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isSelected ? (
                        <FolderOpen className="w-4 h-4 text-[#FFB800] shrink-0" />
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
                  className="h-11 px-5 rounded-lg bg-[#FFB800] hover:bg-[#FFC933] text-[#0B0C10] font-display font-bold text-sm flex items-center gap-2 whitespace-nowrap shrink-0 hover:scale-105 focus:scale-105"
                >
                  <Play className="w-4 h-4 fill-current" />
                  Reproduzir Pasta
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
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
      )}
    </div>
  );
}
