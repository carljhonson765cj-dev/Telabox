import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ClipboardPaste,
  Copy,
  Download,
  FileJson,
  FolderSearch,
  Globe,
  Keyboard,
  Lock,
  Play,
  RefreshCw,
  Server,
  Shield,
  Square,
  Trash2,
  Tv,
  Unlock,
  Upload,
  X,
} from 'lucide-react';
import type { MediaItem, ScanMode, ServerProfile } from '../types/media';
import { OnScreenKeyboard } from './OnScreenKeyboard';
import { buildBackupJson, parseBackupJson } from '../utils/backup';
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
  favorites: MediaItem[];
  activeServerId: string | null;
  scanStatus: ScanStatus;
  pinEnabled: boolean;
  onConfigurePin: (mode: 'setup' | 'change' | 'disable') => void;
  onLockNow: () => void;
  onImportBackup: (payload: {
    servers: ServerProfile[];
    favorites: MediaItem[];
  }) => { serversAdded: number; serversUpdated: number; favoritesAdded: number };
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
  favorites,
  activeServerId,
  scanStatus,
  pinEnabled,
  onConfigurePin,
  onLockNow,
  onImportBackup,
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupModalCloseRef = useRef<HTMLButtonElement>(null);
  const [backupModalMode, setBackupModalMode] = useState<'export' | 'import' | null>(null);
  const [backupText, setBackupText] = useState('');
  const [copiedBackup, setCopiedBackup] = useState(false);
  const [backupFeedback, setBackupFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    if (backupModalMode) {
      const t = window.setTimeout(() => backupModalCloseRef.current?.focus(), 40);
      return () => window.clearTimeout(t);
    }
  }, [backupModalMode]);

  useEffect(() => {
    if (!backupModalMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' ||
        e.key === 'Back' ||
        e.key === 'BrowserBack' ||
        e.key === 'GoBack' ||
        e.key === 'XF86Back' ||
        e.keyCode === 4
      ) {
        e.preventDefault();
        e.stopPropagation();
        setBackupModalMode(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [backupModalMode]);

  const handleDownloadBackupFile = () => {
    const json = buildBackupJson(savedServers, favorites);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    anchor.href = downloadUrl;
    anchor.download = `telabox-backup-${dateStamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(downloadUrl);
    setBackupFeedback({
      type: 'success',
      message: `Backup exportado com ${savedServers.length} servidor(es) e ${favorites.length} favorito(s).`,
    });
  };

  const handleOpenExportText = () => {
    setBackupText(buildBackupJson(savedServers, favorites));
    setCopiedBackup(false);
    setBackupFeedback(null);
    setBackupModalMode('export');
  };

  const handleOpenImportText = () => {
    setBackupText('');
    setCopiedBackup(false);
    setBackupFeedback(null);
    setBackupModalMode('import');
  };

  const handleCopyBackupText = async () => {
    try {
      await navigator.clipboard.writeText(backupText);
      setCopiedBackup(true);
      window.setTimeout(() => setCopiedBackup(false), 2200);
    } catch {
      setBackupFeedback({
        type: 'error',
        message: 'Não foi possível copiar automaticamente. Selecione o texto abaixo e copie manualmente.',
      });
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setBackupText(text);
        setBackupFeedback(null);
      }
    } catch {
      setBackupFeedback({
        type: 'error',
        message: 'Acesso à área de transferência bloqueado. Cole o texto manualmente na caixa abaixo.',
      });
    }
  };

  const applyImportedText = (rawText: string, closeModalOnSuccess: boolean) => {
    try {
      const parsed = parseBackupJson(rawText);
      const result = onImportBackup(parsed);
      setBackupFeedback({
        type: 'success',
        message: `Backup importado: ${result.serversAdded} servidor(es) novo(s), ${result.serversUpdated} atualizado(s) e ${result.favoritesAdded} favorito(s) adicionado(s).`,
      });
      if (closeModalOnSuccess) {
        setBackupModalMode(null);
      }
    } catch (err) {
      setBackupFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Erro ao importar backup.',
      });
    }
  };

  const handleBackupFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      applyImportedText(text, false);
    };
    reader.onerror = () => {
      setBackupFeedback({
        type: 'error',
        message: 'Não foi possível ler o arquivo selecionado.',
      });
    };
    reader.readAsText(file);
  };

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
      <section className="relative rounded-lg overflow-hidden bg-[#16181F] border border-white/10">
        <div className="relative p-6 sm:p-8">
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
                  className="w-full h-13 pl-12 pr-4 rounded-lg bg-[#0B0C10] border-2 border-white/12 text-base font-mono text-white placeholder:text-slate-500 focus:border-[#FFB800]"
                />
              </div>

              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => setShowKeyboard((k) => !k)}
                className="h-13 px-4 rounded-lg bg-[#1E212B] hover:bg-[#262A36] text-slate-200 border-2 border-white/10 hover:border-[#FFB800] focus:border-[#FFB800] flex items-center justify-center gap-2 text-sm font-medium whitespace-nowrap shrink-0"
              >
                <Keyboard className="w-4 h-4 text-[#FFB800]" />
                Teclado TV
              </button>

              {!scanStatus.scanning ? (
                <button
                  type="submit"
                  data-tv-focusable="true"
                  disabled={!url.trim()}
                  className="h-13 px-7 rounded-lg bg-[#FFB800] hover:bg-[#FFC933] disabled:opacity-45 text-[#0B0C10] font-display font-bold text-base flex items-center justify-center gap-2 whitespace-nowrap shrink-0 hover:scale-105 focus:scale-105"
                >
                  <FolderSearch className="w-5 h-5" />
                  Carregar Servidor
                </button>
              ) : (
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={onStopScan}
                  className="h-13 px-7 rounded-lg bg-[#FFB800] hover:bg-[#FFC933] text-[#0B0C10] font-display font-bold text-base flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
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
                className="h-10 px-3.5 rounded-lg bg-[#0B0C10] border-2 border-white/10 text-sm text-white placeholder:text-slate-500 w-64 focus:border-[#FFB800]"
              />

              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#0B0C10] border border-white/10">
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => setMode('full')}
                  className={`px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    mode === 'full'
                      ? 'bg-[#FFB800] text-[#0B0C10] font-semibold'
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
                      ? 'bg-[#FFB800] text-[#0B0C10] font-semibold'
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
                className={`h-10 px-4 rounded-lg border-2 text-xs font-medium whitespace-nowrap shrink-0 ${
                  useProxy
                    ? 'bg-[#FFB800]/15 border-[#FFB800]/50 text-[#FFB800]'
                    : 'bg-[#0B0C10] border-white/10 text-slate-300'
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
            <div className="mt-6 p-5 rounded-lg bg-[#0B0C10] border border-[#FFB800]/40">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                <div className="flex items-center gap-3">
                  <RefreshCw className="w-5 h-5 text-[#FFB800] animate-spin" />
                  <span className="font-display font-semibold text-base text-white">
                    Mapeando servidor e organizando vídeos...
                  </span>
                </div>
                <div className="text-sm font-mono tabular-nums text-slate-300">
                  {scanStatus.pagesScanned} / {scanStatus.maxPages} páginas ·{' '}
                  {scanStatus.foldersFound} pastas ·{' '}
                  <span className="text-[#FFB800] font-semibold">
                    {scanStatus.itemsFound} vídeos
                  </span>
                </div>
              </div>

              <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-[#FFB800] transition-all duration-200"
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
            <div className="mt-5 p-4 rounded-lg bg-rose-500/15 border border-rose-500/40 text-sm text-rose-200">
              {scanStatus.error}
            </div>
          )}
        </div>
      </section>

      {/* TV Box Privacy (PIN) & Backup Settings — Prominent for Backup/PIN tab */}
      <section>
        <h2 className="font-display text-lg font-semibold text-white mb-4">
          Backup JSON e Bloqueio por PIN (TV Box)
        </h2>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 4-Digit PIN Lock Settings Card */}
          <div className="p-5 sm:p-6 rounded-lg bg-[#16181F] border border-white/10 flex flex-col justify-between gap-5">
            <div className="flex items-start gap-3.5">
              <div
                className={`w-11 h-11 rounded-lg flex items-center justify-center shrink-0 border ${
                  pinEnabled
                    ? 'bg-[#FFB800]/15 border-[#FFB800]/45 text-[#FFB800]'
                    : 'bg-white/6 border-white/10 text-slate-300'
                }`}
              >
                <Shield className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display font-semibold text-base text-white">
                    Bloqueio por PIN (4 dígitos)
                  </h3>
                  <span
                    className={`text-[11px] font-mono px-2 py-0.5 rounded ${
                      pinEnabled
                        ? 'bg-[#FFB800]/15 text-[#FFB800]'
                        : 'bg-white/8 text-slate-400'
                    }`}
                  >
                    {pinEnabled ? 'Ativo' : 'Desativado'}
                  </span>
                </div>
                <p className="mt-1 text-xs sm:text-sm text-slate-400 leading-relaxed">
                  {pinEnabled
                    ? 'O TelaBox solicita o PIN de 4 dígitos ao abrir. Navegável pelas setas do controle remoto (D-Pad) e por toque.'
                    : 'Proteja a abertura do aplicativo com uma senha numérica de 4 dígitos fácil de digitar pelo controle remoto.'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {!pinEnabled ? (
                <button
                  type="button"
                  data-tv-focusable="true"
                  onClick={() => onConfigurePin('setup')}
                  className="h-11 px-5 rounded-lg bg-[#FFB800] hover:bg-[#FFC933] text-[#0B0C10] font-semibold text-xs sm:text-sm flex items-center gap-2 whitespace-nowrap shrink-0 hover:scale-105 focus:scale-105"
                >
                  <Lock className="w-4 h-4" />
                  Ativar PIN de 4 Dígitos
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => onConfigurePin('change')}
                    className="h-11 px-4 rounded-lg bg-[#FFB800] hover:bg-[#FFC933] text-[#0B0C10] font-semibold text-xs sm:text-sm flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Shield className="w-4 h-4" />
                    Alterar PIN
                  </button>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={onLockNow}
                    className="h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-xs sm:text-sm flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Lock className="w-4 h-4 text-[#FFB800]" />
                    Bloquear Agora
                  </button>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => onConfigurePin('disable')}
                    className="h-11 px-4 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/35 text-rose-200 font-medium text-xs sm:text-sm flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Unlock className="w-4 h-4" />
                    Desativar PIN
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Export / Import Backup Card */}
          <div className="p-5 sm:p-6 rounded-lg bg-[#16181F] border border-white/10 flex flex-col justify-between gap-5">
            <div className="flex items-start gap-3.5">
              <div className="w-11 h-11 rounded-lg bg-[#FFB800]/15 border border-[#FFB800]/40 text-[#FFB800] flex items-center justify-center shrink-0">
                <FileJson className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="font-display font-semibold text-base text-white">
                  Backup de Servidores e Favoritos
                </h3>
                <p className="mt-1 text-xs sm:text-sm text-slate-400 leading-relaxed">
                  Exporte ou importe seus servidores salvos e vídeos favoritos em arquivo JSON ou texto para transferir entre TV Box, celular e navegador.
                </p>
                <p className="mt-1.5 text-xs font-mono tabular-nums text-slate-300">
                  {savedServers.length} {savedServers.length === 1 ? 'servidor' : 'servidores'} ·{' '}
                  {favorites.length} {favorites.length === 1 ? 'favorito' : 'favoritos'}
                </p>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json,text/plain"
              onChange={handleBackupFileSelected}
              className="hidden"
            />

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                data-tv-focusable="true"
                onClick={handleDownloadBackupFile}
                className="h-11 px-4 rounded-lg bg-[#FFB800] hover:bg-[#FFC933] text-[#0B0C10] font-semibold text-xs sm:text-sm flex items-center gap-2 whitespace-nowrap shrink-0 hover:scale-105 focus:scale-105"
              >
                <Download className="w-4 h-4" />
                Exportar Backup (.json)
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={handleOpenExportText}
                className="h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-xs sm:text-sm flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <Copy className="w-4 h-4" />
                Exportar em Texto
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={() => fileInputRef.current?.click()}
                className="h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-xs sm:text-sm flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <Upload className="w-4 h-4" />
                Importar Arquivo
              </button>
              <button
                type="button"
                data-tv-focusable="true"
                onClick={handleOpenImportText}
                className="h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-xs sm:text-sm flex items-center gap-2 whitespace-nowrap shrink-0"
              >
                <ClipboardPaste className="w-4 h-4" />
                Importar Texto JSON
              </button>
            </div>
          </div>
        </div>

        {backupFeedback && !backupModalMode && (
          <div
            className={`mt-4 p-4 rounded-lg border text-sm ${
              backupFeedback.type === 'success'
                ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
                : 'bg-rose-500/15 border-rose-500/40 text-rose-200'
            }`}
          >
            {backupFeedback.message}
          </div>
        )}
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
              className="group relative flex items-center gap-4 p-4 rounded-lg bg-[#16181F] border-2 border-white/8 hover:border-[#FFB800] focus:border-[#FFB800] hover:scale-[1.02] focus:scale-[1.02] text-left overflow-hidden transition-transform duration-150"
            >
              <div className="w-24 h-16 rounded-md overflow-hidden bg-[#0B0C10] shrink-0">
                <img
                  src={demo.image}
                  alt={demo.label}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display font-semibold text-base text-white truncate group-hover:text-[#FFB800] group-focus:text-[#FFB800]">
                  {demo.label}
                </h3>
                <p className="mt-0.5 text-xs text-slate-400 line-clamp-1">
                  {demo.subtitle}
                </p>
                <p className="mt-1 text-xs font-mono text-[#FFB800]/90 truncate">
                  {demo.url}
                </p>
              </div>
              <div className="w-10 h-10 rounded-lg bg-white/8 group-hover:bg-[#FFB800] group-focus:bg-[#FFB800] group-hover:text-[#0B0C10] group-focus:text-[#0B0C10] flex items-center justify-center text-white shrink-0 transition-colors">
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
                  className={`p-4 rounded-lg border-2 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                    isActive
                      ? 'bg-[#1A1D26] border-[#FFB800]/60'
                      : 'bg-[#16181F] border-white/8'
                  }`}
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div className="w-11 h-11 rounded-lg bg-[#FFB800]/12 flex items-center justify-center text-[#FFB800] shrink-0">
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
                      className="h-10 px-4 rounded-lg bg-[#FFB800] text-[#0B0C10] hover:bg-[#FFC933] font-semibold text-xs whitespace-nowrap shrink-0"
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

      {/* Export / Import Backup Text Modal */}
      {backupModalMode && (
        <div
          data-tv-scope="modal"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6"
        >
          <div className="w-full max-w-2xl rounded-lg bg-[#16181F] border border-white/15 p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-xl font-bold text-white">
                  {backupModalMode === 'export'
                    ? 'Exportar Backup em Texto JSON'
                    : 'Importar Backup em Texto JSON'}
                </h3>
                <p className="mt-1 text-xs sm:text-sm text-slate-400">
                  {backupModalMode === 'export'
                    ? 'Copie o JSON abaixo ou baixe o arquivo para salvar seus servidores e favoritos.'
                    : 'Cole o conteúdo JSON de um backup exportado anteriormente pelo TelaBox.'}
                </p>
              </div>
              <button
                ref={backupModalCloseRef}
                type="button"
                data-tv-focusable="true"
                onClick={() => setBackupModalMode(null)}
                className="w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 text-slate-200 flex items-center justify-center shrink-0"
                aria-label="Fechar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <textarea
              data-tv-focusable="true"
              value={backupText}
              onChange={(e) => {
                if (backupModalMode === 'import') {
                  setBackupText(e.target.value);
                  setBackupFeedback(null);
                }
              }}
              readOnly={backupModalMode === 'export'}
              placeholder='{"app":"TelaBox","version":1,"servers":[...],"favorites":[...]}'
              rows={10}
              className="w-full rounded-lg bg-[#0B0C10] border-2 border-white/15 p-4 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:border-[#FFB800]"
            />

            {backupFeedback && (
              <div
                className={`p-3.5 rounded-lg border text-xs sm:text-sm ${
                  backupFeedback.type === 'success'
                    ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
                    : 'bg-rose-500/15 border-rose-500/40 text-rose-200'
                }`}
              >
                {backupFeedback.message}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
              {backupModalMode === 'export' ? (
                <>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={handleDownloadBackupFile}
                    className="h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Download className="w-4 h-4" />
                    Baixar .json
                  </button>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => void handleCopyBackupText()}
                    className="h-11 px-5 rounded-lg bg-[#FFB800] hover:bg-[#FFC933] text-[#0B0C10] text-sm font-semibold flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    {copiedBackup ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                    {copiedBackup ? 'JSON Copiado' : 'Copiar Tudo'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    onClick={() => void handlePasteFromClipboard()}
                    className="h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <ClipboardPaste className="w-4 h-4" />
                    Colar Texto
                  </button>
                  <button
                    type="button"
                    data-tv-focusable="true"
                    disabled={!backupText.trim()}
                    onClick={() => applyImportedText(backupText, true)}
                    className="h-11 px-5 rounded-lg bg-[#FFB800] hover:bg-[#FFC933] disabled:opacity-45 text-[#0B0C10] text-sm font-semibold flex items-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Upload className="w-4 h-4" />
                    Importar Backup
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
