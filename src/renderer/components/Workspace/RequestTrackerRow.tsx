import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

export const requestRowLinkStyle: CSSProperties = {
  minWidth: 0, height: '100%', padding: '0 4px 0 6px', display: 'flex',
  alignItems: 'center', gap: 5, flex: 1, border: 0, borderRadius: 3,
  background: 'transparent', textAlign: 'left', fontSize: 10, lineHeight: 1.3, cursor: 'pointer',
};

export const requestRowActionStyle: CSSProperties = {
  width: 24, height: 24, display: 'grid', placeItems: 'center', flexShrink: 0,
  padding: 0, border: 0, borderRadius: 3, background: 'transparent', color: '#999', cursor: 'pointer',
};

export function RequestTrackerStatus({ children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} data-request-status-slot style={{ width: 26, height: 14, display: 'flex',
    alignItems: 'center', justifyContent: 'center', gap: 2, flexShrink: 0 }}>{children}</span>;
}

export function RequestTrackerRow({ children, actions, style, ...props }: HTMLAttributes<HTMLDivElement> & { actions?: ReactNode }) {
  return <div {...props} data-request-row-header style={{ minWidth: 0, width: '100%', height: 26,
    display: 'flex', alignItems: 'center', boxSizing: 'border-box', flexShrink: 0, ...style }}>
    {children}
    <span data-request-row-actions style={{ width: 24, height: 24, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
      {actions}
    </span>
  </div>;
}
