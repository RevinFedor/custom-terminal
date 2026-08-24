import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { electronComposerClipboardAdapter } from '../../../utils/electronComposerClipboardAdapter';

export interface PastedContentPreviewProps {
  text: string;
  maxHeight?: React.CSSProperties['maxHeight'];
  /** The enclosing portal already owns viewport clamping in History. */
  clampToViewport?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onCopy?: (text: string) => void;
}

export const AttachmentPreviewBar: React.FC<{
  meta: React.ReactNode;
  children?: React.ReactNode;
}> = ({ meta, children }) => (
  <div
    data-attachment-preview-bar
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      flex: '0 0 auto',
      padding: '5px 8px',
      color: '#777',
      background: '#1a1a1a',
      borderBottom: '1px solid #2d2d2d',
      fontSize: '0.82em',
      lineHeight: 1.25,
    }}
  >
    <span>{meta}</span>
    {children != null && (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        {children}
      </span>
    )}
  </div>
);

/**
 * One expanded pasted-content surface for both a sent History message and the
 * live composer. The header is deliberately content-only: byte ownership stays
 * with the host, while this component owns the character count, copy affordance
 * and the single vertical scroll region.
 */
export const PastedContentPreview: React.FC<PastedContentPreviewProps> = ({
  text,
  maxHeight = 'min(360px, calc(100vh - 16px))',
  clampToViewport = true,
  className,
  style,
  onCopy,
}) => {
  const [copied, setCopied] = useState(false);
  const [viewportMaxHeight, setViewportMaxHeight] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measureViewportLimit = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    // `bottom` stays tied to the chip/composer when this preview opens upward.
    // Limiting its height to the space between that edge and the window's top
    // keeps the card inside the application even when the anchor is scrolled
    // close to the top. The body, not the card, becomes the scroll owner.
    const next = Math.max(1, Math.floor(root.getBoundingClientRect().bottom - 8));
    setViewportMaxHeight((current) => current === next ? current : next);
  }, []);

  useLayoutEffect(() => {
    if (!clampToViewport) {
      setViewportMaxHeight(null);
      return undefined;
    }
    measureViewportLimit();
    window.addEventListener('resize', measureViewportLimit);
    window.addEventListener('scroll', measureViewportLimit, true);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measureViewportLimit);
    if (observer && rootRef.current) observer.observe(rootRef.current);
    return () => {
      window.removeEventListener('resize', measureViewportLimit);
      window.removeEventListener('scroll', measureViewportLimit, true);
      observer?.disconnect();
    };
  }, [clampToViewport, measureViewportLimit]);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const copyText = () => {
    (onCopy || electronComposerClipboardAdapter.writeText)?.(text);
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, 900);
  };

  const requestedMaxHeight = typeof maxHeight === 'number' ? `${maxHeight}px` : String(maxHeight);
  const effectiveMaxHeight = viewportMaxHeight == null
    ? maxHeight
    : `min(${requestedMaxHeight}, ${viewportMaxHeight}px)`;

  return (
    <div
      ref={rootRef}
      className={className}
      data-pasted-content-preview
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxWidth: '100%',
        minHeight: 0,
        overflow: 'hidden',
        color: '#aaa',
        background: '#1a1a1a',
        border: '1px solid #333',
        borderRadius: 10,
        boxSizing: 'border-box',
        ...style,
        maxHeight: effectiveMaxHeight,
      }}
    >
      <AttachmentPreviewBar meta={`${text.length.toLocaleString('ru-RU')} символов`}>
        <button
          type="button"
          aria-label="Копировать pasted content"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            copyText();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: 0,
            border: 0,
            color: copied ? '#86efac' : '#888',
            background: 'transparent',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
          <span>{copied ? 'Скопировано' : 'Копировать'}</span>
        </button>
      </AttachmentPreviewBar>
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          color: '#aaa',
          background: 'transparent',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 'inherit',
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </pre>
    </div>
  );
};

export default PastedContentPreview;
