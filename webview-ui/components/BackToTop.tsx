import { useEffect, useState } from 'react';

/** How far down you have to be before the button is worth offering. Roughly one screen. */
const SHOW_AFTER_PX = 600;

/** Honour the reader's motion preference: a long diff smooth-scrolls a very long way. */
function scrollBehavior(): ScrollBehavior {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
}

/**
 * A floating "back to top" button, shown once you have scrolled a screen or so down. A review runs long, and
 * getting back to the summary, the pull-request actions, or the first file otherwise means a lot of
 * scrolling. It sits bottom-right rather than in the top bar: the bar is busy, and this belongs near where
 * your pointer already is while scrolling.
 */
export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setVisible(window.scrollY > SHOW_AFTER_PX);
    onScroll(); // the panel can be restored already scrolled down
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!visible) return null;
  return (
    <button
      type="button"
      className="lr-to-top"
      title="Back to top"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: scrollBehavior() })}
    >
      <span aria-hidden="true">↑</span> Top
    </button>
  );
}
