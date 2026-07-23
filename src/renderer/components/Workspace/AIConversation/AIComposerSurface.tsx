import React from 'react';
import { ArrowDownToLine, Trash2 } from 'lucide-react';
import {
  ComposerChip,
  ComposerFrame,
  type ComposerChipKind,
  type ComposerChipState,
  type ComposerDensity,
} from '@noted/claude-blocks';

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
  chips?: AIComposerSurfaceChip[];
  expandedChipId?: string | null;
  onExpandedChipChange?: (chipId: string | null) => void;
  input: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  overlay?: React.ReactNode;
  secondaryFontSize?: number;
}

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
  chips = [],
  expandedChipId = null,
  onExpandedChipChange,
  input,
  actions,
  footer,
  overlay,
  secondaryFontSize = 11,
}) => {
  const expandedChip = expandedChipId
    ? chips.find((chip) => chip.id === expandedChipId && chip.expandable !== false) || null
    : null;
  const hasTopLine = topBar != null || chips.length > 0;
  const secondaryStyle = {
    ['--ai-composer-secondary-font-size' as any]: `${secondaryFontSize}px`,
    ...style,
  } as React.CSSProperties;

  const preview = expandedChip?.text ? (
    <div
      data-ai-composer-chip-preview={expandedChip.id}
      style={{
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
        <span>{expandedChip.text.length.toLocaleString()} симв.</span>
      </div>
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
            overflowX: 'auto',
            overflowY: 'hidden',
            scrollbarWidth: 'none',
          }}
        >
          {chips.map((chip) => {
            const expandable = chip.expandable !== false && typeof chip.text === 'string';
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
                onClick={activate}
                trailing={(chip.onRestore || chip.onDiscard) ? (
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
    </div>
  ) : undefined;

  return (
    <ComposerFrame
      density={density}
      className={className}
      style={secondaryStyle}
      data-ai-composer-surface
      topBar={topLine}
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
