import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useRewindOperationStore } from '../../store/useRewindOperationStore';
import { useUIStore } from '../../store/useUIStore';
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
  const announcedSuccessIds = React.useRef(new Set<string>());
  React.useEffect(() => {
    const liveIds = new Set(views.map(view => view.id));
    for (const id of announcedSuccessIds.current) {
      if (!liveIds.has(id)) announcedSuccessIds.current.delete(id);
    }
    for (const view of views) {
      if (view.status !== 'done') continue;
      if (!announcedSuccessIds.current.has(view.id)) {
        announcedSuccessIds.current.add(view.id);
        // Reuse the common success-toast lifetime (2500ms), not a second,
        // indefinitely retained "ready" card. Visible owners already toast.
        if (!view.visible) useUIStore.getState().showToast(
          view.kind === 'delete' ? 'Удаление выполнено —' : 'Rewind выполнен —',
          'success', undefined, false, undefined, view.tabName,
          () => { void openHistoryOperationOwner(useWorkspaceStore.getState(), view.tabId); },
        );
      }
      // This registry is presentation only. Do not clear the native operation
      // store or let notification expiry change runtime/rewind authority.
      dismissHistoryOperationActivity(view.id);
    }
  }, [viewKey]);
  return <>{views.filter(view => !view.visible && view.status !== 'done').map(view => {
    const pending = view.status === 'running';
    const failed = view.status === 'failed';
    const label = view.kind === 'delete'
      ? (pending ? 'УДАЛЕНИЕ' : failed ? 'УДАЛЕНИЕ: ОШИБКА' : 'УДАЛЕНО')
      : (pending ? 'REWIND' : failed ? 'REWIND: ОШИБКА' : 'REWIND ГОТОВ');
    const dismiss = () => dismissHistoryOperationActivity(view.id);
    return <BackgroundTabOperationChip key={view.id} label={label} tabName={view.tabName}
      pending={pending} failed={failed} details={view.message || view.phase}
      onOpen={async event => {
        event.stopPropagation();
        await openHistoryOperationOwner(useWorkspaceStore.getState(), view.tabId);
      }}
      onDismiss={!pending && jsonl.some(op => op.id === view.id) ? dismiss : undefined} />;
  })}</>;
}
