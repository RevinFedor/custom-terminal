import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useRewindOperationStore } from '../../store/useRewindOperationStore';
import { getHistoryOperationActivities, subscribeHistoryOperationActivities,
  dismissHistoryOperationActivity, historyOperationOwnerView, openHistoryOperationOwner,
} from '../../utils/historyOperationActivity.mjs';
import BackgroundTabOperationChip from './BackgroundTabOperationChip';

export default function HistoryOperationBackgroundStatus() {
  const jsonl = React.useSyncExternalStore(subscribeHistoryOperationActivities,
    getHistoryOperationActivities, getHistoryOperationActivities);
  // Native Rewind already has a tab/op-owned store. Read it, do not invent a
  // second timer/event observer which could declare the operation finished.
  const native = useRewindOperationStore(state => state.operationsByKey);
  const operations = [...jsonl, ...Object.values(native).map(op => ({
    id: op.opId, tabId: op.tabId, kind: 'rewind', phase: op.phase,
    status: op.phase === 'done' ? 'done' : 'running', message: op.message,
  }))];
  const viewKey = useWorkspaceStore(state => JSON.stringify(operations.map(op => ({
    ...op, ...historyOperationOwnerView(state, op.tabId),
  }))));
  const views = React.useMemo(() => JSON.parse(viewKey), [viewKey]);
  React.useEffect(() => {
    for (const view of views) {
      if (view.visible && view.status !== 'running') dismissHistoryOperationActivity(view.id);
    }
  }, [viewKey]);
  return <>{views.filter(view => !view.visible).map(view => {
    const pending = view.status === 'running';
    const failed = view.status === 'failed';
    const label = view.kind === 'delete'
      ? (pending ? 'УДАЛЕНИЕ' : failed ? 'УДАЛЕНИЕ: ОШИБКА' : 'УДАЛЕНО')
      : (pending ? 'REWIND' : failed ? 'REWIND: ОШИБКА' : 'REWIND ГОТОВ');
    const dismiss = () => dismissHistoryOperationActivity(view.id);
    return <BackgroundTabOperationChip key={view.id} label={label} tabName={view.tabName}
      pending={pending} failed={failed} details={view.message || view.phase}
      onOpen={event => {
        event.stopPropagation();
        if (openHistoryOperationOwner(useWorkspaceStore.getState(), view.tabId) && !pending) dismiss();
      }}
      onDismiss={!pending && jsonl.some(op => op.id === view.id) ? dismiss : undefined} />;
  })}</>;
}
