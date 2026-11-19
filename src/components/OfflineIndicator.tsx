import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="px-6 lg:px-10 py-2.5 bg-[#FFB800]/12 border-b border-[#FFB800]/30 flex items-center gap-2.5 text-xs text-[#FFD25A]">
      <WifiOff className="w-4 h-4 shrink-0 text-[#FFB800]" />
      <span>
        Sem conexão com a internet. O catálogo salvo permanece acessível, mas novos streams exigem rede.
      </span>
    </div>
  );
}
