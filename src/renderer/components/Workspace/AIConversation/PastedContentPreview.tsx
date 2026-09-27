import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, Copy, Trash2, X } from 'lucide-react';
import { electronComposerClipboardAdapter } from '../../../utils/electronComposerClipboardAdapter';

export interface PastedContentPreviewProps {
  text: string;
  body?: React.ReactNode;
  maxHeight?: React.CSSProperties['maxHeight'];
  /** The enclosing portal already owns viewport clamping in History. */
  clampToViewport?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onCopy?: (text: string) => void;
  navigation?: AttachmentPreviewNavigationProps;
  onMoveToInput?: () => void;
  onDelete?: () => void;
  onClose?: () => void;
}

export interface AttachmentPreviewNavigationProps {
  onPrevious?: () => void;
  onNext?: () => void;
}

/** Previous/next controls shared by attachment preview headers. Missing
 * neighbours stay visible but disabled, so the two controls never swap places
 * while the user walks through the prompt band. */
export const AttachmentPreviewNavigation: React.FC<AttachmentPreviewNavigationProps> = ({
  onPrevious,
  onNext,
}) => {
  const buttonStyle = (enabled: boolean): React.CSSProperties => ({
    width: 20,
    height: 20,
    padding: 0,
    border: 0,
    borderRadius: 4,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: enabled ? 'var(--attachment-preview-nav-color, #a1a1aa)' : '#505055',
    background: enabled ? 'var(--attachment-preview-nav-bg, transparent)' : 'transparent',
    cursor: enabled ? 'pointer' : 'default',
    transition: 'color 100ms ease, background-color 100ms ease, box-shadow 100ms ease',
  });
  const invoke = (
    event: React.MouseEvent<HTMLButtonElement>,
    callback?: () => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    callback?.();
  };

  return (
    <span
      data-attachment-preview-navigation
      style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
    >
      <button
        type="button"
        className="attachment-preview-nav-button"
        data-attachment-preview-previous
        aria-label="Предыдущий промпт"
        title="Предыдущий промпт"
        disabled={!onPrevious}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => invoke(event, onPrevious)}
        style={buttonStyle(!!onPrevious)}
      >
        <ArrowLeft size={13} aria-hidden />
      </button>
      <button
        type="button"
        className="attachment-preview-nav-button"
        data-attachment-preview-next
        aria-label="Следующий промпт"
        title="Следующий промпт"
        disabled={!onNext}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => invoke(event, onNext)}
        style={buttonStyle(!!onNext)}
      >
        <ArrowRight size={13} aria-hidden />
      </button>
    </span>
  );
};

export interface AttachmentPreviewToolbarProps {
  text: string;
  navigation?: AttachmentPreviewNavigationProps;
  onCopy?: (text: string) => void;
  onMoveToInput?: () => void;
  onDelete?: () => void;
  onClose?: () => void;
}

const toolbarButtonStyle = (active = false): React.CSSProperties => ({
  minWidth: 20,
  height: 20,
  padding: '0 3px',
  border: 0,
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  color: active ? '#86efac' : 'var(--attachment-preview-action-color, #888)',
  background: 'var(--attachment-preview-action-bg, transparent)',
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'color 100ms ease, background-color 100ms ease, box-shadow 100ms ease',
});

/** Stable actions for both ordinary saved prompts and orange context updates.
 * Permanent removal is opt-in: only owners with a real deletion contract
 * expose the trash action. */
export const AttachmentPreviewToolbar: React.FC<AttachmentPreviewToolbarProps> = ({
  text,
  navigation,
  onCopy,
  onMoveToInput,
  onDelete,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);
  useEffect(() => {
    setCopied(false);
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, [text]);

  const run = (
    event: React.MouseEvent<HTMLButtonElement>,
    callback?: () => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    callback?.();
  };
  const copyText = () => {
    (onCopy || electronComposerClipboardAdapter.writeText)?.(text);
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, 900);
  };

  return (
    <>
      {navigation && <AttachmentPreviewNavigation {...navigation} />}
      {onMoveToInput && (
        <button
          type="button"
          className="attachment-preview-action-button"
          data-attachment-preview-move-to-input
          aria-label="Перенести в input"
          title="Перенести в input"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => run(event, onMoveToInput)}
          style={toolbarButtonStyle()}
        >
          <ArrowDownToLine size={12} aria-hidden />
        </button>
      )}
      <button
        type="button"
        className="attachment-preview-action-button"
        data-attachment-preview-copy
        aria-label="Копировать содержимое"
        title="Копировать"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => run(event, copyText)}
        style={toolbarButtonStyle(copied)}
      >
        {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
      </button>
      {onDelete && (
        <button
          type="button"
          className="attachment-preview-action-button attachment-preview-action-button-danger"
          data-attachment-preview-delete
          aria-label="Удалить полностью"
          title="Удалить полностью"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => run(event, onDelete)}
          style={toolbarButtonStyle()}
        >
          <Trash2 size={12} aria-hidden />
        </button>
      )}
      {onClose && (
        <button
          type="button"
          className="attachment-preview-action-button"
          data-attachment-preview-close
          aria-label="Закрыть preview"
          title="Закрыть"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => run(event, onClose)}
          style={toolbarButtonStyle()}
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </>
  );
};

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
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {meta}
    </span>
    {children != null && (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flex: '0 0 auto' }}>
        {children}
      </span>
    )}
  </div>
);

/**
 * One expanded pasted-content surface for both a sent History message and the
 * live composer. Byte ownership stays with the host; this component owns the
 * stable header actions, character count and the single vertical scroll region.
 */
export const PastedContentPreview: React.FC<PastedContentPreviewProps> = ({
  text,
  body,
  maxHeight = 'min(360px, calc(100vh - 16px))',
  clampToViewport = true,
  className,
  style,
  onCopy,
  navigation,
  onMoveToInput,
  onDelete,
  onClose,
}) => {
  const [viewportMaxHeight, setViewportMaxHeight] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLElement | null>(null);

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

  // A sibling prompt replaces the body inside the same stable preview shell.
  // Start the new document at its beginning instead of inheriting scrollTop
  // from the previously opened prompt.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [text]);

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
        <AttachmentPreviewToolbar
          text={text}
          navigation={navigation}
          onCopy={onCopy}
          onMoveToInput={onMoveToInput}
          onDelete={onDelete}
          onClose={onClose}
        />
      </AttachmentPreviewBar>
      {body ? <div
        ref={(node) => { bodyRef.current = node; }}
        data-pasted-content-preview-body
        style={{ minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 10px' }}
      >{body}</div> : <pre
        ref={(node) => { bodyRef.current = node; }}
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
      </pre>}
    </div>
  );
};

export default PastedContentPreview;
