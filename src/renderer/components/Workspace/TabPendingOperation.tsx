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
        data-tab-pending-operation-spinner
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          border: '1.5px solid rgba(138,138,138,0.25)',
          borderTopColor: '#8a8a8a',
          boxSizing: 'border-box',
          animation: 'tab-dot-spin 0.8s linear infinite',
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
