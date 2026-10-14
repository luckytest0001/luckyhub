/**
 * Android TV D-Pad Navigation & Focus Management Utility
 * 
 * Provides:
 * 1. Normalized key detection for all Android TV remotes (D-Pad, Center, Back, Media keys, Channel +/-)
 * 2. Instant spatial navigation between Header, Tabs, Categories sidebar, and Channel grid/list
 * 3. Zero-lag DOM focus movement without heavy React re-renders
 * 4. Automatic viewport alignment with zero scroll-lag
 */

export interface RemoteKeyEvent {
  isUp: boolean;
  isDown: boolean;
  isLeft: boolean;
  isRight: boolean;
  isSelect: boolean;
  isBack: boolean;
  isChannelUp: boolean;
  isChannelDown: boolean;
  isPlayPause: boolean;
  isRewind: boolean;
  isFastForward: boolean;
  originalEvent: KeyboardEvent;
}

export function parseRemoteKeyEvent(e: KeyboardEvent): RemoteKeyEvent {
  const code = e.keyCode || e.which;
  const key = e.key;

  const isUp =
    key === 'ArrowUp' ||
    key === 'Up' ||
    code === 38 ||
    code === 19; // Android DPAD_UP

  const isDown =
    key === 'ArrowDown' ||
    key === 'Down' ||
    code === 40 ||
    code === 20; // Android DPAD_DOWN

  const isLeft =
    key === 'ArrowLeft' ||
    key === 'Left' ||
    code === 37 ||
    code === 21; // Android DPAD_LEFT

  const isRight =
    key === 'ArrowRight' ||
    key === 'Right' ||
    code === 39 ||
    code === 22; // Android DPAD_RIGHT

  const isSelect =
    key === 'Enter' ||
    key === 'Select' ||
    key === 'Spacebar' ||
    key === ' ' ||
    code === 13 ||
    code === 23; // Android DPAD_CENTER / KEYCODE_ENTER

  const isBack =
    key === 'Escape' ||
    key === 'Esc' ||
    key === 'Back' ||
    key === 'BrowserBack' ||
    key === 'GoBack' ||
    code === 27 ||
    code === 4 || // Android KEYCODE_BACK
    code === 10009; // Tizen Back

  const isChannelUp =
    key === 'ChannelUp' ||
    key === 'PageUp' ||
    code === 33 ||
    code === 427 || // Android KEYCODE_CHANNEL_UP
    code === 166;

  const isChannelDown =
    key === 'ChannelDown' ||
    key === 'PageDown' ||
    code === 34 ||
    code === 428 || // Android KEYCODE_CHANNEL_DOWN
    code === 167;

  const isPlayPause =
    key === 'MediaPlayPause' ||
    key === 'PlayPause' ||
    key === 'MediaPlay' ||
    key === 'MediaPause' ||
    code === 179 ||
    code === 85 || // Android KEYCODE_MEDIA_PLAY_PAUSE
    code === 126 || // KEYCODE_MEDIA_PLAY
    code === 127; // KEYCODE_MEDIA_PAUSE

  const isRewind =
    key === 'MediaRewind' ||
    key === 'Rewind' ||
    code === 227 ||
    code === 89; // KEYCODE_MEDIA_REWIND

  const isFastForward =
    key === 'MediaFastForward' ||
    key === 'FastForward' ||
    code === 228 ||
    code === 90; // KEYCODE_MEDIA_FAST_FORWARD

  return {
    isUp,
    isDown,
    isLeft,
    isRight,
    isSelect,
    isBack,
    isChannelUp,
    isChannelDown,
    isPlayPause,
    isRewind,
    isFastForward,
    originalEvent: e,
  };
}

/**
 * Ensures an element is scrolled into view instantly with zero animation lag,
 * essential for rapid D-Pad button repeats on TV remotes.
 */
export function focusTvElement(el: HTMLElement | null, instant = true) {
  if (!el) return;
  try {
    el.focus({ preventScroll: false });
    if ((el as any).scrollIntoViewIfNeeded) {
      (el as any).scrollIntoViewIfNeeded(false);
    } else {
      el.scrollIntoView({
        behavior: instant ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  } catch {
    el.focus();
  }
}

/**
 * Finds all focusable TV elements in a given root or document
 */
export function getFocusableTvElements(container: HTMLElement | Document = document): HTMLElement[] {
  const selector = [
    'button:not([disabled])',
    '[tabindex="0"]:not([disabled])',
    'input:not([disabled])',
    'a[href]',
  ].join(',');

  const nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
  return nodes.filter((node) => {
    // Only return visible elements with non-zero dimensions
    return (
      node.offsetParent !== null &&
      window.getComputedStyle(node).visibility !== 'hidden' &&
      window.getComputedStyle(node).display !== 'none'
    );
  });
}

/**
 * Helper to get the geometric bounding boxes of elements for 2D spatial navigation
 */
function getCenter(rect: DOMRect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

/**
 * Smart spatial navigation: Finds the best next element in the direction of the arrow.
 * Uses Euclidean directional distance with angle weighting.
 */
export function findNextSpatialElement(
  current: HTMLElement,
  direction: 'up' | 'down' | 'left' | 'right',
  container: HTMLElement | Document = document
): HTMLElement | null {
  const currentRect = current.getBoundingClientRect();
  const currentCenter = getCenter(currentRect);
  const candidates = getFocusableTvElements(container).filter((el) => el !== current);

  let bestElement: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    const center = getCenter(rect);

    const dx = center.x - currentCenter.x;
    const dy = center.y - currentCenter.y;

    // Filter by general direction
    let isPrimaryDirection = false;
    let primaryDist = 0;
    let secondaryDist = 0;

    switch (direction) {
      case 'up':
        isPrimaryDirection = dy < -3; // candidate is above
        primaryDist = -dy;
        secondaryDist = Math.abs(dx);
        break;
      case 'down':
        isPrimaryDirection = dy > 3; // candidate is below
        primaryDist = dy;
        secondaryDist = Math.abs(dx);
        break;
      case 'left':
        isPrimaryDirection = dx < -3; // candidate is to the left
        primaryDist = -dx;
        secondaryDist = Math.abs(dy);
        break;
      case 'right':
        isPrimaryDirection = dx > 3; // candidate is to the right
        primaryDist = dx;
        secondaryDist = Math.abs(dy);
        break;
    }

    if (!isPrimaryDirection) continue;

    // Weighted distance score: heavily penalize perpendicular deviation
    // so items in the same column/row are strongly preferred
    const score = primaryDist + secondaryDist * 2.5;

    if (score < bestScore) {
      bestScore = score;
      bestElement = candidate;
    }
  }

  return bestElement;
}
