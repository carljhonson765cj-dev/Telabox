import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FolderTree,
  Gamepad2,
  Globe,
  Home,
  Keyboard,
  Loader2,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  Star,
  Tv,
  Unlock,
  X,
} from 'lucide-react';
import type {
  CategorySource,
  MediaItem,
  ScanMode,
  ScanProgressEvent,
  ServerProfile,
  WatchProgress,
} from './types/media';
import { useDpadNavigation } from './hooks/useDpadNavigation';
import { MediaCard } from './components/MediaCard';
import { MediaPoster } from './components/MediaPoster';
import { VideoPlayerModal } from './components/VideoPlayerModal';
import { VirtualRemoteModal } from './components/VirtualRemoteModal';
import { FolderExplorerView } from './components/FolderExplorerView';
import { ServerConnectPanel } from './components/ServerConnectPanel';
import { OnScreenKeyboard } from './components/OnScreenKeyboard';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PinLockOverlay, type PinOverlayMode } from './components/PinLockOverlay';
import { fetchJson } from './utils/safeFetch';
import { canonicalizeMediaUrl, deduplicateMediaItems, normalizeMediaTitle } from './utils/dedupeMedia';
import tvCinemaBackdrop from './assets/images/tv_cinema_backdrop_1794706797783.jpg';

const RECENT_CATEGORY = 'Adicionados Recentemente';

type NavTab = 'home' | 'servers' | 'folders' | 'search' | 'favorites';

const STORAGE_SERVERS_KEY = 'telabox_servers_v1';
const STORAGE_ACTIVE_ID_KEY = 'telabox_active_server_v1';
const STORAGE_FAVORITES_KEY = 'telabox_favorites_v1';
const STORAGE_PROGRESS_KEY = 'telabox_watch_progress_v1';
const STORAGE_RECENT_SEARCHES_KEY = 'telabox_recent_searches_v1';
const STORAGE_PIN_KEY = 'telabox_pin_lock_v1';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [savedServers, setSavedServers] = useState<ServerProfile[]>(() =>
    loadJson<ServerProfile[]>(STORAGE_SERVERS_KEY, []).map((srv) => {
      const cleanItems = deduplicateMediaItems(srv.items || []);
      const cleanCategories = Array.from(new Set(cleanItems.map((i) => i.category))).sort((a, b) =>
        a.localeCompare(b, 'pt-BR')
      );
      return { ...srv, items: cleanItems, categories: cleanCategories };
    })
  );
  const [activeServerId, setActiveServerId] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_ACTIVE_ID_KEY)
  );
  const [favorites, setFavorites] = useState<MediaItem[]>(() =>
    deduplicateMediaItems(loadJson<MediaItem[]>(STORAGE_FAVORITES_KEY, []), {
      acrossCategories: true,
    })
  );
  const [progressMap, setProgressMap] = useState<Record<string, WatchProgress>>(() =>
    loadJson<Record<string, WatchProgress>>(STORAGE_PROGRESS_KEY, {})
  );

  const [activeTab, setActiveTab] = useState<NavTab>(() =>
    loadJson<ServerProfile[]>(STORAGE_SERVERS_KEY, []).length > 0 ? 'home' : 'servers'
  );
  const [selectedCategory, setSelectedCategory] = useState<string>('Tudo');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'active' | 'all'>('active');
  const [searchQualityFilter, setSearchQualityFilter] = useState<'all' | 'hd'>('all');
  const [remoteSearching, setRemoteSearching] = useState(false);
  const [remoteSearchResults, setRemoteSearchResults] = useState<{
    query: string;
    serverId: string;
    items: MediaItem[];
    page: number;
    nextPage: number;
    pagesFetched: number;
    hasMore: boolean;
    error: string | null;
  } | null>(null);
  const [browsingMore, setBrowsingMore] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [batchFeedback, setBatchFeedback] = useState<string | null>(null);
  const [autoInfiniteScroll, setAutoInfiniteScroll] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('telabox_infinite_scroll_v1');
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [refreshingLatest, setRefreshingLatest] = useState(false);
  const [newUpdatesNotice, setNewUpdatesNotice] = useState<{
    count: number;
    serverId: string;
  } | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>(() =>
    loadJson<string[]>(STORAGE_RECENT_SEARCHES_KEY, [])
  );
  const [showSearchKeyboard, setShowSearchKeyboard] = useState(false);
  const [showVirtualRemote, setShowVirtualRemote] = useState(false);
  const [pinCode, setPinCode] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PIN_KEY);
      return saved && /^\d{4}$/.test(saved) ? saved : null;
    } catch {
      return null;
    }
  });
  const [isAppUnlocked, setIsAppUnlocked] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PIN_KEY);
      return !(saved && /^\d{4}$/.test(saved));
    } catch {
      return true;
    }
  });
  const [pinModalMode, setPinModalMode] = useState<Exclude<PinOverlayMode, 'unlock'> | null>(null);
  const [showPinQuickMenu, setShowPinQuickMenu] = useState(false);
  const pinQuickMenuCloseRef = useRef<HTMLButtonElement>(null);
  const [clockText, setClockText] = useState(() =>
    new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  );

  // Player state
  const [playerState, setPlayerState] = useState<{
    item: MediaItem;
    playlist: MediaItem[];
  } | null>(null);

  // Live SSE scan state
  const eventSourceRef = useRef<EventSource | null>(null);
  const liveItemsRef = useRef<MediaItem[]>([]);
  const browseSentinelRef = useRef<HTMLDivElement | null>(null);
  const searchSentinelRef = useRef<HTMLDivElement | null>(null);
  const lastAutoTriggerRef = useRef<number>(0);
  const [scanStatus, setScanStatus] = useState({
    scanning: false,
    pagesScanned: 0,
    maxPages: 5,
    foldersFound: 0,
    itemsFound: 0,
    currentUrl: '',
    categories: [] as string[],
    error: null as string | null,
  });

  // Sync persistence with safe quota fallback for huge multi-page catalogs
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify(savedServers));
    } catch {
      try {
        const trimmed = savedServers.map((s) => ({
          ...s,
          items: s.items.slice(0, 300),
        }));
        localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify(trimmed));
      } catch {
        // ignore storage quota errors on constrained devices
      }
    }
  }, [savedServers]);

  useEffect(() => {
    if (activeServerId) {
      localStorage.setItem(STORAGE_ACTIVE_ID_KEY, activeServerId);
    } else {
      localStorage.removeItem(STORAGE_ACTIVE_ID_KEY);
    }
  }, [activeServerId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_FAVORITES_KEY, JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    localStorage.setItem(STORAGE_PROGRESS_KEY, JSON.stringify(progressMap));
  }, [progressMap]);

  useEffect(() => {
    localStorage.setItem(STORAGE_RECENT_SEARCHES_KEY, JSON.stringify(recentSearches));
  }, [recentSearches]);

  useEffect(() => {
    try {
      localStorage.setItem('telabox_infinite_scroll_v1', String(autoInfiniteScroll));
    } catch {
      // ignore storage errors
    }
  }, [autoInfiniteScroll]);

  useEffect(() => {
    try {
      if (pinCode) {
        localStorage.setItem(STORAGE_PIN_KEY, pinCode);
      } else {
        localStorage.removeItem(STORAGE_PIN_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [pinCode]);

  // Real-time TV clock
  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockText(
        new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      );
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  const activeServer = useMemo(() => {
    if (!savedServers.length) return null;
    return savedServers.find((s) => s.id === activeServerId) || savedServers[0];
  }, [savedServers, activeServerId]);

  const favoriteIds = useMemo(
    () => new Set(favorites.map((f) => f.id)),
    [favorites]
  );

  const handleBack = useCallback(() => {
    if (pinCode && !isAppUnlocked) {
      return;
    }
    if (showPinQuickMenu) {
      setShowPinQuickMenu(false);
      return;
    }
    if (pinModalMode) {
      setPinModalMode(null);
      return;
    }
    if (playerState) {
      setPlayerState(null);
      return;
    }
    if (showSearchKeyboard) {
      setShowSearchKeyboard(false);
      return;
    }
    if (selectedCategory !== 'Tudo' && activeTab === 'home') {
      setSelectedCategory('Tudo');
      return;
    }
    if (activeTab !== 'home' && activeServer) {
      setActiveTab('home');
    }
  }, [pinCode, isAppUnlocked, showPinQuickMenu, pinModalMode, playerState, showSearchKeyboard, selectedCategory, activeTab, activeServer]);

  const { moveFocus, activateFocused, focusFirstVisible } = useDpadNavigation({
    enabled: true,
    onBack: handleBack,
  });

  // Ensure Mi TV Stick D-Pad always has an active focused element after view/player transitions
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      return;
    }
    if (!active || active === document.body || !(active instanceof HTMLElement) || active.dataset.tvFocusable !== 'true') {
      const t = window.setTimeout(() => focusFirstVisible(), 50);
      return () => window.clearTimeout(t);
    }
  }, [activeTab, playerState, activeServer?.id, isAppUnlocked, pinModalMode, showPinQuickMenu, focusFirstVisible]);

  useEffect(() => {
    if (showPinQuickMenu) {
      const t = window.setTimeout(() => pinQuickMenuCloseRef.current?.focus(), 40);
      return () => window.clearTimeout(t);
    }
  }, [showPinQuickMenu]);

  const finalizeLiveServer = useCallback(
    (
      url: string,
      customName: string | undefined,
      mode: ScanMode,
      useProxy: boolean,
      partialProfile?: Omit<ServerProfile, 'id' | 'useProxy'>
    ) => {
      const rawItems = partialProfile?.items || liveItemsRef.current;
      const items = deduplicateMediaItems(rawItems);
      if (items.length === 0) {
        setScanStatus((prev) => ({
          ...prev,
          scanning: false,
          error:
            'Nenhum arquivo de vídeo ou stream compatível foi encontrado neste endereço. Verifique se o link aponta para um site com vídeos, diretório aberto ou lista .m3u.',
        }));
        return;
      }

      const categories = Array.from(new Set(items.map((i) => i.category))).sort((a, b) =>
        a.localeCompare(b, 'pt-BR')
      );

      let hostFallback = url;
      try {
        hostFallback = new URL(url.startsWith('/') ? window.location.origin + url : url).hostname;
      } catch {
        // keep url
      }

      const existingIdx = savedServers.findIndex((s) => s.url === (partialProfile?.url || url));
      const newId =
        existingIdx >= 0
          ? savedServers[existingIdx].id
          : `srv_${Date.now().toString(36)}`;

      const profile: ServerProfile = {
        id: newId,
        name: customName || partialProfile?.name || hostFallback,
        url: partialProfile?.url || url,
        scannedAt: partialProfile?.scannedAt || Date.now(),
        serverKind: partialProfile?.serverKind || 'portal',
        scanMode: mode,
        useProxy,
        categories,
        items,
        pagesScanned: partialProfile?.pagesScanned || scanStatus.pagesScanned || 1,
        foldersFound: partialProfile?.foldersFound || categories.length,
        nextPageUrl: partialProfile?.nextPageUrl,
        latestUrl: partialProfile?.latestUrl,
        lastUpdatedAt: Date.now(),
        categorySources: partialProfile?.categorySources,
      };

      setSavedServers((prev) => {
        const idx = prev.findIndex((s) => s.id === profile.id || s.url === profile.url);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = profile;
          return copy;
        }
        return [profile, ...prev];
      });
      setActiveServerId(profile.id);
      setSelectedCategory('Tudo');
      setScanStatus((prev) => ({ ...prev, scanning: false, error: null }));
      setActiveTab('home');
    },
    [savedServers, scanStatus.pagesScanned]
  );

  const pendingScanMetaRef = useRef<{
    url: string;
    customName?: string;
    mode: ScanMode;
    useProxy: boolean;
  } | null>(null);

  const startServerScan = useCallback(
    ({
      url,
      customName,
      mode,
      useProxy,
    }: {
      url: string;
      customName?: string;
      mode: ScanMode;
      useProxy: boolean;
    }) => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      liveItemsRef.current = [];
      pendingScanMetaRef.current = { url, customName, mode, useProxy };

      const maxPages = mode === 'quick' ? 1 : 5;
      const maxDepth = mode === 'quick' ? 0 : 1;

      setScanStatus({
        scanning: true,
        pagesScanned: 0,
        maxPages,
        foldersFound: 0,
        itemsFound: 0,
        currentUrl: url,
        categories: [],
        error: null,
      });

      const sseUrl = `/api/scan/stream?url=${encodeURIComponent(url)}&mode=${mode}&maxPages=${maxPages}&maxDepth=${maxDepth}`;
      const es = new EventSource(sseUrl);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as ScanProgressEvent;
          if (payload.type === 'progress') {
            setScanStatus((prev) => ({
              ...prev,
              pagesScanned: payload.pagesScanned ?? prev.pagesScanned,
              maxPages: payload.maxPages ?? prev.maxPages,
              foldersFound: payload.foldersFound ?? prev.foldersFound,
              itemsFound: payload.itemsFound ?? prev.itemsFound,
              currentUrl: payload.currentUrl ?? prev.currentUrl,
              categories: payload.categories ?? prev.categories,
            }));
          } else if (payload.type === 'item' && payload.item) {
            liveItemsRef.current = [...liveItemsRef.current, payload.item];
            setScanStatus((prev) => ({
              ...prev,
              itemsFound: liveItemsRef.current.length,
            }));
          } else if (payload.type === 'complete' && payload.profile) {
            es.close();
            eventSourceRef.current = null;
            finalizeLiveServer(url, customName, mode, useProxy, payload.profile);
          } else if (payload.type === 'error') {
            es.close();
            eventSourceRef.current = null;
            setScanStatus((prev) => ({
              ...prev,
              scanning: false,
              error: payload.message || 'Não foi possível acessar o servidor informado.',
            }));
          }
        } catch {
          // ignore malformed event frame
        }
      };

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        if (liveItemsRef.current.length > 0) {
          finalizeLiveServer(url, customName, mode, useProxy);
        } else {
          setScanStatus((prev) => ({
            ...prev,
            scanning: false,
            error: 'Conexão encerrada antes de receber resposta do servidor.',
          }));
        }
      };
    },
    [finalizeLiveServer]
  );

  const stopServerScan = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const meta = pendingScanMetaRef.current;
    if (meta && liveItemsRef.current.length > 0) {
      finalizeLiveServer(meta.url, meta.customName, meta.mode, meta.useProxy);
    } else {
      setScanStatus((prev) => ({ ...prev, scanning: false }));
    }
  }, [finalizeLiveServer]);

  const toggleFavorite = useCallback((item: MediaItem) => {
    setFavorites((prev) => {
      const exists = prev.some((f) => f.id === item.id);
      if (exists) return prev.filter((f) => f.id !== item.id);
      return [item, ...prev];
    });
  }, []);

  const saveProgress = useCallback((progress: WatchProgress) => {
    setProgressMap((prev) => ({
      ...prev,
      [progress.itemId]: progress,
    }));
  }, []);

  const openPlayer = useCallback((item: MediaItem, list: MediaItem[]) => {
    setPlayerState({ item, playlist: list });
  }, []);

  const deleteServer = useCallback(
    (id: string) => {
      setSavedServers((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (activeServerId === id) {
          setActiveServerId(next[0]?.id || null);
        }
        return next;
      });
    },
    [activeServerId]
  );

  const handleImportBackup = useCallback(
    (payload: { servers: ServerProfile[]; favorites: MediaItem[] }) => {
      let serversAdded = 0;
      let serversUpdated = 0;

      const nextServers = [...savedServers];
      for (const incoming of payload.servers) {
        const matchIdx = nextServers.findIndex(
          (existing) =>
            existing.id === incoming.id ||
            existing.url.replace(/\/+$/, '').toLowerCase() ===
              incoming.url.replace(/\/+$/, '').toLowerCase()
        );
        if (matchIdx >= 0) {
          const existing = nextServers[matchIdx];
          const mergedItems = deduplicateMediaItems([...existing.items, ...incoming.items]);
          const mergedCategories = Array.from(
            new Set([
              ...existing.categories,
              ...incoming.categories,
              ...mergedItems.map((i) => i.category),
            ])
          ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

          nextServers[matchIdx] = {
            ...existing,
            ...incoming,
            id: existing.id,
            items: mergedItems,
            categories: mergedCategories,
            categorySources: {
              ...(existing.categorySources || {}),
              ...(incoming.categorySources || {}),
            },
          };
          serversUpdated += 1;
        } else {
          nextServers.push(incoming);
          serversAdded += 1;
        }
      }

      const existingFavKeys = new Set(favorites.map((f) => canonicalizeMediaUrl(f.url) || f.id));
      let favoritesAdded = 0;
      for (const fav of payload.favorites) {
        const key = canonicalizeMediaUrl(fav.url) || fav.id;
        if (!existingFavKeys.has(key)) {
          existingFavKeys.add(key);
          favoritesAdded += 1;
        }
      }
      const nextFavorites = deduplicateMediaItems([...favorites, ...payload.favorites], {
        acrossCategories: true,
      });

      setSavedServers(nextServers);
      setFavorites(nextFavorites);
      if (!activeServerId && nextServers.length > 0) {
        setActiveServerId(nextServers[0].id);
      }

      return { serversAdded, serversUpdated, favoritesAdded };
    },
    [savedServers, favorites, activeServerId]
  );

  // Catalog derivations for active server
  const continueWatchingItems = useMemo(() => {
    if (!activeServer) return [];
    return activeServer.items
      .filter((item) => {
        const p = progressMap[item.id];
        return p && p.currentTime > 5 && (p.duration === 0 || p.currentTime / p.duration < 0.95);
      })
      .sort((a, b) => (progressMap[b.id]?.updatedAt || 0) - (progressMap[a.id]?.updatedAt || 0));
  }, [activeServer, progressMap]);

  const groupedByCategory = useMemo(() => {
    if (!activeServer) return [];
    const uniqueCats = Array.from(new Set(activeServer.categories)).sort((a, b) => {
      if (a === RECENT_CATEGORY) return -1;
      if (b === RECENT_CATEGORY) return 1;
      return 0;
    });
    return uniqueCats
      .map((cat) => ({
        category: cat,
        items: deduplicateMediaItems(
          activeServer.items.filter((i) => i.category === cat),
          { acrossCategories: true }
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [activeServer]);

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const group of groupedByCategory) {
      map.set(group.category, group.items.length);
    }
    return map;
  }, [groupedByCategory]);

  const featuredItem = useMemo(() => {
    if (!activeServer || activeServer.items.length === 0) return null;
    if (continueWatchingItems.length > 0) return continueWatchingItems[0];
    return activeServer.items.find((i) => Boolean(i.thumbnail)) || activeServer.items[0];
  }, [activeServer, continueWatchingItems]);

  const filteredCategoryItems = useMemo(() => {
    if (!activeServer) return [];
    const raw =
      selectedCategory === 'Tudo'
        ? activeServer.items
        : activeServer.items.filter((i) => i.category === selectedCategory);
    return deduplicateMediaItems(raw, { acrossCategories: true });
  }, [activeServer, selectedCategory]);

  const allCategoryNames = useMemo(() => {
    if (!activeServer) return [];
    const seen = new Set<string>();
    const ordered: string[] = [];

    const pushUnique = (cat: string) => {
      if (!seen.has(cat)) {
        seen.add(cat);
        ordered.push(cat);
      }
    };

    if (
      activeServer.categories.includes(RECENT_CATEGORY) ||
      activeServer.categorySources?.[RECENT_CATEGORY]
    ) {
      pushUnique(RECENT_CATEGORY);
    }

    for (const cat of activeServer.categories) {
      pushUnique(cat);
    }
    if (activeServer.categorySources) {
      const extra = Object.keys(activeServer.categorySources)
        .filter((c) => !seen.has(c))
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      for (const c of extra) {
        pushUnique(c);
      }
    }
    return ordered;
  }, [activeServer]);

  const loadMoreFromServer = useCallback(
    async (targetCat?: string, batchPages = 4) => {
      if (!activeServer || browsingMore) return;
      const cat = targetCat ?? selectedCategory;

      let targetUrl: string | undefined;
      let categoryParam: string | undefined;

      if (cat && cat !== 'Tudo') {
        const src = activeServer.categorySources?.[cat];
        targetUrl = src?.pageLoaded === 0 ? src.url : src?.nextPageUrl;
        categoryParam = cat;
      } else {
        targetUrl = activeServer.nextPageUrl;
      }

      if (!targetUrl) return;
      setBrowsingMore(true);
      setBrowseError(null);
      setBatchFeedback(null);

      try {
        const qs = new URLSearchParams({
          url: targetUrl,
          pages: String(Math.min(Math.max(batchPages, 1), 5)),
        });
        if (categoryParam) qs.set('category', categoryParam);

        const { ok, data } = await fetchJson<{
          items?: MediaItem[];
          nextPageUrl?: string;
          pagesFetched?: number;
          categorySources?: Record<string, CategorySource>;
          error?: string;
        }>(`/api/browse?${qs.toString()}`);

        if (!ok) {
          throw new Error(data.error || 'Falha ao carregar mais vídeos do site.');
        }

        const fetchedItems = Array.isArray(data.items) ? data.items : [];
        const pagesFetched = Math.max(1, Number(data.pagesFetched) || 1);
        const serverId = activeServer.id;
        const previousCount = activeServer.items.length;

        let addedCount = 0;

        setSavedServers((prev) =>
          prev.map((srv) => {
            if (srv.id !== serverId) return srv;
            const mergedItems = deduplicateMediaItems([...srv.items, ...fetchedItems]);
            addedCount = Math.max(0, mergedItems.length - srv.items.length);
            const hasMoreNewItems = fetchedItems.length > 0 && addedCount > 0;
            const effectiveNextUrl = hasMoreNewItems ? data.nextPageUrl : undefined;
            const mergedCats = Array.from(new Set(mergedItems.map((i) => i.category))).sort((a, b) =>
              a.localeCompare(b, 'pt-BR')
            );
            const nextSources: Record<string, CategorySource> = {
              ...(srv.categorySources || {}),
            };
            if (data.categorySources) {
              for (const [k, v] of Object.entries(data.categorySources)) {
                if (!nextSources[k]) {
                  nextSources[k] = v;
                }
              }
            }
            if (categoryParam && nextSources[categoryParam]) {
              nextSources[categoryParam] = {
                ...nextSources[categoryParam],
                nextPageUrl: effectiveNextUrl,
                pageLoaded: (nextSources[categoryParam].pageLoaded || 0) + pagesFetched,
              };
            }
            return {
              ...srv,
              items: mergedItems,
              categories: mergedCats,
              pagesScanned: srv.pagesScanned + pagesFetched,
              nextPageUrl: !categoryParam ? effectiveNextUrl : srv.nextPageUrl,
              categorySources: Object.keys(nextSources).length > 0 ? nextSources : srv.categorySources,
            };
          })
        );

        if (addedCount > 0 || previousCount >= 0) {
          setBatchFeedback(
            addedCount > 0
              ? `+${pagesFetched} ${pagesFetched === 1 ? 'página carregada' : 'páginas carregadas'} · +${addedCount} vídeos novos`
              : `Fim das páginas novas (${pagesFetched} ${pagesFetched === 1 ? 'página verificada' : 'páginas verificadas'})`
          );
        }
      } catch (err) {
        setBrowseError(
          err instanceof Error ? err.message : 'Erro ao buscar próximo lote de páginas.'
        );
      } finally {
        setBrowsingMore(false);
      }
    },
    [activeServer, browsingMore, selectedCategory]
  );

  const refreshLatestVideos = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!activeServer || refreshingLatest || scanStatus.scanning) return;
      setRefreshingLatest(true);
      if (!opts?.silent) setBrowseError(null);

      const targetServerId = activeServer.id;
      const hadPreviousUpdate = Boolean(activeServer.lastUpdatedAt);

      try {
        const qs = new URLSearchParams({ serverUrl: activeServer.url });
        if (activeServer.latestUrl) qs.set('latestUrl', activeServer.latestUrl);

        const { ok, data } = await fetchJson<{
          items?: MediaItem[];
          latestUrl?: string;
          nextPageUrl?: string;
          checkedAt?: number;
          error?: string;
        }>(`/api/latest?${qs.toString()}`);

        if (!ok) {
          throw new Error(data.error || 'Falha ao buscar novidades do site.');
        }

        const latestItems = Array.isArray(data.items)
          ? data.items.map((item) => ({
              ...item,
              category: RECENT_CATEGORY,
              folderPath: '/' + RECENT_CATEGORY,
            }))
          : [];

        let newlyAddedCount = 0;

        setSavedServers((prev) =>
          prev.map((srv) => {
            if (srv.id !== targetServerId) return srv;

            const existingCanonSet = new Set(srv.items.map((i) => canonicalizeMediaUrl(i.url)));
            const existingTitleSet = new Set(
              srv.items.map((i) => normalizeMediaTitle(i.title || ''))
            );

            const brandNewItems = latestItems.filter((item) => {
              const canon = canonicalizeMediaUrl(item.url);
              const t = normalizeMediaTitle(item.title || '');
              return !existingCanonSet.has(canon) && (!t || !existingTitleSet.has(t));
            });
            newlyAddedCount = brandNewItems.length;

            // Keep recently added feed at the front so newest uploads appear first
            const mergedItems = deduplicateMediaItems([...latestItems, ...srv.items]);
            const mergedCats = Array.from(new Set(mergedItems.map((i) => i.category))).sort((a, b) => {
              if (a === RECENT_CATEGORY) return -1;
              if (b === RECENT_CATEGORY) return 1;
              return a.localeCompare(b, 'pt-BR');
            });

            const nextSources: Record<string, CategorySource> = {
              ...(srv.categorySources || {}),
            };
            if (data.latestUrl) {
              nextSources[RECENT_CATEGORY] = {
                name: RECENT_CATEGORY,
                url: data.latestUrl,
                nextPageUrl: data.nextPageUrl,
                pageLoaded: Math.max(1, nextSources[RECENT_CATEGORY]?.pageLoaded || 0),
              };
            }

            return {
              ...srv,
              items: mergedItems,
              categories: mergedCats,
              latestUrl: data.latestUrl || srv.latestUrl,
              lastUpdatedAt: data.checkedAt || Date.now(),
              categorySources: Object.keys(nextSources).length > 0 ? nextSources : srv.categorySources,
            };
          })
        );

        if (newlyAddedCount > 0 && hadPreviousUpdate) {
          setNewUpdatesNotice({ count: newlyAddedCount, serverId: targetServerId });
        }
      } catch (err) {
        if (!opts?.silent) {
          setBrowseError(
            err instanceof Error ? err.message : 'Não foi possível verificar novidades do site.'
          );
        }
      } finally {
        setRefreshingLatest(false);
      }
    },
    [activeServer, refreshingLatest, scanStatus.scanning]
  );

  // Auto-sync recently added videos when opening a server, returning to the app, or every 3 minutes
  useEffect(() => {
    if (!activeServer || playerState || scanStatus.scanning) return;

    const staleMs = 120_000;
    const lastSync = activeServer.lastUpdatedAt || 0;
    if (Date.now() - lastSync > staleMs) {
      const t = window.setTimeout(() => {
        void refreshLatestVideos({ silent: true });
      }, 600);
      return () => window.clearTimeout(t);
    }
  }, [activeServer?.id, activeServer?.lastUpdatedAt, playerState, scanStatus.scanning, refreshLatestVideos]);

  useEffect(() => {
    if (!activeServer || playerState || scanStatus.scanning) return;
    const intervalId = window.setInterval(() => {
      void refreshLatestVideos({ silent: true });
    }, 180_000);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - (activeServer.lastUpdatedAt || 0);
        if (elapsed > 90_000) {
          void refreshLatestVideos({ silent: true });
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeServer, playerState, scanStatus.scanning, refreshLatestVideos]);

  useEffect(() => {
    if (!newUpdatesNotice) return;
    const t = window.setTimeout(() => setNewUpdatesNotice(null), 12000);
    return () => window.clearTimeout(t);
  }, [newUpdatesNotice]);

  const handleSelectCategory = useCallback(
    (cat: string) => {
      setSelectedCategory(cat);
      setBrowseError(null);
      setBatchFeedback(null);
      if (
        cat !== 'Tudo' &&
        activeServer &&
        (categoryCounts.get(cat) || 0) === 0 &&
        activeServer.categorySources?.[cat]
      ) {
        void loadMoreFromServer(cat, 4);
      }
    },
    [activeServer, categoryCounts, loadMoreFromServer]
  );

  const runRemoteSearch = useCallback(
    async (explicitQuery?: string, startPage = 1, batchPages = 3) => {
      const term = (explicitQuery ?? searchQuery).trim();
      if (!term || !activeServer || remoteSearching) return;
      if (explicitQuery !== undefined) {
        setSearchQuery(term);
      }
      setShowSearchKeyboard(false);
      if (startPage === 1) {
        setRecentSearches((prev) =>
          [term, ...prev.filter((t) => t.toLowerCase() !== term.toLowerCase())].slice(0, 8)
        );
      }
      setRemoteSearching(true);
      if (startPage === 1) {
        setRemoteSearchResults({
          query: term,
          serverId: activeServer.id,
          items: [],
          page: 1,
          nextPage: 4,
          pagesFetched: 0,
          hasMore: false,
          error: null,
        });
      }

      try {
        const safePages = Math.min(Math.max(batchPages, 1), 5);
        const { ok, data } = await fetchJson<{
          items?: MediaItem[];
          page?: number;
          nextPage?: number;
          pagesFetched?: number;
          hasMore?: boolean;
          error?: string;
        }>(
          `/api/search?serverUrl=${encodeURIComponent(activeServer.url)}&query=${encodeURIComponent(term)}&page=${startPage}&pages=${safePages}`
        );
        if (!ok) {
          throw new Error(data.error || 'Falha ao buscar no servidor.');
        }
        const items: MediaItem[] = Array.isArray(data.items) ? data.items : [];
        const loadedPage = data.page || startPage;
        const nextPage = data.nextPage || loadedPage + 1;
        const batchCount = data.pagesFetched || 1;
        setRemoteSearchResults((prev) => {
          const sameSearch =
            startPage > 1 &&
            prev &&
            prev.query.toLowerCase() === term.toLowerCase() &&
            prev.serverId === activeServer.id;
          const prevItems = sameSearch ? prev.items : [];
          const prevPagesFetched = sameSearch ? prev.pagesFetched : 0;
          return {
            query: term,
            serverId: activeServer.id,
            items: deduplicateMediaItems([...prevItems, ...items], { acrossCategories: true }),
            page: loadedPage,
            nextPage,
            pagesFetched: prevPagesFetched + batchCount,
            hasMore: Boolean(data.hasMore) && items.length > 0,
            error: null,
          };
        });
      } catch (err) {
        setRemoteSearchResults((prev) => ({
          query: term,
          serverId: activeServer.id,
          items: startPage > 1 && prev ? prev.items : [],
          page: startPage,
          nextPage: startPage + 1,
          pagesFetched: prev?.pagesFetched || 0,
          hasMore: false,
          error: err instanceof Error ? err.message : 'Erro ao pesquisar conteúdo no servidor.',
        }));
      } finally {
        setRemoteSearching(false);
      }
    },
    [searchQuery, activeServer, remoteSearching]
  );

  // Automatic infinite scroll for Home (All / Category) & Search sentinels
  useEffect(() => {
    if (!autoInfiniteScroll || playerState || scanStatus.scanning) return;

    const targetEl =
      activeTab === 'home'
        ? browseSentinelRef.current
        : activeTab === 'search'
        ? searchSentinelRef.current
        : null;

    if (!targetEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        const now = Date.now();
        if (now - lastAutoTriggerRef.current < 1500) return;

        if (activeTab === 'home' && activeServer && !browsingMore && !browseError) {
          const canLoadMoreHome =
            selectedCategory === 'Tudo'
              ? Boolean(activeServer.nextPageUrl)
              : activeServer.categorySources?.[selectedCategory]?.pageLoaded === 0 ||
                Boolean(activeServer.categorySources?.[selectedCategory]?.nextPageUrl);

          if (canLoadMoreHome) {
            lastAutoTriggerRef.current = now;
            void loadMoreFromServer(selectedCategory, 4);
          }
        } else if (
          activeTab === 'search' &&
          activeServer &&
          !remoteSearching &&
          !remoteSearchResults?.error &&
          remoteSearchResults?.hasMore &&
          remoteSearchResults.query.toLowerCase() === searchQuery.trim().toLowerCase()
        ) {
          lastAutoTriggerRef.current = now;
          void runRemoteSearch(searchQuery.trim(), remoteSearchResults.nextPage, 3);
        }
      },
      { rootMargin: '260px', threshold: 0.05 }
    );

    observer.observe(targetEl);
    return () => observer.disconnect();
  }, [
    autoInfiniteScroll,
    playerState,
    scanStatus.scanning,
    activeTab,
    activeServer,
    selectedCategory,
    browsingMore,
    browseError,
    loadMoreFromServer,
    remoteSearching,
    remoteSearchResults,
    searchQuery,
    runRemoteSearch,
  ]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const pool =
      searchScope === 'all'
        ? savedServers.flatMap((s) => s.items)
        : activeServer
        ? activeServer.items
        : [];

    const localMatches = q
      ? pool.filter(
          (item) =>
            item.title.toLowerCase().includes(q) ||
            item.category.toLowerCase().includes(q) ||
            item.folderPath.toLowerCase().includes(q) ||
            (item.description && item.description.toLowerCase().includes(q))
        )
      : pool.slice(0, 24);

    // Combine remote server search results when available for the current query
    const remoteItems =
      remoteSearchResults &&
      remoteSearchResults.serverId === activeServer?.id &&
      remoteSearchResults.query.toLowerCase() === q
        ? remoteSearchResults.items
        : [];

    let combined = deduplicateMediaItems([...remoteItems, ...localMatches], {
      acrossCategories: true,
    });
    if (searchQualityFilter === 'hd') {
      combined = combined.filter(
        (item) =>
          item.quality && /(4K|2160|1440|1080|720|HD)/i.test(item.quality)
      );
    }
    return combined;
  }, [
    activeServer,
    savedServers,
    searchQuery,
    searchScope,
    searchQualityFilter,
    remoteSearchResults,
  ]);

  const navItems: Array<{ id: NavTab; label: string; icon: typeof Home; disabled?: boolean }> = [
    { id: 'home', label: 'Início', icon: Home, disabled: !activeServer },
    { id: 'search', label: 'Pesquisar', icon: Search, disabled: savedServers.length === 0 },
    { id: 'folders', label: 'Pastas', icon: FolderTree, disabled: !activeServer },
    { id: 'servers', label: 'Servidores', icon: Server },
    { id: 'favorites', label: 'Favoritos', icon: Star },
  ];

  return (
    <div className="min-h-screen bg-[#090A0F] text-slate-100 flex flex-col md:flex-row">
      {/* Left 10-Foot TV Navigation Rail */}
      <aside className="w-full md:w-[228px] shrink-0 bg-[#0D0F16] border-b md:border-b-0 md:border-r border-white/8 flex md:flex-col justify-between p-4 md:py-6 md:px-4 z-20">
        <div>
          <div className="flex items-center gap-3 px-2 mb-0 md:mb-8">
            <div className="w-9 h-9 rounded-xl bg-sky-500 text-slate-950 flex items-center justify-center shrink-0">
              <Tv className="w-5 h-5" />
            </div>
            <span className="font-display text-xl font-bold tracking-tight text-white whitespace-nowrap">
              TelaBox
            </span>
          </div>

          <nav className="hidden md:flex flex-col gap-1.5">
            {navItems.map((nav) => {
              const Icon = nav.icon;
              const isActive = activeTab === nav.id;
              return (
                <button
                  key={nav.id}
                  type="button"
                  data-tv-focusable="true"
                  disabled={nav.disabled}
                  onClick={() => setActiveTab(nav.id)}
                  className={`w-full h-12 px-3.5 rounded-xl flex items-center gap-3.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-35 ${
                    isActive
                      ? 'bg-white text-[#090A0F] font-semibold'
                      : 'text-slate-300 hover:bg-white/8 hover:text-white'
                  }`}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  <span>{nav.label}</span>
                  {nav.id === 'favorites' && favorites.length > 0 && (
                    <span
                      className={`ml-auto text-xs font-mono tabular-nums ${
                        isActive ? 'text-slate-700' : 'text-slate-400'
                      }`}
                    >
                      {favorites.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Mobile / Compact Nav Row */}
        <nav className="flex md:hidden items-center gap-1.5 overflow-x-auto no-scrollbar">
          {navItems.map((nav) => {
            const Icon = nav.icon;
            const isActive = activeTab === nav.id;
            return (
              <button
                key={nav.id}
                type="button"
                data-tv-focusable="true"
                disabled={nav.disabled}
                onClick={() => setActiveTab(nav.id)}
                className={`h-10 px-3 rounded-xl flex items-center gap-2 text-xs font-medium whitespace-nowrap shrink-0 disabled:opacity-35 ${
                  isActive ? 'bg-white text-[#090A0F] font-semibold' : 'bg-white/6 text-slate-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                {nav.label}
              </button>
            );
          })}
        </nav>

        <div className="hidden md:block pt-4 border-t border-white/8">
          <button
            type="button"
            data-tv-focusable="true"
            onClick={() => setShowVirtualRemote((r) => !r)}
            className={`w-full h-11 px-3.5 rounded-xl flex items-center gap-3 text-xs font-medium whitespace-nowrap shrink-0 border ${
              showVirtualRemote
                ? 'bg-sky-500/15 border-sky-400/50 text-sky-300'
                : 'bg-[#12151E] border-white/8 text-slate-300 hover:text-white'
            }`}
          >
            <Gamepad2 className="w-4 h-4 shrink-0" />
            Controle Virtual
          </button>
        </div>
      </aside>

      {/* Main TV Stage */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Minimal 10-Foot Top Strip */}
        <header className="px-6 lg:px-10 py-4 border-b border-white/8 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            {activeServer ? (
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-display font-semibold text-base text-white truncate">
                  {activeServer.name}
                </span>
                <span className="hidden sm:inline text-xs font-mono text-slate-400 truncate tabular-nums">
                  · {activeServer.items.length} conteúdos · {activeServer.categories.length} categorias
                </span>
              </div>
            ) : (
              <span className="text-sm text-slate-400">
                Nenhum servidor conectado
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 shrink-0">
            {activeServer && (
              <button
                type="button"
                data-tv-focusable="true"
                disabled={refreshingLatest || scanStatus.scanning}
                onClick={() => void refreshLatestVideos({ silent: false })}
                className="h-10 px-4 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/35 text-xs font-medium text-sky-200 flex items-center gap-2 whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${refreshingLatest ? 'animate-spin' : ''}`} />
                {refreshingLatest ? 'Atualizando...' : 'Atualizar Novidades'}
              </button>
            )}
            {savedServers.length > 0 && (
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setActiveTab('search')}
                className="h-10 px-4 rounded-xl bg-white/8 hover:bg-white/15 text-xs font-medium text-white flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <Search className="w-4 h-4" />
                Pesquisar
              </button>
            )}
            <PWAInstallButton />
            <button
              type="button"
              data-tv-focusable="true"
              onClick={() => {
                if (pinCode) {
                  setShowPinQuickMenu(true);
                } else {
                  setPinModalMode('setup');
                }
              }}
              className={`h-10 px-4 rounded-xl border text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
                pinCode
                  ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-400/35 text-emerald-200'
                  : 'bg-white/8 hover:bg-white/15 border-white/10 text-white'
              }`}
              title={
                pinCode
                  ? 'PIN de 4 dígitos ativo — alterar, desativar ou bloquear'
                  : 'Ativar bloqueio por PIN de 4 dígitos'
              }
            >
              <Lock className={`w-4 h-4 ${pinCode ? 'text-emerald-300' : 'text-sky-400'}`} />
              <span>Bloqueio PIN</span>
            </button>
            <button
              type="button"
              data-tv-focusable="true"
              onClick={() => setActiveTab('servers')}
              className="h-10 px-4 rounded-xl bg-white/8 hover:bg-white/15 text-xs font-medium text-white flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              Adicionar Servidor
            </button>
            <span className="font-mono text-sm tabular-nums text-slate-300 hidden sm:inline">
              {clockText}
            </span>
          </div>
        </header>

        <OfflineIndicator />

        {/* Scrollable Content Viewport */}
        <main className="flex-1 px-6 lg:px-10 py-7 pb-16 max-w-[1440px] w-full mx-auto">
          {newUpdatesNotice && activeServer && newUpdatesNotice.serverId === activeServer.id && (
            <div className="mb-6 px-5 py-3.5 rounded-xl bg-sky-500/15 border border-sky-400/40 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium text-sky-100">
                +{newUpdatesNotice.count}{' '}
                {newUpdatesNotice.count === 1
                  ? 'novo vídeo adicionado recentemente no site'
                  : 'novos vídeos adicionados recentemente no site'}
                .
              </p>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  setActiveTab('home');
                  setSelectedCategory(RECENT_CATEGORY);
                  setNewUpdatesNotice(null);
                }}
                className="h-9 px-4 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-xs whitespace-nowrap shrink-0"
              >
                Ver Recentes
              </button>
            </div>
          )}
          {/* HOME / CATALOG TAB */}
          {activeTab === 'home' && activeServer && (
            <div className="space-y-8">
              {/* Dominant Featured Hero Showcase */}
              {featuredItem && (
                <section className="relative rounded-2xl overflow-hidden border border-white/10 min-h-[300px] lg:min-h-[340px] flex items-end">
                  <div className="absolute inset-0">
                    <img
                      src={tvCinemaBackdrop}
                      alt="Tela de destaque do servidor"
                      className="w-full h-full object-cover opacity-55"
                    />
                    {featuredItem.thumbnail && (
                      <div className="absolute inset-0 opacity-65">
                        <MediaPoster
                          src={featuredItem.thumbnail}
                          alt={featuredItem.title}
                          category={featuredItem.category}
                        />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-r from-[#090A0F] via-[#090A0F]/85 to-[#090A0F]/25" />
                    <div className="absolute inset-0 bg-gradient-to-t from-[#090A0F] via-transparent to-transparent" />
                  </div>

                  <div className="relative z-10 p-7 lg:p-10 max-w-2xl">
                    <p className="text-xs font-mono text-sky-400 mb-2">
                      {continueWatchingItems.length > 0 ? 'Continuar assistindo' : 'Em destaque no servidor'} ·{' '}
                      {featuredItem.category}
                    </p>
                    <h1 className="font-display text-3xl lg:text-4xl font-bold text-white tracking-tight text-balance">
                      {featuredItem.title}
                    </h1>
                    {featuredItem.description && (
                      <p className="mt-2.5 text-sm sm:text-base text-slate-300 line-clamp-2 leading-relaxed">
                        {featuredItem.description}
                      </p>
                    )}
                    <p className="mt-2 text-xs font-mono tabular-nums text-slate-400">
                      {[featuredItem.format, featuredItem.quality, featuredItem.size]
                        .filter(Boolean)
                        .join(' · ') || activeServer.name}
                    </p>

                    <div className="mt-6 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => openPlayer(featuredItem, activeServer.items)}
                        className="h-12 px-7 rounded-xl bg-white text-[#090A0F] hover:bg-slate-200 font-display font-bold text-sm flex items-center gap-2.5 whitespace-nowrap shrink-0"
                      >
                        <Play className="w-4 h-4 fill-current" />
                        Reproduzir Agora
                      </button>

                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => toggleFavorite(featuredItem)}
                        className="h-12 px-5 rounded-xl bg-white/12 hover:bg-white/20 text-white font-medium text-sm flex items-center gap-2 whitespace-nowrap shrink-0"
                      >
                        <Star
                          className={`w-4 h-4 ${
                            favoriteIds.has(featuredItem.id) ? 'fill-amber-400 text-amber-400' : ''
                          }`}
                        />
                        {favoriteIds.has(featuredItem.id) ? 'Salvo nos Favoritos' : 'Favoritar'}
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {/* Category Filter Strip (loaded categories + all site categories) */}
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => handleSelectCategory('Tudo')}
                  className={`h-10 px-4 rounded-xl text-sm font-medium whitespace-nowrap shrink-0 border transition-colors ${
                    selectedCategory === 'Tudo'
                      ? 'bg-sky-500 border-sky-400 text-slate-950 font-semibold'
                      : 'bg-[#12151E] border-white/8 text-slate-300 hover:text-white'
                  }`}
                >
                  Tudo ({activeServer.items.length})
                </button>
                {allCategoryNames.map((cat) => {
                  const count = categoryCounts.get(cat) || 0;
                  return (
                    <button
                      key={cat}
                      type="button"
                      data-tv-focusable="true"
                      onClick={() => handleSelectCategory(cat)}
                      className={`h-10 px-4 rounded-xl text-sm font-medium whitespace-nowrap shrink-0 border transition-colors ${
                        selectedCategory === cat
                          ? 'bg-sky-500 border-sky-400 text-slate-950 font-semibold'
                          : 'bg-[#12151E] border-white/8 text-slate-300 hover:text-white'
                      }`}
                    >
                      {count > 0 ? `${cat} (${count})` : cat}
                    </button>
                  );
                })}
              </div>

              {browseError && (
                <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/40 text-sm text-rose-200">
                  {browseError}
                </div>
              )}

              {/* Continue Watching Shelf */}
              {selectedCategory === 'Tudo' && continueWatchingItems.length > 0 && (
                <section>
                  <h2 className="font-display text-lg font-semibold text-white mb-4">
                    Continuar Assistindo
                  </h2>
                  <div className="flex items-stretch gap-4 overflow-x-auto no-scrollbar pb-2">
                    {continueWatchingItems.slice(0, 20).map((item) => (
                      <MediaCard
                        key={item.id}
                        item={item}
                        compact
                        isFavorite={favoriteIds.has(item.id)}
                        progress={progressMap[item.id]}
                        onPlay={(chosen) => openPlayer(chosen, continueWatchingItems)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Organized Shelves (All) or Paginated Category Grid */}
              {selectedCategory === 'Tudo' ? (
                <div className="space-y-8">
                  {groupedByCategory.map((group) => (
                    <section key={group.category}>
                      <div className="flex items-center justify-between mb-4">
                        <h2 className="font-display text-lg font-semibold text-white">
                          {group.category}
                        </h2>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => handleSelectCategory(group.category)}
                          className="text-xs font-medium text-sky-400 hover:text-sky-300 px-3 py-1.5 rounded-lg whitespace-nowrap shrink-0"
                        >
                          Ver todos ({group.items.length})
                        </button>
                      </div>
                      <div className="flex items-stretch gap-4 overflow-x-auto no-scrollbar pb-2">
                        {group.items.slice(0, 20).map((item) => (
                          <MediaCard
                            key={item.id}
                            item={item}
                            compact
                            isFavorite={favoriteIds.has(item.id)}
                            progress={progressMap[item.id]}
                            onPlay={(chosen) => openPlayer(chosen, group.items)}
                          />
                        ))}
                      </div>
                    </section>
                  ))}

                  {activeServer.nextPageUrl && (
                    <div className="pt-4 flex flex-col items-center gap-3">
                      {batchFeedback && (
                        <p className="text-xs font-mono text-sky-300/90 tabular-nums">
                          {batchFeedback} · {activeServer.pagesScanned} páginas carregadas no total
                        </p>
                      )}
                      <div className="flex flex-wrap items-center justify-center gap-3">
                        <button
                          type="button"
                          data-tv-focusable="true"
                          disabled={browsingMore}
                          onClick={() => loadMoreFromServer('Tudo', 4)}
                          className="h-12 px-7 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-display font-bold text-sm flex items-center gap-2.5 whitespace-nowrap"
                        >
                          {browsingMore ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Globe className="w-4 h-4" />
                          )}
                          {browsingMore
                            ? 'Buscando lote de páginas...'
                            : 'Carregar mais páginas (+4)'}
                        </button>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => setAutoInfiniteScroll((v) => !v)}
                          className={`h-12 px-4 rounded-xl border text-xs font-medium whitespace-nowrap transition-colors ${
                            autoInfiniteScroll
                              ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300'
                              : 'bg-[#12151E] border-white/10 text-slate-300 hover:text-white'
                          }`}
                        >
                          Rolagem Infinita: {autoInfiniteScroll ? 'Ativa' : 'Manual'}
                        </button>
                      </div>
                      <div ref={browseSentinelRef} className="h-4 w-full" aria-hidden="true" />
                    </div>
                  )}
                </div>
              ) : (
                <section className="space-y-6">
                  {filteredCategoryItems.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                      {filteredCategoryItems.map((item) => (
                        <MediaCard
                          key={item.id}
                          item={item}
                          isFavorite={favoriteIds.has(item.id)}
                          progress={progressMap[item.id]}
                          onPlay={(chosen) => openPlayer(chosen, filteredCategoryItems)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="p-10 rounded-2xl bg-[#12151E] border border-white/8 text-center">
                      {browsingMore ? (
                        <div className="flex flex-col items-center gap-3">
                          <Loader2 className="w-8 h-8 text-sky-400 animate-spin" />
                          <p className="text-base text-slate-200">
                            Carregando lote de páginas de "{selectedCategory}" direto do site...
                          </p>
                        </div>
                      ) : (
                        <p className="text-base text-slate-300">
                          Nenhum vídeo carregado ainda para "{selectedCategory}".
                        </p>
                      )}
                    </div>
                  )}

                  {(activeServer.categorySources?.[selectedCategory]?.pageLoaded === 0 ||
                    Boolean(activeServer.categorySources?.[selectedCategory]?.nextPageUrl)) && (
                    <div className="pt-2 flex flex-col items-center gap-3">
                      {batchFeedback && (
                        <p className="text-xs font-mono text-sky-300/90 tabular-nums">
                          {batchFeedback}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center justify-center gap-3">
                        <button
                          type="button"
                          data-tv-focusable="true"
                          disabled={browsingMore}
                          onClick={() => loadMoreFromServer(selectedCategory, 4)}
                          className="h-12 px-7 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-display font-bold text-sm flex items-center gap-2.5 whitespace-nowrap"
                        >
                          {browsingMore ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Plus className="w-4 h-4" />
                          )}
                          {browsingMore
                            ? `Buscando páginas de ${selectedCategory}...`
                            : `Carregar mais páginas (+4) · pág. ${(activeServer.categorySources?.[selectedCategory]?.pageLoaded || 0) + 1}–${(activeServer.categorySources?.[selectedCategory]?.pageLoaded || 0) + 4}`}
                        </button>
                        <button
                          type="button"
                          data-tv-focusable="true"
                          onClick={() => setAutoInfiniteScroll((v) => !v)}
                          className={`h-12 px-4 rounded-xl border text-xs font-medium whitespace-nowrap transition-colors ${
                            autoInfiniteScroll
                              ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300'
                              : 'bg-[#12151E] border-white/10 text-slate-300 hover:text-white'
                          }`}
                        >
                          Rolagem Infinita: {autoInfiniteScroll ? 'Ativa' : 'Manual'}
                        </button>
                      </div>
                      <div ref={browseSentinelRef} className="h-4 w-full" aria-hidden="true" />
                    </div>
                  )}
                </section>
              )}
            </div>
          )}

          {/* SERVERS TAB */}
          {activeTab === 'servers' && (
            <ServerConnectPanel
              savedServers={savedServers}
              favorites={favorites}
              activeServerId={activeServer?.id || null}
              scanStatus={scanStatus}
              pinEnabled={Boolean(pinCode)}
              onConfigurePin={(mode) => setPinModalMode(mode)}
              onLockNow={() => {
                setPlayerState(null);
                setIsAppUnlocked(false);
              }}
              onImportBackup={handleImportBackup}
              onStartScan={startServerScan}
              onStopScan={stopServerScan}
              onSelectServer={(id) => {
                setActiveServerId(id);
                setSelectedCategory('Tudo');
                setActiveTab('home');
              }}
              onRescanServer={(srv) =>
                startServerScan({
                  url: srv.url,
                  customName: srv.name,
                  mode: srv.scanMode,
                  useProxy: srv.useProxy,
                })
              }
              onDeleteServer={deleteServer}
            />
          )}

          {/* FOLDERS TAB */}
          {activeTab === 'folders' && activeServer && (
            <FolderExplorerView
              server={activeServer}
              favoriteIds={favoriteIds}
              progressMap={progressMap}
              onPlay={openPlayer}
            />
          )}

          {/* SEARCH TAB */}
          {activeTab === 'search' && (activeServer || savedServers.length > 0) && (
            <div className="space-y-6">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">
                  Pesquisar Conteúdo Específico
                </h1>
                <p className="mt-1 text-sm text-slate-400">
                  Filtre os vídeos já carregados ou faça uma busca direta no servidor conectado pelo título, categoria ou assunto.
                </p>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  runRemoteSearch();
                }}
                className="flex flex-col lg:flex-row gap-3"
              >
                <div className="relative flex-1">
                  <Search className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    data-tv-focusable="true"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={
                      activeServer
                        ? `Digite o conteúdo para buscar em ${activeServer.name}...`
                        : 'Digite o nome do vídeo ou categoria...'
                    }
                    className="w-full h-13 pl-12 pr-11 rounded-xl bg-[#12151E] border border-white/15 text-base text-white placeholder:text-slate-500"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      data-tv-focusable="true"
                      onClick={() => {
                        setSearchQuery('');
                        setRemoteSearchResults(null);
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg bg-white/8 hover:bg-white/15 flex items-center justify-center text-slate-300"
                      aria-label="Limpar pesquisa"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => setShowSearchKeyboard((k) => !k)}
                  className="h-13 px-5 rounded-xl bg-[#12151E] hover:bg-[#1A1F2E] border border-white/10 text-sm font-medium text-slate-200 flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                >
                  <Keyboard className="w-4 h-4" />
                  Teclado TV
                </button>

                {activeServer && (
                  <button
                    type="submit"
                    data-tv-focusable="true"
                    disabled={!searchQuery.trim() || remoteSearching}
                    className="h-13 px-6 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-45 text-slate-950 font-display font-bold text-sm flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                  >
                    {remoteSearching ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Globe className="w-4 h-4" />
                    )}
                    {remoteSearching ? 'Buscando no Site...' : 'Buscar no Servidor'}
                  </button>
                )}
              </form>

              {/* Scope & Quality Filters */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 p-1 rounded-lg bg-[#12151E] border border-white/10">
                    <button
                      type="button"
                      data-tv-focusable="true"
                      onClick={() => setSearchScope('active')}
                      className={`px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                        searchScope === 'active'
                          ? 'bg-white text-[#090A0F] font-semibold'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      Servidor Atual
                    </button>
                    {savedServers.length > 1 && (
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => setSearchScope('all')}
                        className={`px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                          searchScope === 'all'
                            ? 'bg-white text-[#090A0F] font-semibold'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        Todos os Servidores ({savedServers.length})
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1 p-1 rounded-lg bg-[#12151E] border border-white/10">
                    <button
                      type="button"
                      data-tv-focusable="true"
                      onClick={() => setSearchQualityFilter('all')}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                        searchQualityFilter === 'all'
                          ? 'bg-sky-500 text-slate-950 font-semibold'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      Qualquer Qualidade
                    </button>
                    <button
                      type="button"
                      data-tv-focusable="true"
                      onClick={() => setSearchQualityFilter('hd')}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                        searchQualityFilter === 'hd'
                          ? 'bg-sky-500 text-slate-950 font-semibold'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      Somente HD / 4K
                    </button>
                  </div>
                </div>

                {recentSearches.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-500">Recentes:</span>
                    {recentSearches.slice(0, 5).map((term) => (
                      <button
                        key={term}
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => runRemoteSearch(term)}
                        className="px-3 py-1.5 rounded-lg bg-[#12151E] hover:bg-[#1B2030] border border-white/10 text-xs text-slate-200 whitespace-nowrap shrink-0"
                      >
                        {term}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {showSearchKeyboard && (
                <OnScreenKeyboard
                  value={searchQuery}
                  onChange={setSearchQuery}
                  onSubmit={() => runRemoteSearch()}
                  onClose={() => setShowSearchKeyboard(false)}
                />
              )}

              {remoteSearchResults?.error && (
                <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/40 text-sm text-rose-200">
                  {remoteSearchResults.error}
                </div>
              )}

              <div>
                <p className="text-sm text-slate-400 mb-4 font-mono tabular-nums">
                  {searchResults.length}{' '}
                  {searchResults.length === 1 ? 'resultado encontrado' : 'resultados encontrados'}
                  {remoteSearchResults &&
                  remoteSearchResults.query.toLowerCase() === searchQuery.trim().toLowerCase() &&
                  remoteSearchResults.items.length > 0
                    ? ` (${remoteSearchResults.items.length} direto do servidor)`
                    : ''}
                </p>

                {searchResults.length > 0 ? (
                  <div className="space-y-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                      {searchResults.map((item) => (
                        <MediaCard
                          key={item.id}
                          item={item}
                          isFavorite={favoriteIds.has(item.id)}
                          progress={progressMap[item.id]}
                          onPlay={(chosen) => openPlayer(chosen, searchResults)}
                        />
                      ))}
                    </div>

                    {activeServer &&
                      remoteSearchResults &&
                      remoteSearchResults.query.toLowerCase() === searchQuery.trim().toLowerCase() &&
                      remoteSearchResults.hasMore && (
                        <div className="pt-2 flex flex-col items-center gap-3">
                          <div className="flex flex-wrap items-center justify-center gap-3">
                            <button
                              type="button"
                              data-tv-focusable="true"
                              disabled={remoteSearching}
                              onClick={() =>
                                runRemoteSearch(searchQuery.trim(), remoteSearchResults.nextPage, 3)
                              }
                              className="h-12 px-7 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-display font-bold text-sm flex items-center gap-2.5 whitespace-nowrap"
                            >
                              {remoteSearching ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Plus className="w-4 h-4" />
                              )}
                              {remoteSearching
                                ? 'Buscando mais páginas...'
                                : `Carregar mais páginas (+3) · pág. ${remoteSearchResults.nextPage}–${remoteSearchResults.nextPage + 2}`}
                            </button>
                            <button
                              type="button"
                              data-tv-focusable="true"
                              onClick={() => setAutoInfiniteScroll((v) => !v)}
                              className={`h-12 px-4 rounded-xl border text-xs font-medium whitespace-nowrap transition-colors ${
                                autoInfiniteScroll
                                  ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300'
                                  : 'bg-[#12151E] border-white/10 text-slate-300 hover:text-white'
                              }`}
                            >
                              Rolagem Infinita: {autoInfiniteScroll ? 'Ativa' : 'Manual'}
                            </button>
                          </div>
                          <div ref={searchSentinelRef} className="h-4 w-full" aria-hidden="true" />
                        </div>
                      )}
                  </div>
                ) : (
                  <div className="p-10 rounded-2xl bg-[#12151E] border border-white/8 text-center">
                    <p className="text-base text-slate-300">
                      Nenhum vídeo encontrado no catálogo local para "{searchQuery}".
                    </p>
                    {activeServer && searchQuery.trim() && (
                      <button
                        type="button"
                        data-tv-focusable="true"
                        onClick={() => runRemoteSearch()}
                        className="mt-4 h-11 px-6 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm inline-flex items-center gap-2 whitespace-nowrap"
                      >
                        <Globe className="w-4 h-4" />
                        Buscar "{searchQuery.trim()}" direto no servidor
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* FAVORITES TAB */}
          {activeTab === 'favorites' && (
            <div className="space-y-6">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">
                  Favoritos Salvos
                </h1>
                <p className="text-sm text-slate-400 mt-1 font-mono tabular-nums">
                  {favorites.length}{' '}
                  {favorites.length === 1 ? 'vídeo salvo' : 'vídeos salvos'}
                </p>
              </div>

              {favorites.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {favorites.map((item) => (
                    <MediaCard
                      key={item.id}
                      item={item}
                      isFavorite={true}
                      progress={progressMap[item.id]}
                      onPlay={(chosen) => openPlayer(chosen, favorites)}
                    />
                  ))}
                </div>
              ) : (
                <div className="p-10 rounded-2xl bg-[#12151E] border border-white/8 text-center max-w-xl">
                  <Star className="w-9 h-9 text-slate-500 mx-auto mb-3" />
                  <h2 className="font-display text-lg font-semibold text-white">
                    Nenhum favorito ainda
                  </h2>
                  <p className="mt-1.5 text-sm text-slate-400">
                    Ao assistir ou destacar um conteúdo do servidor, selecione Favoritar para acessá-lo rapidamente por aqui.
                  </p>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => setActiveTab(activeServer ? 'home' : 'servers')}
                    className="mt-5 h-11 px-5 rounded-xl bg-white text-[#090A0F] font-semibold text-sm whitespace-nowrap"
                  >
                    {activeServer ? 'Explorar Catálogo' : 'Conectar Servidor'}
                  </button>
                </div>
              )}
            </div>
          )}
        </main>

        {/* Quiet 1-line Remote Keybinding Footer */}
        <footer className="px-6 lg:px-10 py-3 border-t border-white/8 bg-[#0B0D13] flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
          <span>Setas: Navegar · OK / Enter: Selecionar · Voltar / ESC: Retornar</span>
          <button
            type="button"
            onClick={() => setShowVirtualRemote((r) => !r)}
            className="text-sky-400 hover:text-sky-300 font-medium md:hidden"
          >
            {showVirtualRemote ? 'Ocultar Controle Virtual' : 'Abrir Controle Virtual'}
          </button>
        </footer>
      </div>

      {/* Floating Virtual Remote Pad */}
      {showVirtualRemote && (
        <VirtualRemoteModal
          onMove={moveFocus}
          onOk={activateFocused}
          onBack={handleBack}
          onHome={() => {
            setPlayerState(null);
            setActiveTab(activeServer ? 'home' : 'servers');
          }}
          onClose={() => setShowVirtualRemote(false)}
        />
      )}

      {/* Fullscreen TV Video Player */}
      {playerState && (
        <VideoPlayerModal
          item={playerState.item}
          playlist={playerState.playlist}
          initialUseProxy={activeServer?.useProxy ?? true}
          initialTime={progressMap[playerState.item.id]?.currentTime || 0}
          isFavorite={favoriteIds.has(playerState.item.id)}
          onToggleFavorite={toggleFavorite}
          onSelectItem={(next) =>
            setPlayerState((prev) => (prev ? { ...prev, item: next } : null))
          }
          onSaveProgress={saveProgress}
          onClose={() => setPlayerState(null)}
        />
      )}

      {/* Quick PIN Actions Modal (from Header 'Bloqueio PIN' when active) */}
      {showPinQuickMenu && pinCode && (
        <div
          data-tv-scope="modal"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-[#12151E] border border-white/15 p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-400/35 text-emerald-300 flex items-center justify-center shrink-0">
                  <Lock className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display text-lg font-bold text-white">
                    Bloqueio PIN Ativo
                  </h3>
                  <p className="text-xs text-slate-400">
                    Escolha uma opção para sua senha de 4 dígitos.
                  </p>
                </div>
              </div>
              <button
                ref={pinQuickMenuCloseRef}
                type="button"
                data-tv-focusable="true"
                onClick={() => setShowPinQuickMenu(false)}
                className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 text-slate-300 flex items-center justify-center shrink-0"
                aria-label="Fechar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 pt-1">
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  setShowPinQuickMenu(false);
                  setPinModalMode('change');
                }}
                className="w-full h-12 px-4 rounded-xl bg-white text-[#090A0F] hover:bg-slate-200 font-semibold text-sm flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <Shield className="w-4 h-4" />
                Alterar PIN de 4 Dígitos
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  setShowPinQuickMenu(false);
                  setPlayerState(null);
                  setIsAppUnlocked(false);
                }}
                className="w-full h-12 px-4 rounded-xl bg-white/10 hover:bg-white/20 text-white font-medium text-sm flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <Lock className="w-4 h-4 text-sky-400" />
                Bloquear Tela Agora
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => {
                  setShowPinQuickMenu(false);
                  setPinModalMode('disable');
                }}
                className="w-full h-12 px-4 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/35 text-rose-200 font-medium text-sm flex items-center justify-center gap-2 whitespace-nowrap"
              >
                <Unlock className="w-4 h-4" />
                Desativar Bloqueio PIN
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4-Digit PIN Lock / Configuration Overlay */}
      {pinCode && !isAppUnlocked ? (
        <PinLockOverlay
          mode="unlock"
          expectedPin={pinCode}
          onUnlock={() => setIsAppUnlocked(true)}
        />
      ) : pinModalMode ? (
        <PinLockOverlay
          mode={pinModalMode}
          expectedPin={pinCode}
          onSavePin={(newPin) => {
            setPinCode(newPin);
            setIsAppUnlocked(true);
            setPinModalMode(null);
          }}
          onDisablePin={() => {
            setPinCode(null);
            setIsAppUnlocked(true);
            setPinModalMode(null);
          }}
          onCancel={() => setPinModalMode(null)}
        />
      ) : null}
    </div>
  );
}
