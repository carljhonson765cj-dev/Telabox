import { useCallback, useEffect, useRef, useState } from 'react';
import { Delete, Lock, RotateCcw, ShieldCheck, X } from 'lucide-react';

export type PinOverlayMode = 'unlock' | 'setup' | 'change' | 'disable';

interface PinLockOverlayProps {
  mode: PinOverlayMode;
  expectedPin?: string | null;
  onUnlock?: () => void;
  onSavePin?: (newPin: string) => void;
  onDisablePin?: () => void;
  onCancel?: () => void;
}

type PinStep = 'verify-current' | 'enter-new' | 'confirm-new';

export function PinLockOverlay({
  mode,
  expectedPin,
  onUnlock,
  onSavePin,
  onDisablePin,
  onCancel,
}: PinLockOverlayProps) {
  const firstDigitRef = useRef<HTMLButtonElement>(null);

  const [step, setStep] = useState<PinStep>(() => {
    if (mode === 'setup') return 'enter-new';
    return 'verify-current';
  });
  const [digits, setDigits] = useState('');
  const [draftNewPin, setDraftNewPin] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canCancel = mode !== 'unlock' && Boolean(onCancel);

  useEffect(() => {
    setStep(mode === 'setup' ? 'enter-new' : 'verify-current');
    setDigits('');
    setDraftNewPin('');
    setErrorMsg(null);
    setBusy(false);
  }, [mode]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      firstDigitRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, [mode, step]);

  const submitPin = useCallback(
    (code: string) => {
      if (busy) return;
      setBusy(true);

      window.setTimeout(() => {
        if (mode === 'unlock') {
          if (code === expectedPin) {
            onUnlock?.();
          } else {
            setErrorMsg('PIN incorreto. Tente novamente.');
            setDigits('');
          }
          setBusy(false);
          return;
        }

        if (mode === 'disable') {
          if (code === expectedPin) {
            onDisablePin?.();
          } else {
            setErrorMsg('PIN atual incorreto.');
            setDigits('');
          }
          setBusy(false);
          return;
        }

        if (step === 'verify-current') {
          if (code === expectedPin) {
            setStep('enter-new');
            setDigits('');
            setErrorMsg(null);
          } else {
            setErrorMsg('PIN atual incorreto.');
            setDigits('');
          }
          setBusy(false);
          return;
        }

        if (step === 'enter-new') {
          setDraftNewPin(code);
          setStep('confirm-new');
          setDigits('');
          setErrorMsg(null);
          setBusy(false);
          return;
        }

        if (step === 'confirm-new') {
          if (code === draftNewPin) {
            onSavePin?.(code);
          } else {
            setErrorMsg('Os PINs não coincidem. Digite o novo PIN novamente.');
            setDraftNewPin('');
            setStep('enter-new');
            setDigits('');
          }
          setBusy(false);
        }
      }, 110);
    },
    [busy, mode, expectedPin, step, draftNewPin, onUnlock, onDisablePin, onSavePin]
  );

  const appendDigit = useCallback(
    (digit: string) => {
      if (busy || digits.length >= 4) return;
      setErrorMsg(null);
      const next = digits + digit;
      setDigits(next);
      if (next.length === 4) {
        submitPin(next);
      }
    },
    [busy, digits, submitPin]
  );

  const handleBackspace = useCallback(() => {
    if (busy) return;
    setErrorMsg(null);
    setDigits((prev) => prev.slice(0, -1));
  }, [busy]);

  const handleClear = useCallback(() => {
    if (busy) return;
    setErrorMsg(null);
    setDigits('');
  }, [busy]);

  // Support physical numeric keys, Backspace, and Escape/Back inside PIN modal
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        appendDigit(e.key);
        return;
      }
      if (
        e.key === 'Escape' ||
        e.key === 'Backspace' ||
        e.key === 'Back' ||
        e.key === 'BrowserBack' ||
        e.key === 'GoBack' ||
        e.key === 'XF86Back' ||
        e.keyCode === 4
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (digits.length > 0 && e.key === 'Backspace') {
          handleBackspace();
        } else if (canCancel) {
          onCancel?.();
        } else if (digits.length > 0) {
          handleBackspace();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [appendDigit, handleBackspace, digits.length, canCancel, onCancel]);

  const titleText = (() => {
    if (mode === 'unlock') return 'TelaBox Bloqueado';
    if (mode === 'disable') return 'Desativar Bloqueio por PIN';
    if (step === 'verify-current') return 'Confirmar PIN Atual';
    if (step === 'enter-new') return mode === 'change' ? 'Novo PIN de 4 Dígitos' : 'Definir PIN de 4 Dígitos';
    return 'Confirme o Novo PIN';
  })();

  const subtitleText = (() => {
    if (mode === 'unlock') {
      return 'Digite seu PIN de 4 dígitos usando o controle remoto, teclado ou toque para acessar o aplicativo.';
    }
    if (mode === 'disable') {
      return 'Digite o PIN atual para remover a proteção ao abrir o aplicativo.';
    }
    if (step === 'verify-current') {
      return 'Informe o PIN atual antes de cadastrar um novo código.';
    }
    if (step === 'enter-new') {
      return 'Escolha 4 dígitos numéricos para proteger a abertura do TelaBox.';
    }
    return 'Digite os mesmos 4 dígitos novamente para confirmar.';
  })();

  return (
    <div
      data-tv-scope="modal"
      className="fixed inset-0 z-[70] bg-[#090A0F]/98 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 overflow-y-auto"
    >
      <div className="w-full max-w-md rounded-2xl bg-[#12151E] border border-white/12 p-6 sm:p-8 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-xl bg-sky-500/15 border border-sky-400/35 text-sky-300 flex items-center justify-center shrink-0">
              {mode === 'unlock' ? (
                <Lock className="w-5 h-5" />
              ) : (
                <ShieldCheck className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 className="font-display text-xl font-bold text-white leading-tight">
                {titleText}
              </h2>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                {subtitleText}
              </p>
            </div>
          </div>

          {canCancel && (
            <button
              type="button"
              data-tv-focusable="true"
              onClick={onCancel}
              className="w-10 h-10 rounded-xl bg-white/8 hover:bg-white/15 text-slate-300 hover:text-white flex items-center justify-center shrink-0"
              aria-label="Cancelar"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 4-digit PIN Slots */}
        <div className="mt-7 flex items-center justify-center gap-3.5">
          {[0, 1, 2, 3].map((slot) => {
            const filled = slot < digits.length;
            const activeSlot = slot === digits.length && !busy;
            return (
              <div
                key={slot}
                className={`w-14 h-14 rounded-xl border flex items-center justify-center transition-colors ${
                  errorMsg
                    ? 'bg-rose-500/10 border-rose-400/60'
                    : filled
                    ? 'bg-sky-500/15 border-sky-400/60'
                    : activeSlot
                    ? 'bg-[#090A0F] border-white/40'
                    : 'bg-[#090A0F] border-white/12'
                }`}
              >
                <span
                  className={`w-3.5 h-3.5 rounded-full transition-transform ${
                    filled ? 'bg-white scale-100' : 'bg-white/15 scale-75'
                  }`}
                />
              </div>
            );
          })}
        </div>

        {errorMsg ? (
          <p className="mt-3 text-center text-xs font-medium text-rose-300 min-h-[18px]">
            {errorMsg}
          </p>
        ) : (
          <p className="mt-3 text-center text-xs text-slate-500 min-h-[18px] font-mono">
            {digits.length}/4 dígitos
          </p>
        )}

        {/* TV Box D-Pad & Touch Numeric Keypad */}
        <div className="mt-5 grid grid-cols-3 gap-2.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num, idx) => (
            <button
              key={num}
              ref={idx === 0 ? firstDigitRef : undefined}
              type="button"
              data-tv-focusable="true"
              disabled={busy}
              onClick={() => appendDigit(num)}
              className="h-14 rounded-xl bg-[#191E2B] hover:bg-[#232A3C] border border-white/10 text-xl font-display font-bold text-white flex items-center justify-center transition-colors"
            >
              {num}
            </button>
          ))}

          <button
            type="button"
            data-tv-focusable="true"
            disabled={busy || digits.length === 0}
            onClick={handleClear}
            className="h-14 rounded-xl bg-[#131722] hover:bg-[#1E2434] disabled:opacity-40 border border-white/10 text-xs font-semibold text-slate-300 flex items-center justify-center gap-1.5"
          >
            <RotateCcw className="w-4 h-4" />
            Limpar
          </button>

          <button
            type="button"
            data-tv-focusable="true"
            disabled={busy}
            onClick={() => appendDigit('0')}
            className="h-14 rounded-xl bg-[#191E2B] hover:bg-[#232A3C] border border-white/10 text-xl font-display font-bold text-white flex items-center justify-center transition-colors"
          >
            0
          </button>

          <button
            type="button"
            data-tv-focusable="true"
            disabled={busy || digits.length === 0}
            onClick={handleBackspace}
            className="h-14 rounded-xl bg-[#131722] hover:bg-[#1E2434] disabled:opacity-40 border border-white/10 text-xs font-semibold text-slate-300 flex items-center justify-center gap-1.5"
            aria-label="Apagar último dígito"
          >
            <Delete className="w-4 h-4" />
            Apagar
          </button>
        </div>

        <p className="mt-5 text-center text-xs text-slate-500">
          D-Pad: Navegar · OK: Inserir dígito · 0–9 no teclado
        </p>
      </div>
    </div>
  );
}
