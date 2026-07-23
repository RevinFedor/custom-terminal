/* ============================================================
   @noted/claude-blocks — presentation-only conversation shells
   ------------------------------------------------------------
   These components own visual geometry only. They intentionally do not know
   how a prompt is sent, queued, rewound, copied, or persisted. A host keeps
   those runtime contracts and injects content/status/action slots.

   `ChatMessage` composes these shells for data-driven consumers. Runtime-
   driven consumers (assistant-ui, PTY History) can use the same shells inside
   their own roots without adapting their state to ChatEntry.
   ============================================================ */
import React from 'react';

export type ConversationMessageLayout =
  | 'user'
  | 'assistant'
  | 'end'
  | 'block'
  | 'system'
  | 'event';

export type ConversationTone =
  | 'default'
  | 'accent'
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';

export type MessageActionPlacement =
  | 'outside-start'
  | 'sticky-end'
  | 'footer';

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export interface ConversationMessageProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  layout: ConversationMessageLayout;
  tone?: ConversationTone;
  emphasis?: 'none' | 'editable';
  entryUuid?: string;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  columnClassName?: string;
  contentClassName?: string;
}

/**
 * One visual row. For `user`, the shell also owns the right-aligned column and
 * bubble. Other layouts keep content as a direct child so assistant-ui/tool
 * renderers can preserve their own DOM and focus contracts.
 */
export const ConversationMessage: React.FC<ConversationMessageProps> = ({
  layout,
  tone = 'default',
  emphasis = 'none',
  entryUuid,
  status,
  actions,
  footer,
  children,
  className,
  columnClassName,
  contentClassName,
  ...rootProps
}) => {
  const rowClass = joinClasses(
    'cb-row',
    layout === 'end' ? 'cb-row-end' : `cb-row-${layout}`,
    (layout === 'user' || layout === 'assistant') && 'group',
    'cb-message',
    `cb-message--${layout}`,
    tone !== 'default' && `cb-message--${tone}`,
    emphasis !== 'none' && `cb-message--${emphasis}`,
    className,
  );

  if (layout === 'user') {
    return (
      <div
        {...rootProps}
        className={rowClass}
        data-entry-uuid={entryUuid}
        data-message-layout={layout}
        data-message-tone={tone}
        data-message-emphasis={emphasis}
      >
        <div className={joinClasses('cb-user-col', columnClassName)}>
          {status}
          <div className={joinClasses('cb-user-bubble', contentClassName)}>
            {children}
          </div>
          {footer}
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div
      {...rootProps}
      className={rowClass}
      data-entry-uuid={entryUuid}
      data-message-layout={layout}
      data-message-tone={tone}
      data-message-emphasis={emphasis}
    >
      {status}
      {actions}
      {children}
      {footer}
    </div>
  );
};

export interface MessageStatusBadgeProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: React.ReactNode;
  tone?: Exclude<ConversationTone, 'default'> | 'neutral';
  pending?: boolean;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
}

/** A display-only badge. The host remains the source of truth for its phase. */
export const MessageStatusBadge: React.FC<MessageStatusBadgeProps> = ({
  label,
  tone = 'neutral',
  pending = false,
  icon,
  meta,
  className,
  ...props
}) => (
  <div
    {...props}
    className={joinClasses(
      'cb-message-status',
      `cb-message-status--${tone}`,
      pending && 'cb-message-status--pending',
      className,
    )}
    data-message-status-tone={tone}
    aria-live={pending ? 'polite' : undefined}
  >
    {pending && !icon && <span className="cb-message-status-spinner" aria-hidden />}
    {icon}
    <span className="cb-message-status-label">{label}</span>
    {meta != null && <span className="cb-message-status-meta">{meta}</span>}
  </div>
);

export interface MessageActionRailProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  placement?: MessageActionPlacement;
  children?: React.ReactNode;
  innerClassName?: string;
}

/**
 * Shared action geometry with arbitrary children. Copy/Repeat/Rewind remain
 * host callbacks, which lets Electron, assistant-ui, and browser consumers use
 * their own clipboard and lifecycle paths.
 */
export const MessageActionRail: React.FC<MessageActionRailProps> = ({
  placement = 'outside-start',
  children,
  className,
  innerClassName,
  ...props
}) => (
  <div
    {...props}
    className={joinClasses(
      'cb-message-actions',
      `cb-message-actions--${placement}`,
      placement === 'outside-start' && 'cb-msg-actions cb-msg-actions-user',
      className,
    )}
    data-message-actions-placement={placement}
  >
    <div
      className={joinClasses(
        'cb-message-actions-inner',
        placement === 'outside-start' && 'cb-msg-actions-inner',
        innerClassName,
      )}
    >
      {children}
    </div>
  </div>
);

export interface MessageActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'default' | 'warning' | 'danger';
}

export const MessageActionButton = React.forwardRef<
  HTMLButtonElement,
  MessageActionButtonProps
>(({ tone = 'default', className, type = 'button', ...props }, ref) => (
  <button
    {...props}
    ref={ref}
    type={type}
    className={joinClasses(
      'cb-msg-action-btn',
      'cb-message-action-button',
      tone !== 'default' && `cb-message-action-button--${tone}`,
      className,
    )}
  />
));
MessageActionButton.displayName = 'MessageActionButton';

export interface MessageEventProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: React.ReactNode;
  tone?: ConversationTone;
  pending?: boolean;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
  entryUuid?: string;
  children?: React.ReactNode;
}

/** Generic conversation event: fork, rewind, continued, context clear, etc. */
export const MessageEvent: React.FC<MessageEventProps> = ({
  label,
  tone = 'muted',
  pending = false,
  icon,
  meta,
  entryUuid,
  children,
  className,
  ...props
}) => (
  <ConversationMessage
    {...props}
    layout="event"
    tone={tone}
    entryUuid={entryUuid}
    className={className}
  >
    <div className="cb-message-event-card">
      <MessageStatusBadge
        label={label}
        tone={tone === 'default' ? 'neutral' : tone}
        pending={pending}
        icon={icon}
        meta={meta}
        className="cb-message-event-status"
      />
      {children != null && <div className="cb-message-event-body">{children}</div>}
    </div>
  </ConversationMessage>
);
