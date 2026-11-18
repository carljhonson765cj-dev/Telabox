export type StreamType = 'video' | 'hls' | 'dash' | 'embed' | 'page';

export type ServerKind = 'directory' | 'portal' | 'iptv' | 'feed';

export type ScanMode = 'full' | 'quick';

export interface SubtitleTrack {
  label: string;
  url: string;
  lang?: string;
}

export interface QualityOption {
  label: string;
  url: string;
  streamType: 'video' | 'hls' | 'dash';
}

export interface MediaItem {
  id: string;
  title: string;
  rawTitle: string;
  url: string;
  streamType: StreamType;
  category: string;
  folderPath: string;
  thumbnail?: string;
  duration?: string;
  quality?: string;
  size?: string;
  format?: string;
  description?: string;
  sourcePageUrl: string;
  subtitles?: SubtitleTrack[];
  qualities?: QualityOption[];
}

export interface CategorySource {
  name: string;
  url: string;
  nextPageUrl?: string;
  pageLoaded: number;
}

export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  scannedAt: number;
  serverKind: ServerKind;
  scanMode: ScanMode;
  useProxy: boolean;
  categories: string[];
  items: MediaItem[];
  pagesScanned: number;
  foldersFound: number;
  nextPageUrl?: string;
  latestUrl?: string;
  lastUpdatedAt?: number;
  categorySources?: Record<string, CategorySource>;
}

export interface ScanProgressEvent {
  type: 'progress' | 'item' | 'complete' | 'error';
  pagesScanned?: number;
  maxPages?: number;
  foldersFound?: number;
  itemsFound?: number;
  currentUrl?: string;
  categories?: string[];
  item?: MediaItem;
  profile?: Omit<ServerProfile, 'id' | 'useProxy'>;
  message?: string;
}

export interface WatchProgress {
  itemId: string;
  currentTime: number;
  duration: number;
  updatedAt: number;
}
