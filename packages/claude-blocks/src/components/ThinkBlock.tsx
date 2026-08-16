/* ============================================================
   @noted/claude-blocks — ThinkBlock (размышление, иконка мозга)
   ------------------------------------------------------------
   Collapse-механизм ВНЕДРЯЕМЫЙ: если передан `open`+`onToggle` —
   компонент управляемый (десктоп: scroll-stable toggle внутри
   Virtuoso; мобайл: module-Map персист через unmount). Если нет —
   внутренний useState (для голого потребителя).
   ============================================================ */
import React, { useState, useRef } from 'react';
import { BrainIcon, ChevronRightIcon } from '../icons';

export interface ThinkBlockProps {
  text: string;
  /** Полный лейбл рядом с мозгом. Дефолт "thinking". Десктоп шлёт "thinking · high". */
  label?: string;
  /** Управляемое состояние раскрытия (опционально). */
  open?: boolean;
  /** Тоггл (опционально). Если оба переданы — компонент управляемый. */
  onToggle?: () => void;
  /** Ref-приёмник на корень — десктопу нужен якорь для scroll-compensation. */
  anchorRef?: React.RefObject<HTMLDivElement | null>;
}

export const ThinkBlock: React.FC<ThinkBlockProps> = ({ text, label = 'thinking', open, onToggle, anchorRef }) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const localRef = useRef<HTMLDivElement>(null);
  const controlled = open !== undefined && onToggle !== undefined;
  const isOpen = controlled ? !!open : internalOpen;
  const toggle = controlled ? onToggle! : () => setInternalOpen(v => !v);
  const rootRef = anchorRef ?? localRef;

  return (
    <div ref={rootRef} className="cb-think">
      <button
        type="button"
        onClick={toggle}
        onMouseDown={(e) => e.preventDefault()}
        className="cb-think-btn"
        aria-expanded={isOpen}
      >
        <BrainIcon size={13} className="cb-think-ic" />
        <span className="cb-think-label">{label}</span>
        {/* Same second-level affordance as ordinary cards: chevron appears on
            hover, rotates open — thinking follows the one feed grammar. */}
        <ChevronRightIcon size={11} className="cb-tool-chevron" />
      </button>
      {isOpen && (
        <div className="cb-tool-body">
          <span className="cb-rail" />
          <div className="cb-think-body">{text}</div>
        </div>
      )}
    </div>
  );
};
