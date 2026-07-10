import React, { useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

const ScrollHints = ({ containerRef, active, edge = null, zoneSize = 120 }) => {
  const [rect, setRect] = useState(null);

  const updateRect = () => {
    if (containerRef.current && containerRef.current.parentElement) {
      const scrollContainer = containerRef.current.parentElement;
      const bounding = scrollContainer.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || bounding.bottom;
      const visibleTop = Math.max(0, bounding.top);
      const visibleBottom = Math.min(viewportHeight, bounding.bottom);
      
      setRect({
        top: visibleTop,
        left: bounding.left,
        width: bounding.width,
        height: Math.max(0, visibleBottom - visibleTop),
        bottom: visibleBottom
      });
    }
  };

  useLayoutEffect(() => {
    if (active) {
      updateRect();
      window.addEventListener('resize', updateRect);
      return () => window.removeEventListener('resize', updateRect);
    }
  }, [active, containerRef]);

  if (!active || !rect || !edge) return null;

  if (rect.height <= 0) return null;

  const hintHeight = Math.min(zoneSize, Math.max(48, Math.round(rect.height * 0.18)));
  const strong = 'rgba(114, 184, 255, 0.34)';
  const soft = 'rgba(114, 184, 255, 0)';

  const style = {
    position: 'fixed',
    left: rect.left,
    width: rect.width,
    zIndex: 9999,
    pointerEvents: 'none',
    height: `${hintHeight}px`,
    opacity: 1,
  };

  return createPortal(
    <>
      {edge === 'top' && (
        <div
          className="scroll-hint top"
          style={{
            ...style,
            top: rect.top,
            background: `linear-gradient(to bottom, ${strong}, ${soft})`,
            borderTop: '1px solid rgba(114, 184, 255, 0.7)',
          }}
        />
      )}
      {edge === 'bottom' && (
        <div
          className="scroll-hint bottom"
          style={{
            ...style,
            top: rect.bottom - hintHeight,
            background: `linear-gradient(to top, ${strong}, ${soft})`,
            borderBottom: '1px solid rgba(114, 184, 255, 0.7)',
          }}
        />
      )}
    </>,
    document.body
  );
};

export default ScrollHints;
