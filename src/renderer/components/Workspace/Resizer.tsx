import React, { useCallback, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/useUIStore';

interface ResizerProps {
  onResize?: () => void;
}

export default function Resizer({ onResize }: ResizerProps) {
  const { setNotesPanelWidth } = useUIStore();
  const isResizing = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;

      const newWidth = document.body.clientWidth - e.clientX;
      if (newWidth >= 150 && newWidth <= 600) {
        setNotesPanelWidth(newWidth);
        onResize?.();
      }
    };

    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [setNotesPanelWidth, onResize]);

  return (
    <div
      className="relative w-1 h-full bg-border-main cursor-col-resize z-50 transition-colors duration-200 hover:bg-accent shrink-0"
      onMouseDown={handleMouseDown}
    />
  );
}
