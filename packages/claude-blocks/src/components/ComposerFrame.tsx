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
export type ComposerRuntimeAction = 'start' | 'stop' | 'pending' | 'none';

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
  /**
   * Keep the top line's height reserved while it is empty. Without it the whole
   * composer grows the moment a prompt chip appears and shrinks back when it is
   * removed, so the input jumps under the caret mid-typing. The row is a fixed
   * slot of the composer, not content that pushes layout around.
   */
  reserveTopBar?: boolean;
}

export const ComposerFrame: React.FC<ComposerFrameProps> = ({
  density = 'comfortable',
  topBar,
  chips,
  input,
  actions,
  overlay,
  footer,
  reserveTopBar = false,
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
    {(topBar != null || reserveTopBar) && (
      <div
        className={joinClasses(
          'cb-composer-topbar',
          reserveTopBar && 'cb-composer-topbar--reserved',
        )}
        data-composer-topbar-empty={topBar == null ? '' : undefined}
      >
        {topBar}
      </div>
    )}
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

export interface ComposerControlButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  tone?: string;
  size?: number;
  shape?: 'rounded' | 'circle';
}

/**
 * One square composer action shared by desktop hosts. It deliberately owns
 * only geometry and hover/focus feedback: the host still supplies the action,
 * disabled rules, icon and provider/runtime state.
 */
export const ComposerControlButton: React.FC<ComposerControlButtonProps> = ({
  active = false,
  tone = 'var(--cb-composer-control-tone, #c4b5fd)',
  size = 34,
  shape = 'rounded',
  className,
  style,
  type = 'button',
  children,
  ...props
}) => (
  <button
    {...props}
    type={type}
    className={joinClasses(
      'cb-composer-control',
      `cb-composer-control--${shape}`,
      active && 'cb-composer-control--active',
      className,
    )}
    data-composer-control-active={active ? 'true' : 'false'}
    style={{
      ['--cb-composer-control-size' as any]: `${size}px`,
      ['--cb-composer-control-tone' as any]: tone,
      ...style,
    }}
  >
    {children}
  </button>
);

export interface ComposerRuntimeControlProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  action?: ComposerRuntimeAction;
  icon: React.ReactNode;
  label?: React.ReactNode;
  busy?: boolean;
  tone?: string;
  copied?: boolean;
  compact?: boolean;
  containerClassName?: string;
  containerStyle?: React.CSSProperties;
}

/**
 * Stable runtime status + process action. The icon reports state at rest; only
 * hover reveals the destructive Stop square or Start triangle. This keeps
 * "what is happening" separate from "what this click will do" and avoids a
 * remembered React hover flag that can survive a remount under the pointer.
 */
export const ComposerRuntimeControl: React.FC<ComposerRuntimeControlProps> = ({
  action = 'none',
  icon,
  label,
  busy = false,
  tone = 'var(--cb-message-info, #60a5fa)',
  copied = false,
  compact = false,
  containerClassName,
  containerStyle,
  className,
  style,
  type = 'button',
  disabled,
  onClick,
  ...props
}) => {
  const blocked = disabled === true || action === 'pending' || action === 'none';
  return (
    <div
      className={joinClasses(
        'cb-composer-runtime',
        compact && 'cb-composer-runtime--compact',
        containerClassName,
      )}
      data-composer-runtime={busy ? 'busy' : 'idle'}
      style={{
        ['--cb-composer-runtime-tone' as any]: tone,
        ...containerStyle,
      }}
    >
      <button
        {...props}
        type={type}
        disabled={disabled}
        aria-disabled={blocked || undefined}
        data-agent-status-row
        data-agent-status-action={action}
        className={joinClasses('cb-composer-runtime-action', className)}
        style={style}
        onClick={(event) => {
          if (blocked) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
      >
        {action === 'stop' && (
          <span
            aria-hidden
            data-agent-status-hover-glyph
            data-agent-status-glyph="stop"
            className="cb-composer-runtime-stop"
          />
        )}
        {action === 'start' && (
          <svg
            aria-hidden
            data-agent-status-hover-glyph
            data-agent-status-glyph="start"
            className="cb-composer-runtime-start"
            viewBox="0 0 16 16"
          >
            <path d="M4.6 2.8 12.1 8l-7.5 5.2V2.8Z" fill="currentColor" />
          </svg>
        )}
        <span data-agent-status-idle-glyph className="cb-composer-runtime-idle">
          {busy ? <span className="cb-composer-runtime-spinner" aria-hidden /> : icon}
        </span>
      </button>
      {label != null && (
        <span
          className={joinClasses(
            'cb-composer-runtime-label',
            copied && 'cb-composer-runtime-label--copied',
          )}
        >
          {label}
        </span>
      )}
    </div>
  );
};
