import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="px-6 lg:px-10 py-2.5 bg-amber-500/15 border-b border-amber-400/30 flex items-center gap-2.5 text-xs text-amber-200">
      <WifiOff className="w-4 h-4 shrink-0 text-amber-300" />
      <span>
        Sem conexão com a internet. O catálogo salvo permanece acessível, mas novos streams exigem rede.
      </span>
    </div>
  );
}
