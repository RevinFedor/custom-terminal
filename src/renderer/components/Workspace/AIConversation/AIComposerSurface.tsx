import React from 'react';
import { ArrowDownToLine, Check, Copy, Loader2, Trash2 } from 'lucide-react';
import {
  ComposerChip,
  ComposerFrame,
  type ComposerChipKind,
  type ComposerChipState,
  type ComposerDensity,
} from '@noted/claude-blocks';
import { useUIStore } from '../../../store/useUIStore';
import {
  AttachmentPreviewBar,
  default as PastedContentPreview,
  type AttachmentPreviewNavigationProps,
} from './PastedContentPreview';
import { resolveComposerPromptPreviewNavigation } from '../../../utils/composerPromptPreviewNavigation.mjs';
import {
  copyManagedImageToElectronClipboard,
  electronComposerClipboardAdapter,
} from '../../../utils/electronComposerClipboardAdapter';

const TerminalHistoryStreamIcon: React.FC<{ active: boolean }> = ({ active }) => (
  <svg
    viewBox="0 0 20 20"
    width={15}
    height={15}
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M2.75 5.25h5.5M2.75 9h7.5M2.75 12.75h5.5"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
    />
    <path
      d="M11.2 6.15c1.65.58 2.8 2.06 2.8 3.85s-1.15 3.27-2.8 3.85M13.35 3.7c2.65 1.1 4.4 3.45 4.4 6.3s-1.75 5.2-4.4 6.3"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      opacity={active ? 1 : 0.42}
    />
    <circle cx="10" cy="10" r="1.35" fill="currentColor" />
    {!active && (
      <path
        d="M3.1 3.1l13.8 13.8"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
    )}
  </svg>
);

export interface AIComposerSurfaceChip {
  id: string;
  kind: ComposerChipKind;
  label: React.ReactNode;
  text?: string;
  state?: ComposerChipState;
  disabled?: boolean;
  className?: string;
  meta?: React.ReactNode;
  collapsedPreview?: React.ReactNode;
  /** Rich body shown in the same expanded area used by pasted text. */
  expandedPreview?: React.ReactNode;
  /** Right-hand metadata in the expanded preview header. */
  previewMeta?: React.ReactNode;
  /** Validated image preview plus copy metadata for the shared image card. */
  imagePreview?: AIComposerImageAttachmentPreviewProps;
  expandable?: boolean;
  onActivate?: () => void;
  onRestore?: () => void;
  onDiscard?: () => void;
}

interface AIComposerSurfaceProps {
  density?: ComposerDensity;
  className?: string;
  style?: React.CSSProperties;
  topBar?: React.ReactNode;
  // Pinned to the far end of the top line, opposite topBar. Hosts controls that
  // act on the surface itself rather than on the draft, so they never mix into
  // the status/chip cluster growing from the left.
  topBarTrailing?: React.ReactNode;
  chips?: AIComposerSurfaceChip[];
  /**
   * Chips the consumer renders itself (inline paste blobs inside the input) but
   * whose expanded content still belongs in this surface's single preview area.
   * Without them the expand target would be unfindable and clicking such a chip
   * would silently do nothing.
   */
  externalExpandableChips?: AIComposerSurfaceChip[];
  expandedChipId?: string | null;
  onExpandedChipChange?: (chipId: string | null) => void;
  /** Optional host order when prompt-like chips live outside this component. */
  promptPreviewNavigation?: AttachmentPreviewNavigationProps;
  /** Persistent authoring notice rendered directly above the input. */
  notice?: React.ReactNode;
  input: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  overlay?: React.ReactNode;
  secondaryFontSize?: number;
}

export interface AIComposerImagePreviewProps {
  src?: string;
  alt?: string;
  loading?: boolean;
  error?: string | null;
  style?: React.CSSProperties;
}

export const AIComposerImagePreview: React.FC<AIComposerImagePreviewProps> = ({
  src,
  alt = 'Attached image preview',
  loading = false,
  error = null,
  style,
}) => (
  <div
    data-ai-composer-image-preview
    data-preview-state={src ? 'ready' : error ? 'error' : loading ? 'loading' : 'unavailable'}
    style={{
      minHeight: 72,
      padding: 8,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: error ? '#f59e0b' : '#777',
      background: 'radial-gradient(circle at center, rgba(255,255,255,0.035), transparent 68%)',
      textAlign: 'center',
      ...style,
    }}
  >
    {src ? (
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{
          display: 'block',
          maxWidth: '100%',
          maxHeight: 'min(420px, 54vh)',
          width: 'auto',
          height: 'auto',
          objectFit: 'contain',
          borderRadius: 4,
          userSelect: 'none',
        }}
      />
    ) : error ? (
      <span>Image preview unavailable: {error}</span>
    ) : loading ? (
      <Loader2 size={18} className="animate-spin" aria-label="Загрузка изображения" />
    ) : (
      <span>Image preview unavailable</span>
    )}
  </div>
);

export interface AIComposerImageAttachmentPreviewProps extends AIComposerImagePreviewProps {
  assetId?: string;
  path?: string;
  size?: number;
  maxHeight?: React.CSSProperties['maxHeight'];
  className?: string;
  cardStyle?: React.CSSProperties;
}

const formatAttachmentBytes = (value?: number): string => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Размер неизвестен';
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
};

/** One stable image card for sent History and the live composer. Its body owns
 * a fixed preview slot, so async image decode never moves the portal. */
export const AIComposerImageAttachmentPreview: React.FC<AIComposerImageAttachmentPreviewProps> = ({
  src,
  alt,
  loading,
  error,
  assetId,
  path,
  size,
  maxHeight = 'min(360px, calc(100vh - 16px))',
  className,
  cardStyle,
}) => {
  const [copied, setCopied] = React.useState<'image' | 'path' | null>(null);
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);
  const markCopied = (kind: 'image' | 'path') => {
    setCopied(kind);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(null);
    }, 900);
  };
  const actionStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: 0,
    border: 0,
    color: active ? '#86efac' : '#888',
    background: 'transparent',
    font: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.38 : 1,
  });
  const canCopyImage = !!(assetId || path || src);
  const copyImage = async () => {
    const copiedImage = await copyManagedImageToElectronClipboard({
      assetId,
      path,
      fallbackDataUrl: src,
    });
    if (!copiedImage) return;
    markCopied('image');
  };
  const copyPath = () => {
    if (!path) return;
    electronComposerClipboardAdapter.writeText?.(path);
    markCopied('path');
  };

  return (
    <div
      className={className}
      data-ai-composer-image-attachment-preview
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 'min(440px, 100%)',
        maxWidth: '100%',
        maxHeight,
        minHeight: 0,
        overflow: 'hidden',
        border: '1px solid #333',
        borderRadius: 10,
        background: '#151515',
        boxSizing: 'border-box',
        ...cardStyle,
      }}
    >
      <AttachmentPreviewBar meta={formatAttachmentBytes(size)}>
        <button
          type="button"
          aria-label="Копировать изображение в буфер"
          disabled={!canCopyImage}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copyImage(); }}
          style={actionStyle(copied === 'image', !canCopyImage)}
        >
          {copied === 'image' ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
          <span>Буфер</span>
        </button>
        <button
          type="button"
          aria-label="Копировать путь изображения"
          disabled={!path}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); copyPath(); }}
          style={actionStyle(copied === 'path', !path)}
        >
          {copied === 'path' ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
          <span>Путь</span>
        </button>
      </AttachmentPreviewBar>
      <AIComposerImagePreview
        src={src}
        alt={alt}
        loading={loading}
        error={error}
        style={{
          flex: '0 0 auto',
          width: '100%',
          height: 'min(280px, 40vh)',
          minHeight: 'min(220px, 32vh)',
          overflow: 'auto',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
};

/**
 * Shared desktop presentation for AI composers.
 *
 * The host still owns draft state, send/queue/rollback, lifecycle and its real
 * textarea. This component only owns the common status/chip geometry and the
 * non-layout preview surface above the input.
 */
export const AIComposerSurface: React.FC<AIComposerSurfaceProps> = ({
  density = 'comfortable',
  className,
  style,
  topBar,
  topBarTrailing,
  chips = [],
  externalExpandableChips = [],
  expandedChipId = null,
  onExpandedChipChange,
  promptPreviewNavigation,
  notice,
  input,
  actions,
  footer,
  overlay,
  secondaryFontSize = 11,
}) => {
  const terminalHistoryStreamingEnabled = useUIStore(
    (state) => state.terminalHistoryStreamingEnabled,
  );
  const setTerminalHistoryStreamingEnabled = useUIStore(
    (state) => state.setTerminalHistoryStreamingEnabled,
  );
  const expandedChip = expandedChipId
    ? [...chips, ...externalExpandableChips].find(
      (chip) => chip.id === expandedChipId && chip.expandable !== false,
    ) || null
    : null;
  const resolvedPromptPreviewNavigation = resolveComposerPromptPreviewNavigation(
    [...chips, ...externalExpandableChips],
    expandedChipId,
  );
  const defaultAttachmentPreviewNavigation = expandedChip?.kind === 'prompt'
    && resolvedPromptPreviewNavigation
    && onExpandedChipChange
      ? {
          onPrevious: resolvedPromptPreviewNavigation.previousId
            ? () => onExpandedChipChange(resolvedPromptPreviewNavigation.previousId)
            : undefined,
          onNext: resolvedPromptPreviewNavigation.nextId
            ? () => onExpandedChipChange(resolvedPromptPreviewNavigation.nextId)
            : undefined,
        }
      : undefined;
  const attachmentPreviewNavigation = expandedChip?.kind === 'prompt'
    ? promptPreviewNavigation || defaultAttachmentPreviewNavigation
    : undefined;
  const hasTopLine = true;
  const secondaryStyle = {
    ['--ai-composer-secondary-font-size' as any]: `${secondaryFontSize}px`,
    ...style,
  } as React.CSSProperties;

  const hasExpandedPreview = !!expandedChip && (
    typeof expandedChip.text === 'string'
    || expandedChip.expandedPreview != null
    || expandedChip.imagePreview != null
  );
  const expandedPreviewMeta = expandedChip?.previewMeta ?? (
    typeof expandedChip?.text === 'string'
      ? `${expandedChip.text.length.toLocaleString()} симв.`
      : null
  );
  const isImagePreview = expandedChip?.kind === 'image';
  const isTextAttachmentPreview = (
    expandedChip?.kind === 'paste' || expandedChip?.kind === 'prompt'
  )
    && typeof expandedChip.text === 'string';
  const preview = hasExpandedPreview && expandedChip && isTextAttachmentPreview ? (
    <PastedContentPreview
      text={expandedChip.text as string}
      navigation={attachmentPreviewNavigation}
      onMoveToInput={expandedChip.kind === 'prompt' ? expandedChip.onRestore : undefined}
      onDelete={expandedChip.kind === 'paste' ? expandedChip.onDiscard : undefined}
      onClose={expandedChip.kind === 'prompt' && onExpandedChipChange
        ? () => onExpandedChipChange(null)
        : undefined}
      maxHeight="min(320px, 48vh)"
      style={{
        marginBottom: 6,
        boxShadow: '0 14px 34px rgba(0,0,0,0.48)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: secondaryFontSize,
      }}
    />
  ) : hasExpandedPreview && expandedChip?.imagePreview ? (
    <AIComposerImageAttachmentPreview
      {...expandedChip.imagePreview}
      cardStyle={{
        marginBottom: 6,
        boxShadow: '0 14px 34px rgba(0,0,0,0.48)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: secondaryFontSize,
        ...expandedChip.imagePreview.cardStyle,
      }}
    />
  ) : hasExpandedPreview && expandedChip ? (
    <div
      data-ai-composer-chip-preview={expandedChip.id}
      data-ai-composer-preview-kind={expandedChip.kind}
      style={{
        // Text benefits from the full composer width. An image does not: a
        // narrow card at the left keeps the draft visible and avoids turning
        // a portrait screenshot into a wall-sized overlay.
        width: isImagePreview ? 'min(440px, calc(100% - 12px))' : '100%',
        maxWidth: '100%',
        maxHeight: 'min(320px, 48vh)',
        overflow: 'auto',
        marginBottom: 6,
        border: '1px solid #333',
        borderRadius: 8,
        background: '#151515',
        boxShadow: '0 14px 34px rgba(0,0,0,0.48)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: secondaryFontSize,
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '5px 8px',
          color: '#888',
          background: '#1a1a1a',
          borderBottom: '1px solid #2d2d2d',
          fontSize: Math.max(8, secondaryFontSize - 1),
        }}
      >
        <span>{expandedChip.label}</span>
        {expandedPreviewMeta != null && <span>{expandedPreviewMeta}</span>}
      </div>
      {typeof expandedChip.text === 'string' ? (
        <pre
          style={{
            margin: 0,
            padding: 8,
            color: '#bdbdbd',
            font: 'inherit',
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {expandedChip.text}
        </pre>
      ) : expandedChip.expandedPreview}
    </div>
  ) : null;

  const topLine = hasTopLine ? (
    <div
      data-ai-composer-top-line
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        width: '100%',
        // Fixed slot height. The status control is ~22px while a prompt chip
        // with its border is taller, so adding the first chip used to grow the
        // whole composer and shove the input down under the caret. The row now
        // reserves the taller of the two and never resizes.
        height: 24,
        flex: '0 0 auto',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: secondaryFontSize,
      }}
    >
      {topBar}
      {topBar != null && chips.length > 0 && (
        <span
          aria-hidden
          style={{
            width: 1,
            height: 17,
            flex: '0 0 auto',
            background: 'rgba(255,255,255,0.13)',
          }}
        />
      )}
      {chips.length > 0 && (
        <div
          data-ai-composer-chip-strip
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            minWidth: 0,
            // Chips scroll sideways inside the fixed row instead of wrapping:
            // a second line would defeat the reserved height above.
            flexWrap: 'nowrap',
            height: '100%',
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
          }}
        >
          {chips.map((chip) => {
            const expandable = chip.expandable !== false && (
              typeof chip.text === 'string'
              || chip.expandedPreview != null
              || chip.imagePreview != null
            );
            const activate = chip.onActivate || (
              expandable && onExpandedChipChange
                ? () => onExpandedChipChange(expandedChipId === chip.id ? null : chip.id)
                : undefined
            );
            return (
              <ComposerChip
                key={chip.id}
                kind={chip.kind}
                state={chip.state}
                label={chip.label}
                preview={chip.collapsedPreview}
                meta={chip.meta}
                disabled={chip.disabled}
                className={chip.className}
                onMouseDown={(event) => {
                  if (chip.kind !== 'prompt' || !chip.onDiscard || event.button !== 1) return;
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onAuxClick={(event) => {
                  if (chip.kind !== 'prompt' || !chip.onDiscard || event.button !== 1) return;
                  event.preventDefault();
                  event.stopPropagation();
                  chip.onDiscard();
                }}
                onClick={activate}
                trailing={chip.kind !== 'prompt' && (chip.onRestore || chip.onDiscard) ? (
                  <>
                    {chip.onRestore && (
                      <button
                        type="button"
                        className="ai-composer-chip-action"
                        aria-label="Вернуть чип в текст"
                        title="Вернуть в текст"
                        style={{
                          width: 18,
                          height: 18,
                          padding: 0,
                          border: 0,
                          borderRadius: 4,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#8b8b8b',
                          background: 'transparent',
                          cursor: 'pointer',
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          chip.onRestore?.();
                        }}
                      >
                        <ArrowDownToLine size={11} />
                      </button>
                    )}
                    {chip.onDiscard && (
                      <button
                        type="button"
                        className="ai-composer-chip-action ai-composer-chip-action-danger"
                        aria-label="Удалить чип"
                        title="Удалить"
                        style={{
                          width: 18,
                          height: 18,
                          padding: 0,
                          border: 0,
                          borderRadius: 4,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#8b8b8b',
                          background: 'transparent',
                          cursor: 'pointer',
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          chip.onDiscard?.();
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </>
                ) : undefined}
              />
            );
          })}
        </div>
      )}
      <span aria-hidden style={{ flex: 1, minWidth: 4 }} />
      <div
        data-ai-composer-top-trailing
        style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' }}
      >
        <button
          type="button"
          data-terminal-history-streaming={terminalHistoryStreamingEnabled ? 'active' : 'inactive'}
          aria-label={terminalHistoryStreamingEnabled
            ? 'Отключить streaming из терминала в History'
            : 'Включить streaming из терминала в History'}
          aria-pressed={terminalHistoryStreamingEnabled}
          title={terminalHistoryStreamingEnabled
            ? 'Terminal streaming → History: включён'
            : 'Terminal streaming → History: выключен'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setTerminalHistoryStreamingEnabled(!terminalHistoryStreamingEnabled)}
          style={{
            width: 22,
            height: 22,
            padding: 0,
            borderRadius: 6,
            border: terminalHistoryStreamingEnabled
              ? '1px solid rgba(167, 139, 250, 0.48)'
              : '1px solid rgba(255, 255, 255, 0.12)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: terminalHistoryStreamingEnabled ? '#c4b5fd' : '#666',
            background: terminalHistoryStreamingEnabled
              ? 'rgba(109, 40, 217, 0.18)'
              : 'rgba(255, 255, 255, 0.025)',
            boxShadow: terminalHistoryStreamingEnabled
              ? 'inset 0 0 0 1px rgba(196, 181, 253, 0.05), 0 0 9px rgba(124, 58, 237, 0.16)'
              : 'none',
            cursor: 'pointer',
            flex: '0 0 auto',
          }}
        >
          <TerminalHistoryStreamIcon active={terminalHistoryStreamingEnabled} />
        </button>
        {topBarTrailing}
      </div>
    </div>
  ) : undefined;

  return (
    <ComposerFrame
      density={density}
      className={className}
      style={secondaryStyle}
      data-ai-composer-surface
      topBar={topLine}
      chips={notice}
      overlay={(
        <>
          {overlay}
          {preview}
        </>
      )}
      input={input}
      actions={actions}
      footer={footer}
    />
  );
};

export default AIComposerSurface;
