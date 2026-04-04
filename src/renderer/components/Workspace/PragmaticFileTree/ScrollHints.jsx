import React, { useState, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

const ScrollHints = ({ containerRef, active }) => {
  const [rect, setRect] = useState(null);

  const updateRect = () => {
    if (containerRef.current && containerRef.current.parentElement) {
      const scrollContainer = containerRef.current.parentElement;
      const bounding = scrollContainer.getBoundingClientRect();
      
      setRect({
        top: bounding.top,
        left: bounding.left,
        width: bounding.width,
        height: bounding.height,
        bottom: bounding.bottom
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

  if (!active || !rect) return null;

  const style = {
    position: 'fixed',
    left: rect.left,
    width: rect.width,
    zIndex: 9999,
    pointerEvents: 'none',
  };

  return createPortal(
    <>
      {/* Top Hint */}
      <div 
        className="scroll-hint top" 
        style={{ 
          ...style, 
          top: rect.top, 
          height: '40px',
          background: 'linear-gradient(to bottom, rgba(59, 130, 246, 0.4), transparent)'
        }} 
      />
      {/* Bottom Hint */}
      <div 
        className="scroll-hint bottom" 
        style={{ 
          ...style, 
          top: rect.bottom - 40, 
          height: '40px',
          background: 'linear-gradient(to top, rgba(59, 130, 246, 0.4), transparent)'
        }} 
      />
    </>,
    document.body
  );
};

export default ScrollHints;
