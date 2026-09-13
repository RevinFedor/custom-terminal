import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import { usePointerGesture } from '../../hooks/usePointerGesture';

interface ResizerProps {
  onResize?: () => void;
}

export default function Resizer({ onResize }: ResizerProps) {
  const setNotesPanelWidth = useUIStore((state) => state.setNotesPanelWidth);
  const { start } = usePointerGesture();

  return (
    <div
      className="relative w-1 h-full bg-border-main cursor-col-resize z-50 hover:bg-accent shrink-0"
      style={{ userSelect: 'none', touchAction: 'none' }}
      onPointerDown={(event) => start(event, {
        cursor: 'col-resize',
        onMove: (move) => {
          const newWidth = document.body.clientWidth - move.clientX;
          if (newWidth >= 150 && newWidth <= 600) {
            setNotesPanelWidth(newWidth);
            onResize?.();
          }
        },
      })}
    />
  );
}
