/* ============================================================
   @noted/claude-blocks — presentation-only composer shells
   ------------------------------------------------------------
   The host supplies its real textarea/assistant-ui input and owns draft,
   attachments, queue, submit, rollback, and lifecycle. These components only
   keep the visual arrangement consistent across those runtimes.
   ============================================================ */
import React from 'react';

export type ComposerDensity = 'compact' | 'comfortable';
export type ComposerChipKind = 'prompt' | 'paste' | 'image' | 'queued' | 'stash';
export type ComposerChipState = 'idle' | 'pending' | 'sent' | 'error';

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export interface ComposerFrameProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  density?: ComposerDensity;
  topBar?: React.ReactNode;
  chips?: React.ReactNode;
  input: React.ReactNode;
  actions?: React.ReactNode;
  overlay?: React.ReactNode;
  footer?: React.ReactNode;
}

export const ComposerFrame: React.FC<ComposerFrameProps> = ({
  density = 'comfortable',
  topBar,
  chips,
  input,
  actions,
  overlay,
  footer,
  className,
  ...props
}) => (
  <div
    {...props}
    className={joinClasses(
      'cb-composer-frame',
      `cb-composer-frame--${density}`,
      className,
    )}
    data-composer-density={density}
  >
    {overlay != null && <div className="cb-composer-overlay">{overlay}</div>}
    {topBar != null && <div className="cb-composer-topbar">{topBar}</div>}
    {chips != null && <div className="cb-composer-chips">{chips}</div>}
    <div className="cb-composer-main">
      <div className="cb-composer-input-slot">{input}</div>
      {actions != null && <div className="cb-composer-actions">{actions}</div>}
    </div>
    {footer != null && <div className="cb-composer-footer">{footer}</div>}
  </div>
);

export interface ComposerChipProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'onClick'> {
  kind: ComposerChipKind;
  state?: ComposerChipState;
  label: React.ReactNode;
  preview?: React.ReactNode;
  meta?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
}

/**
 * The clickable body and independent trailing controls (restore/remove) are
 * siblings. This prevents a trailing action from also activating the chip and
 * avoids invalid nested-button markup.
 */
export const ComposerChip: React.FC<ComposerChipProps> = ({
  kind,
  state = 'idle',
  label,
  preview,
  meta,
  leading,
  trailing,
  onClick,
  disabled = false,
  className,
  ...props
}) => {
  const interactive = !!onClick && !disabled;
  const body = (
    <>
      {state === 'pending' && <span className="cb-composer-chip-spinner" aria-hidden />}
      {leading != null && <span className="cb-composer-chip-leading">{leading}</span>}
      <span className="cb-composer-chip-content">
        <span className="cb-composer-chip-label">{label}</span>
        {preview != null && <span className="cb-composer-chip-preview">{preview}</span>}
      </span>
      {meta != null && <span className="cb-composer-chip-meta">{meta}</span>}
    </>
  );

  return (
    <div
      {...props}
      className={joinClasses(
        'cb-composer-chip',
        `cb-composer-chip--${kind}`,
        `cb-composer-chip--${state}`,
        interactive && 'cb-composer-chip--interactive',
        disabled && 'cb-composer-chip--disabled',
        className,
      )}
      data-composer-chip-kind={kind}
      data-composer-chip-state={state}
      aria-disabled={disabled || undefined}
    >
      {onClick ? (
        <button
          type="button"
          className="cb-composer-chip-hit"
          disabled={disabled}
          onClick={onClick}
        >
          {body}
        </button>
      ) : (
        <span className="cb-composer-chip-hit">{body}</span>
      )}
      {trailing != null && <span className="cb-composer-chip-trailing">{trailing}</span>}
    </div>
  );
};
