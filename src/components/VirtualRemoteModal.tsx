import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerUpLeft,
  Home,
  X,
} from 'lucide-react';
import type { DpadDirection } from '../hooks/useDpadNavigation';

interface VirtualRemoteModalProps {
  onMove: (dir: DpadDirection) => void;
  onOk: () => void;
  onBack: () => void;
  onHome: () => void;
  onClose: () => void;
}

export function VirtualRemoteModal({
  onMove,
  onOk,
  onBack,
  onHome,
  onClose,
}: VirtualRemoteModalProps) {
  return (
    <div
      data-tv-ignore-spatial="true"
      className="fixed bottom-12 right-6 z-40 w-64 rounded-2xl bg-[#12151E] border border-white/15 p-4 shadow-2xl"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="font-display text-sm font-semibold text-white">
          Controle Virtual
        </span>
        <button
          type="button"
          onClick={onClose}
          className="w-7 h-7 rounded-lg bg-white/8 hover:bg-white/15 flex items-center justify-center text-slate-300"
          aria-label="Fechar controle virtual"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Circular D-Pad Grid */}
      <div className="grid grid-cols-3 gap-2 max-w-[168px] mx-auto my-2">
        <div />
        <button
          type="button"
          onClick={() => onMove('up')}
          className="h-12 rounded-xl bg-[#1B2030] hover:bg-[#262D42] active:scale-95 border border-white/10 flex items-center justify-center text-white"
          aria-label="Cima"
        >
          <ChevronUp className="w-5 h-5" />
        </button>
        <div />

        <button
          type="button"
          onClick={() => onMove('left')}
          className="h-12 rounded-xl bg-[#1B2030] hover:bg-[#262D42] active:scale-95 border border-white/10 flex items-center justify-center text-white"
          aria-label="Esquerda"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <button
          type="button"
          onClick={onOk}
          className="h-12 rounded-xl bg-sky-500 hover:bg-sky-400 active:scale-95 text-slate-950 font-display font-bold text-sm flex items-center justify-center"
        >
          OK
        </button>
        <button
          type="button"
          onClick={() => onMove('right')}
          className="h-12 rounded-xl bg-[#1B2030] hover:bg-[#262D42] active:scale-95 border border-white/10 flex items-center justify-center text-white"
          aria-label="Direita"
        >
          <ChevronRight className="w-5 h-5" />
        </button>

        <div />
        <button
          type="button"
          onClick={() => onMove('down')}
          className="h-12 rounded-xl bg-[#1B2030] hover:bg-[#262D42] active:scale-95 border border-white/10 flex items-center justify-center text-white"
          aria-label="Baixo"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
        <div />
      </div>

      <div className="grid grid-cols-2 gap-2 mt-4 pt-3 border-t border-white/10">
        <button
          type="button"
          onClick={onBack}
          className="h-10 rounded-xl bg-[#1A1F2E] hover:bg-[#242B3E] text-xs font-medium text-slate-200 flex items-center justify-center gap-1.5"
        >
          <CornerUpLeft className="w-3.5 h-3.5" />
          Voltar
        </button>
        <button
          type="button"
          onClick={onHome}
          className="h-10 rounded-xl bg-[#1A1F2E] hover:bg-[#242B3E] text-xs font-medium text-slate-200 flex items-center justify-center gap-1.5"
        >
          <Home className="w-3.5 h-3.5" />
          Início
        </button>
      </div>
    </div>
  );
}
