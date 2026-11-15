import { Delete, CornerDownLeft, Space } from 'lucide-react';

interface OnScreenKeyboardProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

const QUICK_TOKENS = [
  'https://',
  'http://',
  '.com',
  '.br',
  '.org',
  '.m3u8',
  '/demo-server',
];

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '.'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '/', ':'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '_', '?', '='],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', '&', '@', '~'],
];

export function OnScreenKeyboard({
  value,
  onChange,
  onSubmit,
  onClose,
}: OnScreenKeyboardProps) {
  const append = (ch: string) => onChange(value + ch);
  const backspace = () => onChange(value.slice(0, -1));

  return (
    <div className="mt-4 p-4 rounded-2xl bg-[#12151E] border border-white/10">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {QUICK_TOKENS.map((tok) => (
          <button
            key={tok}
            type="button"
            data-tv-focusable="true"
            onClick={() => append(tok)}
            className="px-3 py-1.5 rounded-lg bg-[#1A1F2E] hover:bg-[#232A3E] text-xs font-mono text-sky-300 border border-white/10 whitespace-nowrap shrink-0"
          >
            {tok}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {ROWS.map((row, idx) => (
          <div key={idx} className="flex flex-wrap gap-1.5">
            {row.map((key) => (
              <button
                key={key}
                type="button"
                data-tv-focusable="true"
                onClick={() => append(key)}
                className="min-w-[44px] h-11 px-3 rounded-lg bg-[#181C28] hover:bg-[#252B3D] text-sm font-mono font-medium text-slate-100 border border-white/10 flex items-center justify-center"
              >
                {key}
              </button>
            ))}
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            data-tv-focusable="true"
            onClick={() => append(' ')}
            className="h-11 px-5 rounded-lg bg-[#181C28] hover:bg-[#252B3D] text-sm text-slate-200 border border-white/10 flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <Space className="w-4 h-4" />
            Espaço
          </button>
          <button
            type="button"
            data-tv-focusable="true"
            onClick={backspace}
            className="h-11 px-5 rounded-lg bg-[#181C28] hover:bg-[#252B3D] text-sm text-slate-200 border border-white/10 flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <Delete className="w-4 h-4" />
            Apagar
          </button>
          <button
            type="button"
            data-tv-focusable="true"
            onClick={() => onChange('')}
            className="h-11 px-4 rounded-lg bg-[#181C28] hover:bg-[#252B3D] text-sm text-slate-300 border border-white/10 whitespace-nowrap shrink-0"
          >
            Limpar
          </button>
          <button
            type="button"
            data-tv-focusable="true"
            onClick={onClose}
            className="h-11 px-4 rounded-lg bg-[#181C28] hover:bg-[#252B3D] text-sm text-slate-300 border border-white/10 whitespace-nowrap shrink-0"
          >
            Ocultar Teclado
          </button>
          <button
            type="button"
            data-tv-focusable="true"
            onClick={onSubmit}
            className="ml-auto h-11 px-6 rounded-lg bg-sky-500 hover:bg-sky-400 text-sm font-semibold text-slate-950 flex items-center gap-2 whitespace-nowrap shrink-0"
          >
            <CornerDownLeft className="w-4 h-4" />
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}
