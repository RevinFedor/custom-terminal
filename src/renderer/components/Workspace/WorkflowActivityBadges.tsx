import React from 'react';

export default function WorkflowActivityBadges({
  activeCount,
  busyCount,
  active,
}: {
  activeCount: number;
  busyCount: number;
  active: boolean;
}) {
  return (
    <>
      {activeCount > 0 && (
        <span
          data-workflow-active-count
          title={`Запущено вкладок: ${activeCount}`}
          className="relative flex items-center justify-center text-[10px] font-semibold rounded-full"
          style={{
            flexShrink: 0,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 999,
            backgroundColor: active ? 'rgba(74, 222, 128, 0.30)' : 'rgba(74, 222, 128, 0.20)',
            color: active ? '#86efac' : '#4ade80',
            boxSizing: 'border-box',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {activeCount}
        </span>
      )}
      {busyCount > 0 && (
        <span
          data-workflow-busy-count
          title={`Сейчас работают: ${busyCount}`}
          className="relative flex items-center justify-center text-[10px] font-semibold rounded-full"
          style={{
            flexShrink: 0,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 999,
            backgroundColor: active ? 'rgba(245, 158, 11, 0.28)' : 'rgba(245, 158, 11, 0.18)',
            color: active ? '#fbbf24' : '#f59e0b',
            boxSizing: 'border-box',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span
            className="noted-shape-ring absolute inset-0 rounded-full"
            style={{
              '--noted-ring-thickness': '2px',
              '--noted-ring-color': '#f59e0b',
              '--noted-ring-track': 'rgba(245, 158, 11, 0.20)',
            } as React.CSSProperties}
          />
          {busyCount}
        </span>
      )}
    </>
  );
}
