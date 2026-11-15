import { useState } from 'react';
import { Film } from 'lucide-react';

interface MediaPosterProps {
  src?: string;
  alt: string;
  category?: string;
  className?: string;
}

export function MediaPoster({ src, alt, category = '', className = '' }: MediaPosterProps) {
  const [attempt, setAttempt] = useState<'direct' | 'proxy' | 'fallback'>(src ? 'direct' : 'fallback');

  const resolvedSrc =
    attempt === 'direct' && src
      ? src
      : attempt === 'proxy' && src
      ? `/api/proxy?url=${encodeURIComponent(src)}`
      : null;

  const handleError = () => {
    if (attempt === 'direct' && src && !src.startsWith('/')) {
      setAttempt('proxy');
    } else {
      setAttempt('fallback');
    }
  };

  if (resolvedSrc) {
    return (
      <img
        src={resolvedSrc}
        alt={alt}
        referrerPolicy="no-referrer"
        onError={handleError}
        className={`w-full h-full object-cover ${className}`}
        loading="lazy"
      />
    );
  }

  return (
    <div
      className={`w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-[#161B26] via-[#10131C] to-[#0A0C12] px-4 text-center ${className}`}
    >
      <div className="w-11 h-11 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center mb-2.5 text-slate-400">
        <Film className="w-5 h-5" />
      </div>
      <p className="text-xs font-medium text-slate-300 line-clamp-2 max-w-[85%] leading-snug">
        {alt}
      </p>
      {category && (
        <span className="mt-1 text-[11px] text-slate-500 truncate max-w-[85%]">
          {category}
        </span>
      )}
    </div>
  );
}
