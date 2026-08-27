import React from 'react';

export function resolveTabPendingOperationLabel({
  aiClosing,
  pendingOperation,
}: {
  aiClosing?: boolean;
  pendingOperation?: string;
}): string | null {
  if (aiClosing) return 'остановка сессии...';
  return pendingOperation || null;
}

/** One transient-operation mark shared by every physical surface of a tab. */
export default function TabPendingOperation({
  label,
  tabName,
}: {
  label: string;
  tabName: string;
}) {
  return (
    <>
      <span
        aria-hidden
        data-tab-pending-operation-indicator
        style={{
          width: 8,
          height: 8,
          borderRadius: 2,
          background: '#f59e0b',
          boxShadow: '0 0 0 1px rgba(245,158,11,0.22)',
          boxSizing: 'border-box',
          animation: 'none',
          flexShrink: 0,
        }}
      />
      <span
        data-tab-pending-operation
        title={tabName}
        style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {label}
      </span>
    </>
  );
}
