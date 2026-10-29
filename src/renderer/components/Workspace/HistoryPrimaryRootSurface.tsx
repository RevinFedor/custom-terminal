import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle, type VirtuosoProps } from 'react-virtuoso';
import { HistoryPrimaryRootReadModel } from '../../utils/historyPrimaryRootReadModel.mjs';
import { HISTORY_SURFACE_PRESENTATION_EVENT } from '../../utils/historyPresentationOwnership.mjs';
import { createHistoryPrimaryItemAdmission } from '../../utils/historyPrimaryItemAdmission.mjs';

interface Props extends Omit<VirtuosoProps<any, any>, 'data' | 'totalCount' | 'itemContent'> {
  primaryRoot: HistoryPrimaryRootReadModel | null;
  legacyData: any[];
  renderUnit: (index: number, unit: any) => React.ReactNode;
  rootRevision: number;
  presentationScope: { ownerKey: string; generation: number; visit: number; presented: boolean };
  presentationChannel?: string;
  presentationRef?: React.RefObject<{ presented: boolean; visit: number }>;
  captionSelections: () => [string, string][];
  onRootError: (error: unknown) => void;
  inputsCurrent: () => boolean;
  inputTransaction?: <T>(callback: () => T) => T;
  unitMatches: (index: number, unit: any) => boolean;
  onWindowCommit: (outcome: any) => void;
}

// The pinned list adapter publishes its ACTUAL committed list state after
// before-paint measurement. A React parent effect alone is not a new range.
export const HistoryPrimaryRootSurface = forwardRef<VirtuosoHandle, Props>(function HistoryPrimaryRootSurface({
  primaryRoot, legacyData, renderUnit, rootRevision, presentationScope: scopeSeed, presentationChannel, presentationRef, captionSelections, onRootError,
  inputsCurrent, inputTransaction = callback => callback(), unitMatches, onWindowCommit, rangeChanged, context, ...props
}, ref) {
  const [bodyRevision, repaint] = useState(0);
  const [presentationRevision, refreshPresentation] = useState(0);
  // The retained panel's prop is a mount-time seed. Its lightweight owner
  // updates this proof without rendering the heavy History panel.
  const proof = presentationRef?.current;
  const presentationScope = proof ? { ...scopeSeed, presented: proof.presented, visit: proof.visit } : scopeSeed;
  const connector = useRef<ReturnType<HistoryPrimaryRootReadModel['attachSurface']> | null>(null);
  const range = useRef({ startIndex: 0, endIndex: 0 });
  const committed = useRef<{snapshot: any; range: any} | null>(null);
  const callbacks = useRef({ onRootError, onWindowCommit, inputsCurrent, inputTransaction, unitMatches });
  callbacks.current = { onRootError, onWindowCommit, inputsCurrent, inputTransaction, unitMatches };
  // Capture a bounded shallow window map. Later async publications cannot make
  // a DOM placeholder count as a body rendered by this commit.
  const snapshot = useMemo(() => primaryRoot?.renderSnapshot() || null,[primaryRoot,rootRevision,bodyRevision]);
  const admission = useMemo(() => createHistoryPrimaryItemAdmission(primaryRoot, snapshot,
    (index: number, unit: any) => callbacks.current.inputsCurrent() === true
      && callbacks.current.unitMatches(index, unit)), [primaryRoot, snapshot]);
  const initial = props.initialTopMostItemIndex;
  const rawInitialIndex = typeof initial === 'number' ? initial : initial && 'index' in initial ? initial.index : undefined;
  const bootstrapIndex = snapshot?.totalCount
    ? rawInitialIndex === 'LAST' ? snapshot.totalCount - 1
      : Math.max(0,Math.min(snapshot.totalCount - 1,Number.isSafeInteger(rawInitialIndex) ? Number(rawInitialIndex) : 0))
    : 0;
  const diagnostic = useRef({lease:'',key:'',count:0,omitted:false});
  const stateRef = useRef<any>(null);
  stateRef.current = {snapshot,scope:presentationScope,bootstrapIndex,root:primaryRoot};
  useLayoutEffect(() => {
    if (!presentationChannel || !presentationRef) return;
    let active = true, pending = false;
    const sync = () => {
      if (pending) return;
      pending = true;
      // Parent and child consume the same presentation event. Read after all
      // listeners/layout effects have updated the owner's proof, not on a timer.
      queueMicrotask(() => {
        pending = false;
        if (!active) return;
        const next = presentationRef.current, current = stateRef.current?.scope;
        if (!current || current.presented === next.presented && current.visit === next.visit) return;
        connector.current?.dispose(); connector.current = null;
        refreshPresentation(value => value + 1);
      });
    };
    const onPresentation = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.channel !== presentationChannel || typeof detail.presented !== 'boolean') return;
      // Revoke the surface before a pending body request can publish after hide.
      if (!detail.presented) { connector.current?.dispose(); connector.current = null; }
      sync();
    };
    window.addEventListener(HISTORY_SURFACE_PRESENTATION_EVENT, onPresentation);
    sync();
    return () => { active = false; window.removeEventListener(HISTORY_SURFACE_PRESENTATION_EVENT, onPresentation); };
  }, [presentationChannel,presentationRef,scopeSeed.ownerKey,scopeSeed.generation]);
  const report = useCallback((stage:string,value?:any) => {
    try {
    const state=stateRef.current,root=state?.root,snap=state?.snapshot;
    if (!root || !snap) return;
    const lease=snap.header.leaseId;
    if(diagnostic.current.lease!==lease)diagnostic.current={lease,key:'',count:0,omitted:false};
    const fields={stage,closed:root.closed,presented:state.scope.presented,visit:state.scope.visit,
      snapshotCount:snap.totalCount,bodyUnits:snap.window.size,initialIndex:state.bootstrapIndex,
      actualCount:value?.totalCount ?? null,itemCount:value?.itemCount ?? null,stable:value?.stable ?? null};
    const key=JSON.stringify(fields);if(key===diagnostic.current.key)return;diagnostic.current.key=key;
    if(diagnostic.current.count++>=16){if(!diagnostic.current.omitted){diagnostic.current.omitted=true;root.windowDiagnostic('SURFACE_STATE_LIMIT',{limit:16});}return;}
    root.windowDiagnostic('SURFACE_STATE',fields);
    } catch { /* Diagnostic observers cannot change rendering or ownership. */ }
  },[]);
  useLayoutEffect(() => primaryRoot?.subscribe(() => repaint(version => version + 1)), [primaryRoot]);
  const runInputTransaction = useCallback(<T,>(callback: () => T): T =>
    callbacks.current.inputTransaction(callback), []);
  const applyCommit = useCallback((value: {snapshot:any; range:any}) => runInputTransaction(() => {
    const outcome = connector.current?.commit(value.snapshot,value.range,callbacks.current.unitMatches,callbacks.current.inputsCurrent);
    if (outcome?.status === 'covered') callbacks.current.onWindowCommit(outcome);
  }), [runInputTransaction]);
  useLayoutEffect(() => {
    if (!primaryRoot) return;
    const connected = primaryRoot.attachSurface(presentationScope);
    connector.current = connected;
    report('attach');
    connected.noteRange(range.current.startIndex,range.current.endIndex);
    if (committed.current) applyCommit(committed.current);
    return () => { connected.dispose(); if (connector.current === connected) connector.current = null; };
  }, [primaryRoot,presentationScope.ownerKey,presentationScope.generation,presentationScope.visit,presentationScope.presented,presentationRevision,applyCommit,report]);
  useLayoutEffect(() => {
    if (!snapshot || !presentationScope.presented || !primaryRoot) return;
    const connected=connector.current;
    if(!connected)return;
    report('bootstrap');
    // Fetch one exact initial unit even while Virtuoso still has its empty
    // probe state. The measured matching commit remains the only paint proof.
    void connected.bootstrapWindow(snapshot,bootstrapIndex,callbacks.current.inputsCurrent).then(outcome=>{
      if(connector.current===connected&&outcome.status==='failed')callbacks.current.onRootError(outcome.error);
    });
  },[primaryRoot,snapshot?.adoptionId,bootstrapIndex,presentationScope.presented,presentationScope.ownerKey,
    presentationScope.generation,presentationScope.visit,presentationRevision,report]);
  useEffect(() => {
    if (!primaryRoot) return;
    const unsubscribe = primaryRoot.subscribe(() => {
      if (primaryRoot.windowFailure) callbacks.current.onRootError(primaryRoot.windowFailure);
    });
    return unsubscribe;
  }, [primaryRoot]);
  const onRangeCommit = useCallback((value:any) => {
    if (!snapshot) return;
    report('commit',value);
    const current = committed.current = {snapshot,range:value};
    applyCommit(current);
  }, [snapshot,rootRevision,bodyRevision,applyCommit,report]);
  // The pinned Hn adapter consults this predicate BEFORE computeItemKey and
  // itemContent. The status-only shell is outside Virtuoso's measured-row
  // grammar: it has no data-index/data-item-index, UUID or physical row key.
  // An unseen scroll range may arrive synchronously at any time; the actual
  // committed range demands its addresses/bodies through the connector above.
  const renderPendingItem = useCallback((index: number, knownSize: number) => (
    <div key={'history-primary-pending:' + snapshot?.adoptionId + ':' + index}
      data-history-primary-pending="1" data-history-primary-pending-rank={index}
      data-history-primary-pending-reason={snapshot?.window.has(index) ? 'identity-mismatch' : 'body-not-read'}
      style={{ height: Number.isFinite(knownSize) && knownSize > 0 ? knownSize : 64,
        boxSizing:'border-box',overflow:'hidden',padding:'4px 0' }}>
      <span style={{ color:'#777',fontSize:11 }}>Загрузка строки…</span>
    </div>
  ), [snapshot]);
  const rootContext = useMemo(() => primaryRoot
    ? {...context,historyOnPrimaryWindowCommit:onRangeCommit,
      historyPrimaryItemAdmission:admission.admit,historyPrimaryPendingItem:renderPendingItem,
      historyPrimaryRenderTransaction:runInputTransaction}
    : context, [context,primaryRoot,onRangeCommit,admission,renderPendingItem,runInputTransaction]);
  const onRange = useCallback((value: typeof range.current) => {
    range.current = value;
    connector.current?.noteRange(value.startIndex,value.endIndex);
    rangeChanged?.(value);
  }, [rangeChanged]);
  // An explicitly selected primary owner without an adopted view is pending
  // (or closed), never a license to reconstruct rows from legacy metadata.
  if (primaryRoot && (!snapshot || primaryRoot.closed)) return (
    <div role="status" data-history-primary-root-state={primaryRoot.closed ? 'unavailable' : 'loading'}
      style={{ height:'100%',display:'flex',alignItems:'center',justifyContent:'center',color:'#777',fontSize:11 }}>
      {primaryRoot.closed ? 'История недоступна.' : 'Загрузка истории…'}
    </div>
  );
  return primaryRoot && snapshot ? (
    <Virtuoso {...props} data={undefined} context={rootContext} ref={ref} totalCount={snapshot.totalCount} rangeChanged={onRange}
      computeItemKey={admission.key}
      itemContent={index => {
        const unit = snapshot.window.get(index);
        // Fail visibly if an unpatched/drifted virtualizer bypasses admission.
        // A Promise or a rank-only substitute must never reach a real row.
        if (!admission.admit(index)) throw new Error('HISTORY_PRIMARY_CONTENT_NOT_ADMITTED');
        return renderUnit(index,unit);
      }} />
  ) : <Virtuoso {...props} context={context} ref={ref} data={legacyData} rangeChanged={rangeChanged} itemContent={renderUnit} />;
});
