import React from 'react';
import { useTabCompletionNotificationDismissing } from './TabSignals';

export default function WorkflowActivityBadges({
  activeCount,
  busyCount,
  inheritedBusyCount = 0,
  awaitingCount,
  nonblockingQuestionCount = 0,
  completionNotificationCount,
}: {
  activeCount: number;
  busyCount: number;
  inheritedBusyCount?: number;
  awaitingCount: number;
  nonblockingQuestionCount?: number;
  completionNotificationCount: number;
  active: boolean;
}) {
  const hasCompletionNotification = completionNotificationCount > 0;
  const completionDismissing = useTabCompletionNotificationDismissing(hasCompletionNotification);
  return (
    <>
      {nonblockingQuestionCount > 0 && awaitingCount === 0 && <span
        data-workflow-codex-question-ring aria-hidden
        className="tab-codex-question-ring noted-infinite-animation" style={{ zIndex: 3 }}/>
      }
      {awaitingCount > 0 && (
        <span
          data-workflow-awaiting-ring
          className="tab-awaiting-input absolute inset-0 rounded"
          style={{ zIndex: 3 }}
          aria-hidden
        />
      )}
      {(hasCompletionNotification || completionDismissing) && (
        <span
          data-workflow-completion-ring
          data-workflow-completion-count={completionNotificationCount || undefined}
          title={`Готовых уведомлений: ${completionNotificationCount}`}
          className={`tab-completion-notification-alert absolute inset-0 rounded ${
            completionDismissing && !hasCompletionNotification
              ? 'tab-completion-notification-alert--dismiss'
              : ''
          }`}
          style={{ zIndex: 4 }}
          aria-hidden
        />
      )}
      {(activeCount > 0 || inheritedBusyCount > 0 || busyCount > 0) && <span
        data-workflow-activity-counts
        style={{ position: 'absolute', top: 0, right: 0, transform: 'translateY(-50%)',
          display: 'inline-flex', alignItems: 'center', gap: 2, zIndex: 5,
          fontSize: 'max(10px, 0.9em)', lineHeight: 1, fontWeight: 500, fontVariantNumeric: 'tabular-nums',
          // Text alone straddles the grey/black boundary; no pill or border.
          textShadow: '0 1px 1px rgba(0,0,0,0.75)' }}>
        {activeCount > 0 && <span data-workflow-active-count title={`Свободные запущенные вкладки: ${activeCount}`}
          style={{ color: '#4ade80' }}>{activeCount}</span>}
        {inheritedBusyCount > 0 && <span data-workflow-inherited-count title={`Ожидают дочерних исполнителей: ${inheritedBusyCount}`}
          style={{ color: '#9b6dff' }}>{inheritedBusyCount}</span>}
        {busyCount > 0 && <span data-workflow-busy-count title={`Сейчас работают: ${busyCount}`}
          style={{ color: '#f59e0b' }}>{busyCount}</span>}
      </span>}
    </>
  );
}
