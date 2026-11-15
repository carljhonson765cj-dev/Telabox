import { useCallback, useEffect } from 'react';

export type DpadDirection = 'up' | 'down' | 'left' | 'right';

interface UseDpadOptions {
  enabled?: boolean;
  onBack?: () => void;
  /** Return true if a custom overlay (like fullscreen video OSD) handled the key */
  onUnhandledKey?: (e: KeyboardEvent) => boolean;
}

export function getVisibleFocusables(): HTMLElement[] {
  const modalScopes = Array.from(document.querySelectorAll<HTMLElement>('[data-tv-scope="modal"]'))
    .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed');

  const root: ParentNode = modalScopes.length > 0 ? modalScopes[modalScopes.length - 1] : document;

  return Array.from(root.querySelectorAll<HTMLElement>('[data-tv-focusable="true"]')).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('[data-tv-ignore-spatial="true"]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function findNextElement(current: HTMLElement | null, direction: DpadDirection): HTMLElement | null {
  const candidates = getVisibleFocusables();
  if (candidates.length === 0) return null;

  if (!current || !candidates.includes(current)) {
    return candidates[0];
  }

  const curRect = current.getBoundingClientRect();
  const curCx = curRect.left + curRect.width / 2;
  const curCy = curRect.top + curRect.height / 2;

  let bestEl: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const cand of candidates) {
    if (cand === current) continue;
    const r = cand.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    const dx = cx - curCx;
    const dy = cy - curCy;

    let isInDirection = false;
    let primaryDist = 0;
    let secondaryDist = 0;

    switch (direction) {
      case 'right':
        isInDirection = dx > 4;
        primaryDist = dx;
        secondaryDist = Math.abs(dy);
        break;
      case 'left':
        isInDirection = dx < -4;
        primaryDist = -dx;
        secondaryDist = Math.abs(dy);
        break;
      case 'down':
        isInDirection = dy > 4;
        primaryDist = dy;
        secondaryDist = Math.abs(dx);
        break;
      case 'up':
        isInDirection = dy < -4;
        primaryDist = -dy;
        secondaryDist = Math.abs(dx);
        break;
    }

    if (!isInDirection) continue;

    const score = primaryDist + secondaryDist * 2.2;
    if (score < bestScore) {
      bestScore = score;
      bestEl = cand;
    }
  }

  return bestEl;
}

function isBackKey(e: KeyboardEvent): boolean {
  return (
    e.key === 'Escape' ||
    e.key === 'Backspace' ||
    e.key === 'Back' ||
    e.key === 'BrowserBack' ||
    e.key === 'GoBack' ||
    e.key === 'XF86Back' ||
    e.keyCode === 4
  );
}

function isOkKey(e: KeyboardEvent): boolean {
  return (
    e.key === 'Enter' ||
    e.key === 'Select' ||
    e.key === 'Accept' ||
    e.key === 'DPAD_CENTER' ||
    e.code === 'NumpadEnter' ||
    e.keyCode === 23 ||
    e.keyCode === 66
  );
}

export function useDpadNavigation({ enabled = true, onBack, onUnhandledKey }: UseDpadOptions) {
  const moveFocus = useCallback((direction: DpadDirection) => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = findNextElement(active, direction);
    if (next) {
      next.focus({ preventScroll: true });
      next.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
    }
  }, []);

  const activateFocused = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.dataset.tvFocusable === 'true') {
      active.click();
    } else {
      const first = getVisibleFocusables()[0];
      first?.focus();
    }
  }, []);

  const focusFirstVisible = useCallback(() => {
    const candidates = getVisibleFocusables();
    if (candidates.length > 0) {
      candidates[0].focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTextInput =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') &&
        !(target as HTMLInputElement).readOnly;

      if (isTextInput) {
        if (isBackKey(e) && e.key !== 'Backspace') {
          e.preventDefault();
          target.blur();
          onBack?.();
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveFocus(e.key === 'ArrowDown' ? 'down' : 'up');
          return;
        }
        return;
      }

      if (onUnhandledKey && onUnhandledKey(e)) {
        return;
      }

      if (isBackKey(e)) {
        if (onBack) {
          e.preventDefault();
          onBack();
        }
        return;
      }

      if (isOkKey(e)) {
        const active = document.activeElement;
        if (active === document.body || !active || !(active instanceof HTMLElement) || active.dataset.tvFocusable !== 'true') {
          e.preventDefault();
          focusFirstVisible();
        } else if (e.key !== 'Enter') {
          // Android TV DPAD_CENTER / Select keys don't always synthesize click()
          e.preventDefault();
          active.click();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          moveFocus('up');
          break;
        case 'ArrowDown':
          e.preventDefault();
          moveFocus('down');
          break;
        case 'ArrowLeft':
          e.preventDefault();
          moveFocus('left');
          break;
        case 'ArrowRight':
          e.preventDefault();
          moveFocus('right');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, moveFocus, onBack, onUnhandledKey, focusFirstVisible]);

  return { moveFocus, activateFocused, focusFirstVisible };
}
