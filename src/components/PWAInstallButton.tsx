import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallButton() {
  const { canInstall, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  useEffect(() => {
    if (!showIOSGuide) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        setShowIOSGuide(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showIOSGuide]);

  if (isInstalled || (!canInstall && !isIOS)) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        data-tv-focusable="true"
        onClick={() => {
          if (canInstall) {
            void install();
          } else {
            setShowIOSGuide(true);
          }
        }}
        className="h-10 px-4 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/35 text-xs font-medium text-emerald-200 flex items-center gap-2 whitespace-nowrap shrink-0"
      >
        <Download className="w-4 h-4 shrink-0" />
        Instalar App
      </button>

      {showIOSGuide && (
        <div
          data-tv-scope="modal"
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowIOSGuide(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-[#12151E] border border-white/12 p-6 text-slate-100 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-bold text-white">
                  Instalar TelaBox no dispositivo
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  Siga os passos abaixo no Safari para adicionar à Tela de Início.
                </p>
              </div>
              <button
                type="button"
                data-tv-focusable="true"
                aria-label="Fechar"
                onClick={() => setShowIOSGuide(false)}
                className="w-9 h-9 rounded-xl bg-white/8 hover:bg-white/15 flex items-center justify-center text-slate-300 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <ol className="mt-5 space-y-3 text-sm text-slate-300">
              <li className="flex items-center gap-3">
                <span className="w-6 h-6 rounded-full bg-sky-500/20 text-sky-300 text-xs font-mono flex items-center justify-center shrink-0">
                  1
                </span>
                <span>
                  Toque no botão{' '}
                  <span className="inline-flex items-center gap-1 font-semibold text-white">
                    <Share className="w-3.5 h-3.5 text-sky-400" /> Compartilhar
                  </span>{' '}
                  na barra do navegador.
                </span>
              </li>
              <li className="flex items-center gap-3">
                <span className="w-6 h-6 rounded-full bg-sky-500/20 text-sky-300 text-xs font-mono flex items-center justify-center shrink-0">
                  2
                </span>
                <span>
                  Selecione <strong className="text-white">Adicionar à Tela de Início</strong>.
                </span>
              </li>
              <li className="flex items-center gap-3">
                <span className="w-6 h-6 rounded-full bg-sky-500/20 text-sky-300 text-xs font-mono flex items-center justify-center shrink-0">
                  3
                </span>
                <span>
                  Confirme em <strong className="text-white">Adicionar</strong> para abrir em modo aplicativo.
                </span>
              </li>
            </ol>

            <button
              type="button"
              data-tv-focusable="true"
              onClick={() => setShowIOSGuide(false)}
              className="mt-6 w-full h-11 rounded-xl bg-white text-[#090A0F] font-semibold text-sm"
            >
              Entendi
            </button>
          </div>
        </div>
      )}
    </>
  );
}
