import { useState } from 'react';
import {
  FolderSearch,
  Globe,
  Keyboard,
  Play,
  RefreshCw,
  Server,
  Square,
  Trash2,
  Tv,
} from 'lucide-react';
import type { ScanMode, ServerProfile } from '../types/media';
import { OnScreenKeyboard } from './OnScreenKeyboard';
import posterFilmsImg from '../assets/images/tv_poster_films_1794706797471.jpg';
import posterDocsImg from '../assets/images/tv_poster_docs_1794706797194.jpg';

interface ScanStatus {
  scanning: boolean;
  pagesScanned: number;
  maxPages: number;
  foldersFound: number;
  itemsFound: number;
  currentUrl: string;
  categories: string[];
  error: string | null;
}

interface ServerConnectPanelProps {
  savedServers: ServerProfile[];
  activeServerId: string | null;
  scanStatus: ScanStatus;
  onStartScan: (options: {
    url: string;
    customName?: string;
    mode: ScanMode;
    useProxy: boolean;
  }) => void;
  onStopScan: () => void;
  onSelectServer: (id: string) => void;
  onRescanServer: (server: ServerProfile) => void;
  onDeleteServer: (id: string) => void;
}

const QUICK_SERVERS = [
  {
    label: 'Pornhub PT (18+)',
    subtitle: 'Carrega categorias e acervo completo do portal',
    url: 'https://pt.pornhub.com/',
    mode: 'full' as ScanMode,
    image: posterFilmsImg,
  },
  {
    label: 'XVideos (18+)',
    subtitle: 'Acervo completo com categorias e streams HLS/MP4',
    url: 'https://www.xvideos.com/',
    mode: 'full' as ScanMode,
    image: posterDocsImg,
  },
  {
    label: 'xHamster (18+)',
    subtitle: 'Acervo completo com categorias, busca e streams H.264',
    url: 'https://xhamster.com/',
    mode: 'full' as ScanMode,
    image: posterFilmsImg,
  },
  {
    label: 'Portal de Vídeos Demo',
    subtitle: 'Site HTML com categorias, páginas e legendas',
    url: '/demo-server',
    mode: 'full' as ScanMode,
    image: posterFilmsImg,
  },
  {
    label: 'Diretório Aberto Demo',
    subtitle: 'Índice Apache/Nginx com pastas de filmes e HLS',
    url: '/demo-server/diretorio/',
    mode: 'full' as ScanMode,
    image: posterDocsImg,
  },
];

export function ServerConnectPanel({
  savedServers,
  activeServerId,
  scanStatus,
  onStartScan,
  onStopScan,
  onSelectServer,
  onRescanServer,
  onDeleteServer,
}: ServerConnectPanelProps) {
  const [url, setUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const [mode, setMode] = useState<ScanMode>('full');
  const [useProxy, setUseProxy] = useState(true);
  const [showKeyboard, setShowKeyboard] = useState(false);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!url.trim() || scanStatus.scanning) return;
    setShowKeyboard(false);
    onStartScan({
      url: url.trim(),
      customName: customName.trim() || undefined,
      mode,
      useProxy,
    });
  };

  const progressPct =
    scanStatus.maxPages > 0
      ? Math.min(100, Math.round((scanStatus.pagesScanned / scanStatus.maxPages) * 100))
      : 0;

  return (
    <div className="space-y-8">
      {/* Main Server Connection Card */}
      <section className="relative rounded-2xl overflow-hidden bg-[#12151E] border border-white/10">
        <div className="relative p-7 lg:p-9">
          <div className="max-w-3xl">
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight text-balance">
              Conectar Site ou Servidor de Vídeos
            </h1>
            <p className="mt-2 text-sm sm:text-base text-slate-300 leading-relaxed">
              Cole o endereço de um site de vídeos, diretório aberto (Apache/Nginx), feed RSS ou lista IPTV M3U. O sistema percorre as páginas e pastas do servidor e organiza tudo para o controle remoto.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div className="flex flex-col lg:flex-row gap-3">
              <div className="relative flex-1">
                <Globe className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  data-tv-focusable="true"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://exemplo.com/videos/ ou /demo-server"
                  className="w-full h-13 pl-12 pr-4 rounded-xl bg-[#090A0F] border border-white/15 text-base font-mono text-white placeholder:text-slate-500 focus:border-white"
                />
              </div>

              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setShowKeyboard((k) => !k)}
                className="h-13 px-4 rounded-xl bg-[#1A1F2E] hover:bg-[#232A3E] text-slate-200 border border-white/10 flex items-center justify-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                <Keyboard className="w-4 h-4" />
                Teclado TV
              </button>

              {!scanStatus.scanning ? (
                <button
                  type="submit"
                  data-tv-focusable="true"
                  disabled={!url.trim()}
                  className="h-13 px-7 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-45 text-slate-950 font-display font-bold text-base flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                >
                  <FolderSearch className="w-5 h-5" />
                  Carregar Servidor
                </button>
              ) : (
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={onStopScan}
                  className="h-13 px-7 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-base flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                >
                  <Square className="w-4 h-4 fill-current" />
                  Parar e Exibir
                </button>
              )}
            </div>

            {/* Optional Custom Label & Mode Controls */}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <input
                type="text"
                data-tv-focusable="true"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="Nome do servidor (opcional)"
                className="h-10 px-3.5 rounded-lg bg-[#090A0F] border border-white/10 text-sm text-white placeholder:text-slate-500 w-64"
              />

              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#090A0F] border border-white/10">
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => setMode('full')}
                  className={`px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    mode === 'full'
                      ? 'bg-sky-500 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Servidor Completo (Subpastas)
                </button>
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => setMode('quick')}
                  className={`px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    mode === 'quick'
                      ? 'bg-sky-500 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  Página Única
                </button>
              </div>

              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setUseProxy((p) => !p)}
                className={`h-10 px-4 rounded-lg border text-xs font-medium whitespace-nowrap shrink-0 ${
                  useProxy
                    ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300'
                    : 'bg-[#090A0F] border-white/10 text-slate-300'
                }`}
              >
                {useProxy ? 'Reprodução via Proxy: Ativa' : 'Reprodução Direta'}
              </button>
            </div>
          </form>

          {showKeyboard && (
            <OnScreenKeyboard
              value={url}
              onChange={setUrl}
              onSubmit={() => handleSubmit()}
              onClose={() => setShowKeyboard(false)}
            />
          )}

          {/* Real-time Crawl Progress Panel */}
          {scanStatus.scanning && (
            <div className="mt-6 p-5 rounded-xl bg-[#090A0F] border border-sky-400/30">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                <div className="flex items-center gap-3">
                  <RefreshCw className="w-5 h-5 text-sky-400 animate-spin" />
                  <span className="font-display font-semibold text-base text-white">
                    Mapeando servidor e organizando vídeos...
                  </span>
                </div>
                <div className="text-sm font-mono tabular-nums text-slate-300">
                  {scanStatus.pagesScanned} / {scanStatus.maxPages} páginas ·{' '}
                  {scanStatus.foldersFound} pastas ·{' '}
                  <span className="text-sky-400 font-semibold">
                    {scanStatus.itemsFound} vídeos
                  </span>
                </div>
              </div>

              <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-sky-400 transition-all duration-200"
                  style={{ width: `${Math.max(8, progressPct)}%` }}
                />
              </div>

              {scanStatus.currentUrl && (
                <p className="mt-2.5 text-xs font-mono text-slate-400 truncate">
                  Analisando: {scanStatus.currentUrl}
                </p>
              )}
            </div>
          )}

          {scanStatus.error && (
            <div className="mt-5 p-4 rounded-xl bg-rose-500/15 border border-rose-500/40 text-sm text-rose-200">
              {scanStatus.error}
            </div>
          )}
        </div>
      </section>

      {/* Instant Connect Servers */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-lg font-semibold text-white">
            Acesso Rápido e Servidores de Exemplo
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {QUICK_SERVERS.map((demo) => (
            <button
              key={demo.url}
              type="button"
              data-tv-focusable="true"
              disabled={scanStatus.scanning}
              onClick={() => {
                setUrl(demo.url);
                onStartScan({
                  url: demo.url,
                  customName: demo.label,
                  mode: demo.mode,
                  useProxy: true,
                });
              }}
              className="group relative flex items-center gap-4 p-4 rounded-xl bg-[#12151E] border border-white/8 hover:border-white/25 text-left overflow-hidden"
            >
              <div className="w-24 h-16 rounded-lg overflow-hidden bg-[#090A0F] shrink-0">
                <img
                  src={demo.image}
                  alt={demo.label}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display font-semibold text-base text-white truncate">
                  {demo.label}
                </h3>
                <p className="mt-0.5 text-xs text-slate-400 line-clamp-1">
                  {demo.subtitle}
                </p>
                <p className="mt-1 text-xs font-mono text-sky-400 truncate">
                  {demo.url}
                </p>
              </div>
              <div className="w-10 h-10 rounded-xl bg-white/8 group-hover:bg-sky-500 group-focus:bg-sky-500 group-hover:text-slate-950 group-focus:text-slate-950 flex items-center justify-center text-white shrink-0 transition-colors">
                <Play className="w-4 h-4 fill-current ml-0.5" />
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Saved Servers List */}
      {savedServers.length > 0 && (
        <section>
          <h2 className="font-display text-lg font-semibold text-white mb-4">
            Servidores Salvos ({savedServers.length})
          </h2>

          <div className="space-y-3">
            {savedServers.map((srv) => {
              const isActive = srv.id === activeServerId;
              return (
                <div
                  key={srv.id}
                  className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                    isActive
                      ? 'bg-[#161B28] border-sky-400/50'
                      : 'bg-[#12151E] border-white/8'
                  }`}
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div className="w-11 h-11 rounded-xl bg-white/6 flex items-center justify-center text-sky-400 shrink-0">
                      {srv.serverKind === 'iptv' ? (
                        <Tv className="w-5 h-5" />
                      ) : (
                        <Server className="w-5 h-5" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-display font-semibold text-base text-white truncate">
                        {srv.name}
                      </h3>
                      <p className="text-xs font-mono text-slate-400 truncate">
                        {srv.url}
                      </p>
                      <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
                        {srv.items.length} vídeos · {srv.categories.length} categorias ·{' '}
                        {srv.pagesScanned} páginas
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      data-tv-focusable="true"
                      onClick={() => onSelectServer(srv.id)}
                      className="h-10 px-4 rounded-lg bg-white text-[#090A0F] hover:bg-slate-200 font-semibold text-xs whitespace-nowrap shrink-0"
                    >
                      Abrir Catálogo
                    </button>
                    <button
                      type="button"
                      data-tv-focusable="true"
                      disabled={scanStatus.scanning}
                      onClick={() => onRescanServer(srv)}
                      className="h-10 px-3.5 rounded-lg bg-white/8 hover:bg-white/15 text-slate-200 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Atualizar
                    </button>
                    <button
                      type="button"
                      data-tv-focusable="true"
                      onClick={() => onDeleteServer(srv.id)}
                      className="h-10 w-10 rounded-lg bg-white/8 hover:bg-rose-500/25 text-slate-300 hover:text-rose-300 flex items-center justify-center shrink-0"
                      aria-label={`Remover ${srv.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
