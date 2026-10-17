import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {createPortal} from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import { Check, ChevronDown, ChevronRight, Database, HardDrive, RefreshCw, Shield, Trash2, X } from 'lucide-react';
import ControlHint from '../UI/ControlHint';
import './Home.css';
import Tooltip from '../UI/Tooltip';
import { useUIStore } from '../../store/useUIStore';
import { storageCleanupIncident } from '../../utils/storageCleanupIncident.mjs';
import {
  RETENTION_DAY_OPTIONS,
  STORAGE_GROUPS,
  STORAGE_PROVIDER_FILTERS,
  STORAGE_SECTIONS,
  formatDeleteCountdown,
  formatStorageBytes,
  formatStorageDate,
  selectStorageItems,
  storageSelectableIds,
  storageSelectionRangeIds,
  storageRetentionKey,
  summarizeStorageGroups,
} from '../../utils/storageBrowserModel.mjs';

const { ipcRenderer } = window.require('electron');

type ProviderFilter = 'all' | 'codex' | 'claude';
type StorageSection = 'sessions' | 'builds' | 'app' | 'test-runs';
type StorageSort = 'size' | 'date' | 'iterations';
type StorageSortDirection = 'asc' | 'desc';

interface StorageItem {
  id: string;
  deletionRevision?: string;
  section: StorageSection;
  group: string;
  provider: 'codex' | 'claude' | null;
  sessionId: string | null;
  title: string;
  project: string;
  cwd: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  createdAt: number;
  closedAt?: number | null;
  deleteAfter?: number | null;
  retentionDays?: number | null;
  unprotectedSince?: number | null;
  graceDeleteAfter?: number | null;
  iterations?: number | null;
  notedTerminal: boolean;
  forkMode?: string | null;
  parentSessionId?: string | null;
  protected: boolean;
  protectedReason?: string | null;
  deletable: boolean;
  eligible: boolean;
  affectedItems?: number;
  affectedBytes?: number;
  environments?: string[];
}

interface StorageInventory {
  success: boolean;
  generation: string;
  scannedAt: number;
  settings: {
    enabled: boolean;
    provider: ProviderFilter;
    gracePeriodHours?: number;
    retentionDays: Record<string, number | null>;
  };
  summary: {
    totalBytes: number;
    reclaimableBytes: number;
    eligibleBytes: number;
    protectedBytes: number;
    totalItems: number;
    sessionItems: number;
    codexItems: number;
    claudeItems: number;
  };
  items: StorageItem[];
  closedTabs?: { ready: number };
  testRuns?: { complete: boolean; warnings: {root: string; reason: string}[] };
  error?: string;
}

interface DeleteConfirmation {
  mode: 'selected' | 'eligible';
  itemIds: string[];
  items: number;
  bytes: number;
  confirmationToken: string;
  generation: string;
}

// Dashboard itself is intentionally allowed to unmount. Keep one bounded
// metadata snapshot outside the component so Home → Workspace → Home paints the
// same table immediately instead of replaying the initial scan. Transcript
// payloads/details are not stored here; those remain explicit per-row reads.
let storageInventoryCache: StorageInventory | null = null;

const sectionIcon = (section: StorageSection) => (
  section === 'sessions' ? <HardDrive size={14} /> : section === 'builds' ? <Database size={14} /> : <Database size={14} />
);

export default function StorageBrowser({detailsHost=null}:{detailsHost?:HTMLElement|null}={}) {
  const showToast = useUIStore((state) => state.showToast);
  const expanded = useUIStore((state) => state.storageBrowserExpanded);
  const setExpanded = useUIStore((state) => state.setStorageBrowserExpanded);
  const [inventory, setInventory] = useState<StorageInventory | null>(() => storageInventoryCache);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<StorageSection>('sessions');
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [group, setGroup] = useState<string | null>(null);
  const [deletableOnly, setDeletableOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState<StorageSort>('size');
  const [sortDirection, setSortDirection] = useState<StorageSortDirection>('desc');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);
  const [detailsById, setDetailsById] = useState<Map<string, { totalIterations?: number; branchLength?: number }>>(() => new Map());
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<DeleteConfirmation | null>(null);
  const [confirmationPreparing, setConfirmationPreparing] = useState(false);
  const confirmationPreparationSeqRef = useRef(0);
  const [deleting, setDeleting] = useState(false);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const retentionSettingsBusyRef = useRef(false);
  const [graceHoursDraft, setGraceHoursDraft] = useState('24');
  const [deleteProgress, setDeleteProgress] = useState<{ completed: number; total: number; removed: number; failed: number } | null>(null);
  const activeDeleteOperationRef = useRef<string | null>(null);

  useEffect(() => {
    setGraceHoursDraft(String(inventory?.settings.gracePeriodHours ?? 24));
  }, [inventory?.settings.gracePeriodHours]);

  useEffect(() => {
    const onProgress = (_event: unknown, payload: any) => {
      if (!payload || payload.operationId !== activeDeleteOperationRef.current) return;
      setDeleteProgress({
        completed: Number(payload.completed) || 0,
        total: Number(payload.total) || 0,
        removed: Number(payload.removed) || 0,
        failed: Number(payload.failed) || 0,
      });
    };
    ipcRenderer.on('storage:delete-progress', onProgress);
    return () => ipcRenderer.removeListener('storage:delete-progress', onProgress);
  }, []);

  const loadInventory = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipcRenderer.invoke('storage:get-inventory', { force });
      if (result?.success !== true) throw new Error(result?.error || 'Storage scan failed');
      storageInventoryCache = result;
      setInventory(result);
    } catch (cause: any) {
      setError(cause?.message || String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (expanded && !inventory && !loading) void loadInventory(false);
  }, [expanded, inventory, loading, loadInventory]);

  const groupSummaries = useMemo(() => (
    summarizeStorageGroups(inventory?.items || [], section, provider)
  ), [inventory?.items, provider, section]);

  useEffect(() => {
    if (group && !groupSummaries.some((summary: any) => summary.group === group)) setGroup(null);
  }, [group, groupSummaries]);

  const visibleItems = useMemo(() => selectStorageItems(inventory?.items || [], {
    section,
    provider,
    group,
    query,
    dateFrom,
    dateTo,
    sort,
    sortDirection,
    deletableOnly,
  }), [dateFrom, dateTo, deletableOnly, group, inventory?.items, provider, query, section, sort, sortDirection]);

  const selectableVisibleIds = useMemo(() => storageSelectableIds(visibleItems), [visibleItems]);
  const allVisibleChecked = selectableVisibleIds.length > 0
    && selectableVisibleIds.every((id: string) => checkedIds.has(id));
  const someVisibleChecked = selectableVisibleIds.some((id: string) => checkedIds.has(id));

  const checkedItems = useMemo(() => (
    (inventory?.items || []).filter((item) => checkedIds.has(item.id) && item.deletable && !item.protected)
  ), [checkedIds, inventory?.items]);
  const checkedBytes = useMemo(() => (
    checkedItems.reduce((sum, item) => sum + item.sizeBytes, 0)
  ), [checkedItems]);

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = someVisibleChecked && !allVisibleChecked;
    }
  }, [allVisibleChecked, someVisibleChecked]);

  useEffect(() => {
    confirmationPreparationSeqRef.current += 1;
    setConfirmationPreparing(false);
    setCheckedIds(new Set());
    selectionAnchorRef.current = null;
    setConfirmation(null);
  }, [dateFrom, dateTo, deletableOnly, group, provider, query, section]);

  useEffect(() => {
    if (!inventory) return;
    const valid = new Set(inventory.items.filter((item) => item.deletable && !item.protected).map((item) => item.id));
    setCheckedIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
    if (selectionAnchorRef.current && !valid.has(selectionAnchorRef.current)) selectionAnchorRef.current = null;
  }, [inventory]);

  useEffect(() => {
    if (!selectedId) return;
    if (!visibleItems.some((item: StorageItem) => item.id === selectedId)) setSelectedId(null);
  }, [selectedId, visibleItems]);

  const selected = visibleItems.find((item: StorageItem) => item.id === selectedId) || null;
  const selectedDetails = selected ? detailsById.get(selected.id) : null;

  useEffect(() => {
    if (!selected?.sessionId || selected.iterations != null || detailsById.has(selected.id)) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setDetailLoadingId(selected.id);
      const result = await ipcRenderer.invoke('storage:get-session-details', {
        sessionId: selected.sessionId,
        cwd: selected.cwd || undefined,
      }).catch(() => null);
      if (!cancelled && result?.success === true) {
        setDetailsById((current) => new Map(current).set(selected.id, {
          totalIterations: result.totalIterations,
          branchLength: result.branchLength,
        }));
      }
      if (!cancelled) setDetailLoadingId(null);
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [detailsById, selected]);

  const updateRetention = async (storageGroup: string, value: number | null) => {
    if (!inventory || retentionSettingsBusyRef.current) return;
    const key = storageRetentionKey({ section, group: storageGroup });
    const settings = {
      ...inventory.settings,
      retentionDays: { ...inventory.settings.retentionDays, [key]: value },
    };
    await saveRetentionSettings(settings);
  };

  const saveRetentionSettings = async (settings: StorageInventory['settings']) => {
    if (retentionSettingsBusyRef.current) return;
    retentionSettingsBusyRef.current = true;
    setRetentionSaving(true);
    try {
      const result = await ipcRenderer.invoke('storage:set-settings', settings);
      if (result?.success !== true) throw new Error(result?.error || 'Could not save storage retention');
      setInventory((current) => current ? { ...current, settings: result.settings } : current);
      await loadInventory(true);
    } catch (cause: any) {
      showToast(cause?.message || 'Could not save storage retention', 'error', 5000);
      setGraceHoursDraft(String(inventory?.settings.gracePeriodHours ?? 24));
    } finally {
      retentionSettingsBusyRef.current = false;
      setRetentionSaving(false);
    }
  };

  const updateGraceHours = async () => {
    if (!inventory || retentionSettingsBusyRef.current) return;
    const hours = Number(graceHoursDraft);
    if (!Number.isInteger(hours) || hours < 1 || hours > 87600) {
      setGraceHoursDraft(String(inventory.settings.gracePeriodHours ?? 24));
      showToast('Enter a whole number of hours between 1 and 87600', 'warning', 4000);
      return;
    }
    if (hours === (inventory.settings.gracePeriodHours ?? 24)) return;
    await saveRetentionSettings({ ...inventory.settings, gracePeriodHours: hours });
  };

  const toggleRetention = async () => {
    if (!inventory || retentionSettingsBusyRef.current) return;
    await saveRetentionSettings({
      ...inventory.settings,
      enabled: !inventory.settings.enabled,
    });
  };

  const eligibleItems = useMemo(() => (inventory?.items || []).filter((item) => item.eligible), [inventory?.items]);

  const reportStorageFailure = (phase: string, result: any, itemIds: string[] = [], operationId: string | null = null, generation = inventory?.generation) => {
    const incident = storageCleanupIncident({
      phase, result, operationId, generation,
      items: (inventory?.items || []).filter((item) => itemIds.includes(item.id)),
    });
    showToast(incident.message, incident.type, 0, true, incident.report);
  };

  const prepareDeleteConfirmation = async (mode: DeleteConfirmation['mode'], itemIds: string[]) => {
    if (!inventory || itemIds.length === 0 || confirmationPreparing) return;
    const preparationSeq = ++confirmationPreparationSeqRef.current;
    setConfirmationPreparing(true);
    setConfirmation(null);
    try {
      const selectedItems = inventory.items.filter((item) => itemIds.includes(item.id));
      const result = await ipcRenderer.invoke('storage:prepare-delete', {
        itemIds,
        generation: inventory.generation,
        ...(selectedItems.every((item) => item.deletionRevision)
          ? { itemRevisions: Object.fromEntries(selectedItems.map((item) => [item.id, item.deletionRevision])) }
          : {}),
      });
      if (confirmationPreparationSeqRef.current !== preparationSeq) return;
      if (result?.error === 'storage_scan_stale') {
        reportStorageFailure('prepare-delete', result, itemIds);
        await loadInventory(true);
        return;
      }
      if (result?.error === 'storage_production_authority_unavailable') {
        reportStorageFailure('prepare-delete', { ...result, detail: 'Deletion blocked: this development instance cannot verify the production session database.' }, itemIds);
        return;
      }
      if (result?.success !== true || !result?.confirmationToken) {
        reportStorageFailure('prepare-delete', result, itemIds);
        return;
      }
      setConfirmation({
        mode,
        itemIds,
        items: Number(result.affectedItems) || itemIds.length,
        bytes: Number(result.affectedBytes) || 0,
        confirmationToken: result.confirmationToken,
        generation: result.generation || inventory.generation,
      });
    } catch (cause: any) {
      if (confirmationPreparationSeqRef.current === preparationSeq) {
        reportStorageFailure('prepare-delete', { error: 'storage_preparation_failed', detail: cause?.message }, itemIds);
      }
    } finally {
      if (confirmationPreparationSeqRef.current === preparationSeq) setConfirmationPreparing(false);
    }
  };

  const confirmSelectedDelete = () => {
    if (!selected?.deletable) return;
    void prepareDeleteConfirmation('selected', [selected.id]);
  };

  const confirmCheckedDelete = () => {
    if (checkedItems.length === 0) return;
    void prepareDeleteConfirmation('selected', checkedItems.map((item) => item.id));
  };

  const toggleCheckedItem = (item: StorageItem, shiftKey: boolean) => {
    if (!item.deletable || item.protected) return;
    confirmationPreparationSeqRef.current += 1;
    setConfirmationPreparing(false);
    setConfirmation(null);
    setSelectedId(item.id);
    setCheckedIds((current) => {
      const next = new Set(current);
      if (shiftKey && selectionAnchorRef.current) {
        for (const id of storageSelectionRangeIds(visibleItems, selectionAnchorRef.current, item.id)) next.add(id);
      } else if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
    if (!shiftKey || !selectionAnchorRef.current) selectionAnchorRef.current = item.id;
  };

  const toggleAllVisible = () => {
    if (selectableVisibleIds.length === 0) return;
    confirmationPreparationSeqRef.current += 1;
    setConfirmationPreparing(false);
    setConfirmation(null);
    setCheckedIds((current) => {
      const next = new Set(current);
      if (allVisibleChecked) {
        for (const id of selectableVisibleIds) next.delete(id);
      } else {
        for (const id of selectableVisibleIds) next.add(id);
      }
      return next;
    });
    selectionAnchorRef.current = selectableVisibleIds[0] || null;
  };

  const toggleColumnSort = (nextSort: Extract<StorageSort, 'date' | 'size'>) => {
    confirmationPreparationSeqRef.current += 1;
    setConfirmationPreparing(false);
    selectionAnchorRef.current = null;
    setConfirmation(null);
    if (sort === nextSort) {
      setSortDirection((current) => current === 'desc' ? 'asc' : 'desc');
      return;
    }
    setSort(nextSort);
    setSortDirection('desc');
  };

  const changeSort = (value: string) => {
    const [nextSort, nextDirection] = value.split(':') as [StorageSort, StorageSortDirection];
    confirmationPreparationSeqRef.current += 1;
    setConfirmationPreparing(false);
    selectionAnchorRef.current = null;
    setConfirmation(null);
    setSort(nextSort);
    setSortDirection(nextDirection);
  };

  const confirmEligibleDelete = () => {
    if (eligibleItems.length === 0) return;
    void prepareDeleteConfirmation('eligible', eligibleItems.map((item) => item.id));
  };

  const applyDelete = async () => {
    if (!confirmation || !inventory || activeDeleteOperationRef.current) return;
    const operationId = `storage-delete-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    activeDeleteOperationRef.current = operationId;
    setDeleteProgress({ completed: 0, total: confirmation.itemIds.length, removed: 0, failed: 0 });
    setDeleting(true);
    try {
      const result = await ipcRenderer.invoke('storage:delete-items', {
        itemIds: confirmation.itemIds,
        generation: confirmation.generation,
        operationId,
        confirmationToken: confirmation.confirmationToken,
      });
      if (result?.error === 'storage_scan_stale') {
        reportStorageFailure('delete-items', result, confirmation.itemIds, operationId, confirmation.generation);
      } else if (result?.error === 'storage_production_authority_unavailable') {
        reportStorageFailure('delete-items', { ...result, detail: 'Deletion blocked: this development instance cannot verify the production session database.' }, confirmation.itemIds, operationId, confirmation.generation);
      } else if (result?.success !== true && (!result?.removed || result.removed.length === 0)) {
        reportStorageFailure('delete-items', result, confirmation.itemIds, operationId, confirmation.generation);
      } else {
        const failed = result?.failures?.length || 0;
        showToast(
          `Deleted ${result?.removed?.length || 0} item${result?.removed?.length === 1 ? '' : 's'} · ${formatStorageBytes(result?.reclaimedBytes || 0)}${failed ? ` · ${failed} failed` : ''}`,
          failed ? 'warning' : 'success',
          failed ? 6500 : 3000,
          failed > 0,
          failed ? storageCleanupIncident({ phase: 'delete-items', result, operationId, generation: confirmation.generation, items: inventory.items.filter((item) => confirmation.itemIds.includes(item.id)) }).report : undefined,
        );
      }
      setConfirmation(null);
      setSelectedId(null);
      setCheckedIds(new Set());
      selectionAnchorRef.current = null;
      await loadInventory(true);
    } catch (cause: any) {
      reportStorageFailure('delete-items', { error: 'storage_delete_request_failed', detail: cause?.message }, confirmation.itemIds, operationId, confirmation.generation);
    } finally {
      activeDeleteOperationRef.current = null;
      setDeleteProgress(null);
      setDeleting(false);
    }
  };

  const copyPath = async () => {
    if (!selected?.path) return;
    const { clipboard } = window.require('electron');
    clipboard.writeText(selected.path);
    showToast('Path copied', 'success', 1200);
  };

  const totalLabel = inventory ? formatStorageBytes(inventory.summary.totalBytes) : '—';

  const details = <aside data-storage-details className="home-storage-details bg-white/[0.012] p-4">
                  {selected ? (
                    <>
                      <div className="truncate text-sm font-semibold text-[#ddd]">{selected.title}</div>
                      <div className="mt-1 break-all font-mono text-[9px] text-[#666]">{selected.sessionId || selected.id}</div>
                      <dl className="mt-4 grid grid-cols-[86px_minmax(0,1fr)] gap-x-2 gap-y-2 text-[11px]">
                        <dt className="text-[#666]">Size</dt><dd className="text-[#ccc]">{formatStorageBytes(selected.sizeBytes)}</dd>
                        <dt className="text-[#666]">Provider</dt><dd className="capitalize text-[#ccc]">{selected.provider || '—'}</dd>
                        <dt className="text-[#666]">Source</dt><dd className="text-[#ccc]">{selected.section === 'test-runs' ? 'Private test run' : selected.group === 'development' ? 'Development Noted Terminal' : selected.notedTerminal ? 'Noted Terminal' : 'Outside Noted Terminal'}</dd>
                        <dt className="text-[#666]">Directory</dt><dd className="break-words text-[#ccc]">{selected.cwd || selected.project || '—'}</dd>
                        <dt className="text-[#666]">Iterations</dt>
                        <dd className="text-[#ccc]">{selected.iterations ?? selectedDetails?.totalIterations ?? (detailLoadingId === selected.id ? 'Loading…' : '—')}</dd>
                        <dt className="text-[#666]">Created by</dt><dd className="text-[#ccc]">{STORAGE_GROUPS[selected.group]?.label || selected.group}</dd>
                        <dt className="text-[#666]">Parent</dt><dd className="break-all font-mono text-[9px] text-[#888]">{selected.parentSessionId || '—'}</dd>
                        <dt className="text-[#666]">Modified</dt><dd className="text-[#ccc]">{formatStorageDate(selected.modifiedAt)}</dd>
                        {selected.unprotectedSince && <><dt className="text-[#666]">Unprotected</dt><dd className="text-[#ccc]">{new Date(selected.unprotectedSince).toLocaleString('en')}</dd></>}
                        <dt className="text-[#666]">Retention</dt><dd className="text-[#ccc]">{selected.section === 'test-runs' ? 'Closed tabs: normal delay · whole profile kept' : selected.protected ? 'Never' : selected.section === 'builds' ? 'Manual cleanup' : formatDeleteCountdown(selected.deleteAfter)}</dd>
                      </dl>
                      <Tooltip content={selected.path} side="left">
                        <div className="mt-3 max-h-16 overflow-hidden break-all rounded border border-[#292929] bg-[#101010] p-2 font-mono text-[9px] text-[#777]">{selected.path}</div>
                      </Tooltip>
                      <div className={`mt-3 border-l-2 p-2 text-[10px] ${selected.protected ? 'border-[#555] bg-[#111] text-[#888]' : 'border-[#794325] bg-[#1c130e] text-[#b98260]'}`}>
                        {selected.protectedReason || (selected.section === 'builds' ? 'Can delete manually · no auto-delete' : `Deletable · ${formatDeleteCountdown(selected.deleteAfter)}`)}
                        {(selected.affectedItems || 1) > 1 && <div className="mt-1">Deleting this Codex thread also affects {selected.affectedItems} files · {formatStorageBytes(selected.affectedBytes || 0)}.</div>}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button type="button" className="h-7 rounded border border-[#333] px-2 text-[10px] text-[#aaa] hover:bg-white/[0.04]" onClick={() => void copyPath()}>Copy path</button>
                        <button
                          type="button"
                          data-storage-delete-selected
                          disabled={!selected.deletable || confirmationPreparing}
                          className="ml-auto flex h-7 items-center gap-1 rounded border border-red-500/25 px-2 text-[10px] text-red-300 disabled:cursor-not-allowed disabled:opacity-30"
                          onClick={confirmSelectedDelete}
                        >
                          {confirmationPreparing ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />} {confirmationPreparing ? 'Checking…' : 'Delete now'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-[#555]">Select an item</div>
                  )}
                </aside>;

  return (
    <section data-storage-browser className="home-storage border-y border-[#292929] py-3">
      <div className="home-storage-heading flex min-h-8 flex-wrap items-center gap-2">
        <button
          type="button"
          data-storage-toggle
          className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm text-[#aaa] transition-colors hover:bg-white/[0.03] hover:text-[#ddd]"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/[0.04] group-hover:bg-white/[0.08]">
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </span>
          <HardDrive size={14} className="text-[#f09018]" />
          <span className="font-medium">Storage</span>
          {inventory && <span className="text-xs tabular-nums text-[#777]">{totalLabel}</span>}
          {inventory && inventory.summary.eligibleBytes > 0 && (
            <span className="text-xs tabular-nums text-[#c27a42]">{formatStorageBytes(inventory.summary.eligibleBytes)} ready</span>
          )}
        </button>
        {expanded && (
          <>
            <ControlHint label="Rescan session files, build outputs, and Noted Terminal data" side="top">
              <button
                type="button"
                aria-label="Refresh storage"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#777] hover:bg-white/[0.05] hover:text-[#ddd]"
                onClick={() => void loadInventory(true)}
                disabled={loading}
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
            </ControlHint>
            {inventory && (
              <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
                <ControlHint label="Minimum wait after a session loses protection. Reopening resets the wait; group retention can keep it longer, and Never stays Never. Removing a window chip does not unprotect a saved tab." side="top">
                  <label className="flex items-center gap-1.5 text-[#888]">
                    <span>Auto-delete delay</span>
                    <input
                      data-storage-grace-hours
                      aria-label="Minimum hours after losing protection before auto-delete"
                      type="number" min={1} max={87600} step={1}
                      value={graceHoursDraft}
                      disabled={retentionSaving}
                      onChange={(event) => setGraceHoursDraft(event.target.value)}
                      onBlur={() => void updateGraceHours()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
                        if (event.key === 'Escape') {
                          setGraceHoursDraft(String(inventory.settings.gracePeriodHours ?? 24));
                          event.stopPropagation();
                        }
                      }}
                      className="h-6 w-16 rounded border border-[#3a3024] bg-[#171717] px-1.5 text-right tabular-nums text-[#d7aa75] outline-none focus:border-[#815a31] disabled:opacity-50"
                    />
                    <span>hours</span>
                  </label>
                </ControlHint>
                <button
                  type="button"
                  data-storage-auto-delete
                  disabled={retentionSaving}
                  className={`rounded-md border px-2.5 py-1 text-[11px] ${inventory.settings.enabled ? 'border-[#5d472d] bg-[#241b10] text-[#e6a45a]' : 'border-[#333] text-[#777]'}`}
                  onClick={() => void toggleRetention()}
                >
                  {retentionSaving && <RefreshCw size={10} className="mr-1 inline animate-spin" />}
                  Auto-delete {inventory.settings.enabled ? 'on' : 'off'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {expanded && (
        <div className="mt-3 overflow-hidden border-t border-[#292929]">
          {error ? (
            <div className="flex items-center gap-2 p-4 text-xs text-red-300">
              <X size={14} /> {error}
              <button className="ml-2 underline" onClick={() => void loadInventory(true)}>Retry</button>
            </div>
          ) : !inventory ? (
            <div className="flex h-28 items-center justify-center gap-2 text-xs text-[#666]">
              <RefreshCw size={14} className="animate-spin" /> Scanning storage…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-[#292929] bg-white/[0.012] px-1 py-2">
                {STORAGE_SECTIONS.map((entry: any) => (
                  <button
                    key={entry.id}
                    type="button"
                    data-storage-section={entry.id}
                    disabled={entry.id === 'test-runs' && !inventory.testRuns}
                    title={entry.id === 'test-runs' && !inventory.testRuns ? 'Requires an updated main process. The running application has not scanned test profiles.' : undefined}
                    className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs disabled:opacity-40 ${section === entry.id ? 'bg-[#2b2115] text-[#f0ae63]' : 'text-[#777] hover:bg-white/[0.04] hover:text-[#bbb]'}`}
                    onClick={() => { setSection(entry.id); setGroup(null); setSelectedId(null); }}
                  >
                    {sectionIcon(entry.id)} {entry.label}
                  </button>
                ))}
                {section === 'sessions' && (
                  <div className="ml-2 flex items-center rounded-md border border-[#2f2f2f] p-0.5">
                    {STORAGE_PROVIDER_FILTERS.map((entry: any) => (
                      <button
                        key={entry.id}
                        type="button"
                        data-storage-provider={entry.id}
                        className={`h-6 rounded px-2 text-[11px] ${provider === entry.id ? 'bg-[#2a2a2a] text-[#ddd]' : 'text-[#666] hover:text-[#aaa]'}`}
                        onClick={() => { setProvider(entry.id); setGroup(null); setSelectedId(null); }}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search name, UUID or directory"
                  className="ml-auto h-7 min-w-0 flex-1 basis-[220px] rounded-md border border-[#303030] bg-[#0d0d0d] px-2.5 text-xs text-[#ddd] outline-none focus:border-[#555]"
                />
                <select
                  value={`${sort}:${sortDirection}`}
                  onChange={(event) => changeSort(event.target.value)}
                  className="h-7 rounded-md border border-[#303030] bg-[#171717] px-2 text-[11px] text-[#999]"
                >
                  <option value="size:desc">Largest first</option>
                  <option value="size:asc">Smallest first</option>
                  <option value="date:desc">Newest first</option>
                  <option value="date:asc">Oldest first</option>
                  <option value="iterations:desc">Most iterations</option>
                </select>
                <label className="flex h-7 items-center gap-1.5 px-1 text-[11px] text-[#aaa]">
                  <input data-storage-deletable-only type="checkbox" checked={deletableOnly} onChange={(event) => setDeletableOnly(event.target.checked)} className="accent-[#d47b35]" />
                  Can delete only
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-4 border-b border-[#292929] px-2 py-2 text-[11px] text-[#888]">
                <span>{formatStorageBytes(groupSummaries.reduce((sum: number, entry: any) => sum + entry.bytes, 0))} total in this category</span>
                <span className="text-[#d19a61]">{formatStorageBytes(groupSummaries.reduce((sum: number, entry: any) => sum + entry.deletableBytes, 0))} can delete</span>
                <span>{formatStorageBytes(groupSummaries.reduce((sum: number, entry: any) => sum + entry.bytes - entry.deletableBytes, 0))} protected</span>
                {section === 'sessions' && <span>Open tabs keep their history protected, even when the agent is stopped.</span>}
                {section === 'builds' && <span>Generated build output. Cleanup is manual; the installed runtime is protected.</span>}
                {section === 'app' && <span>Application databases, backups and caches. Active data is protected.</span>}
                {section === 'test-runs' && <span>Private test instances, not your installed app. Closed tabs use the same delay inside their owning profile; the entire stand is not deleted automatically.</span>}
                {section === 'test-runs' && inventory.testRuns?.complete === false && <span className="text-amber-400">Partial scan · some test paths could not be measured</span>}
                {section === 'sessions' && !!inventory.closedTabs?.ready && <span>{inventory.closedTabs.ready} closed tabs ready to expire from History</span>}
              </div>

              {section === 'sessions' && (
                <div data-storage-date-filter className="flex min-h-10 flex-wrap items-center gap-2 border-b border-[#292929] bg-white/[0.008] px-2 py-1.5 text-[10px] text-[#777]">
                  <span className="mr-1 uppercase tracking-wide text-[#555]">Date range</span>
                  <label className="flex items-center gap-1.5">
                    <span>From</span>
                    <input
                      data-storage-date-from
                      type="date"
                      value={dateFrom}
                      max={dateTo || undefined}
                      onChange={(event) => setDateFrom(event.target.value)}
                      className="h-7 rounded border border-[#303030] bg-[#151515] px-2 text-[10px] text-[#aaa] outline-none focus:border-[#555]"
                      style={{ colorScheme: 'dark' }}
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span>To</span>
                    <input
                      data-storage-date-to
                      type="date"
                      value={dateTo}
                      min={dateFrom || undefined}
                      onChange={(event) => setDateTo(event.target.value)}
                      className="h-7 rounded border border-[#303030] bg-[#151515] px-2 text-[10px] text-[#aaa] outline-none focus:border-[#555]"
                      style={{ colorScheme: 'dark' }}
                    />
                  </label>
                  {(dateFrom || dateTo) && (
                    <button
                      type="button"
                      data-storage-date-clear
                      className="h-7 rounded px-2 text-[#777] hover:bg-white/[0.04] hover:text-[#bbb]"
                      onClick={() => { setDateFrom(''); setDateTo(''); }}
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    data-storage-select-all-filtered
                    disabled={selectableVisibleIds.length === 0}
                    className="ml-auto h-7 rounded border border-[#363636] px-2.5 text-[#999] hover:bg-white/[0.04] hover:text-[#ddd] disabled:opacity-40"
                    onClick={toggleAllVisible}
                  >
                    {allVisibleChecked ? 'Clear filtered selection' : `Select all ${selectableVisibleIds.length}`}
                  </button>
                  {checkedItems.length > 0 && (
                    <button
                      type="button"
                      data-storage-delete-checked
                      disabled={confirmationPreparing}
                      className="flex h-7 items-center gap-1 rounded border border-red-500/25 bg-red-500/[0.06] px-2.5 text-red-300 disabled:cursor-wait disabled:opacity-50"
                      onClick={confirmCheckedDelete}
                    >
                      {confirmationPreparing ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />} Delete selected · {checkedItems.length} · {formatStorageBytes(checkedBytes)}
                    </button>
                  )}
                </div>
              )}

              <div className="home-storage-layout">
                <aside data-storage-groups className="home-storage-groups bg-white/[0.008] py-2">
                  <button
                    type="button"
                    className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs ${group === null ? 'bg-[#282016] text-[#efb36f]' : 'text-[#888] hover:bg-white/[0.03]'}`}
                    onClick={() => setGroup(null)}
                  >
                    <span>All groups</span>
                    <span>{formatStorageBytes(groupSummaries.reduce((sum: number, entry: any) => sum + entry.bytes, 0))}</span>
                  </button>
                  {groupSummaries.map((summary: any) => {
                    const definition = STORAGE_GROUPS[summary.group] || { label: summary.group, description: summary.group };
                    const retentionKey = storageRetentionKey({ section, group: summary.group });
                    const retentionValue = inventory.settings.retentionDays[retentionKey] ?? null;
                    const groupHasDeletable = inventory.items.some((item) => (
                      item.section === section
                      && item.group === summary.group
                      && (section !== 'sessions' || provider === 'all' || item.provider === provider)
                      && item.deletable
                    ));
                    return (
                      <div key={summary.group} className={`mb-1 rounded-md border ${group === summary.group ? 'border-[#6b491f] bg-[#261b10]' : 'border-transparent hover:bg-white/[0.025]'}`}>
                        <ControlHint label={definition.description} modifiedAction={!groupHasDeletable ? 'Never auto-deleted' : section === 'builds' ? 'Manual cleanup only; Ready after controls Clean all ready' : `Auto-delete: ${retentionValue == null ? 'Never' : `${retentionValue} day${retentionValue === 1 ? '' : 's'}`}`} side="right">
                          <button
                            type="button"
                            data-storage-group={summary.group}
                            className={`flex w-full items-start justify-between gap-2 px-2 pb-1.5 pt-2 text-left text-xs ${group === summary.group ? 'text-[#efb36f]' : 'text-[#aaa]'}`}
                            onClick={() => setGroup(summary.group)}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{definition.label}</span>
                              <span className="mt-0.5 block text-[10px] text-[#666]">{summary.items} · {formatStorageBytes(summary.bytes)}</span>
                            </span>
                            {summary.deletableBytes > 0 && <span className="shrink-0 text-right text-[10px] text-[#b66f40]">{formatStorageBytes(summary.deletableBytes)}<span className="block text-[9px] text-[#777]">can delete</span></span>}
                          </button>
                        </ControlHint>
                        {groupHasDeletable && (
                          <div className="flex items-center gap-1 border-t border-white/[0.04] px-2 py-1.5">
                            <span className="text-[9px] uppercase tracking-wide text-[#555]">{section === 'builds' ? 'Ready after' : 'Delete after'}</span>
                            <select
                              value={retentionValue == null ? 'never' : String(retentionValue)}
                              onChange={(event) => void updateRetention(summary.group, event.target.value === 'never' ? null : Number(event.target.value))}
                              onClick={(event) => event.stopPropagation()}
                              disabled={retentionSaving}
                              className="ml-auto h-5 rounded border border-[#2e2e2e] bg-[#171717] px-1 text-[10px] text-[#888]"
                            >
                              {RETENTION_DAY_OPTIONS.map((option: any) => (
                                <option key={String(option.value)} value={option.value == null ? 'never' : String(option.value)}>{option.label}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        {groupHasDeletable && section === 'builds' && <div className="px-2 pb-1.5 text-[9px] text-[#777]">Manual cleanup · no auto-delete</div>}
                      </div>
                    );
                  })}
                </aside>

                <section data-storage-items className="home-storage-items min-w-0 bg-transparent">
                  <div className="home-storage-row grid h-8 items-center gap-2 border-b border-[#292929] bg-white/[0.008] px-3 text-[9px] uppercase tracking-wide text-[#555]" >
                    <input
                      ref={selectAllCheckboxRef}
                      data-storage-select-all-checkbox
                      type="checkbox"
                      aria-label={`Select all ${selectableVisibleIds.length} deletable filtered rows`}
                      checked={allVisibleChecked}
                      disabled={selectableVisibleIds.length === 0}
                      onChange={toggleAllVisible}
                      className="h-3.5 w-3.5 accent-[#d47b35]"
                    />
                    <span>Name</span>
                    <span>Source</span>
                    <button
                      type="button"
                      data-storage-sort-date
                      aria-label={`Sort by date, ${sort === 'date' ? `currently ${sortDirection === 'desc' ? 'newest first' : 'oldest first'}` : 'newest first'}`}
                      className={`flex h-full items-center gap-0.5 text-left hover:text-[#aaa] ${sort === 'date' ? 'text-[#c98758]' : ''}`}
                      onClick={() => toggleColumnSort('date')}
                    >
                      <span>Date</span>
                      {sort === 'date' && <ChevronDown size={10} className={sortDirection === 'asc' ? 'rotate-180' : ''} />}
                    </button>
                    <button
                      type="button"
                      data-storage-sort-size
                      aria-label={`Sort by size, ${sort === 'size' ? `currently ${sortDirection === 'desc' ? 'largest first' : 'smallest first'}` : 'largest first'}`}
                      className={`flex h-full items-center justify-end gap-0.5 text-right hover:text-[#aaa] ${sort === 'size' ? 'text-[#c98758]' : ''}`}
                      onClick={() => toggleColumnSort('size')}
                    >
                      {sort === 'size' && <ChevronDown size={10} className={sortDirection === 'asc' ? 'rotate-180' : ''} />}
                      <span>Size</span>
                    </button>
                    <span />
                  </div>
                  {visibleItems.length === 0 ? (
                    <div className="flex h-[390px] items-center justify-center text-xs text-[#555]">No matching storage items</div>
                  ) : (
                    <Virtuoso
                      data-storage-virtual-list
                      style={{ height: 390 }}
                      data={visibleItems}
                      computeItemKey={(_index, item: StorageItem) => item.id}
                      itemContent={(_index, item: StorageItem) => {
                        const isSelected = item.id === selectedId;
                        const isChecked = checkedIds.has(item.id);
                        const source = item.section === 'sessions'
                          ? item.group === 'development' ? 'Dev' : item.notedTerminal ? 'Noted Terminal' : 'Outside'
                          : item.project;
                        return (
                          <div
                            role="button"
                            tabIndex={0}
                            data-storage-row={item.id}
                            className={`home-storage-row grid min-h-[49px] w-full items-center gap-2 border-b border-[#222] px-3 text-left text-xs ${isSelected ? 'bg-[#211a12] shadow-[inset_2px_0_#f09018]' : isChecked ? 'bg-[#1d1914]' : 'hover:bg-[#181818]'}`}
                            
                            onClick={() => {
                              confirmationPreparationSeqRef.current += 1;
                              setConfirmationPreparing(false);
                              setConfirmation(null);
                              setSelectedId(item.id);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return;
                              event.preventDefault();
                              confirmationPreparationSeqRef.current += 1;
                              setConfirmationPreparing(false);
                              setConfirmation(null);
                              setSelectedId(item.id);
                            }}
                          >
                            <input
                              type="checkbox"
                              data-storage-row-checkbox={item.id}
                              aria-label={`Select ${item.title}`}
                              checked={isChecked}
                              disabled={!item.deletable || item.protected}
                              onChange={() => {}}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleCheckedItem(item, event.shiftKey);
                              }}
                              className="h-3.5 w-3.5 accent-[#d47b35] disabled:opacity-30"
                            />
                            <span className="min-w-0">
                              <Tooltip content={item.path} side="top" interactive={false}>
                                <span className="block truncate font-medium text-[#d2d2d2]">{item.title}</span>
                              </Tooltip>
                              <span className="block truncate font-mono text-[9px] text-[#626262]">{item.sessionId || item.path}</span>
                            </span>
                            <span className="truncate text-[10px] text-[#888]">{source}</span>
                            <span className="text-[10px] text-[#777]">{formatStorageDate(item.modifiedAt)}</span>
                            <span className="text-right font-medium tabular-nums text-[#ccc]">{formatStorageBytes(item.sizeBytes)}</span>
                            <span className={item.protected ? 'text-[#666]' : 'text-[#b86b42]'}>{item.protected ? <Shield size={12} /> : <Trash2 size={12} />}</span>
                          </div>
                        );
                      }}
                    />
                  )}
                </section>

                {detailsHost?createPortal(details,detailsHost):details}
              </div>

              <div className="flex min-h-10 flex-wrap items-center gap-3 py-2 border-t border-[#292929] bg-white/[0.008] px-1 text-[10px] text-[#666]">
                <span>All categories: {inventory.summary.totalItems} items · {formatStorageBytes(inventory.summary.totalBytes)}</span>
                <span>{visibleItems.length} filtered</span>
                {checkedItems.length > 0 && <span className="text-[#c98758]">{checkedItems.length} selected · {formatStorageBytes(checkedBytes)}</span>}
                {checkedItems.length > 0 && section !== 'sessions' && (
                  <button type="button" data-storage-delete-checked disabled={confirmationPreparing || deleting} onClick={confirmCheckedDelete} className="flex h-7 items-center gap-1 rounded border border-red-500/25 px-2 text-red-300 disabled:opacity-40"><Trash2 size={11} /> Delete selected</button>
                )}
                {confirmationPreparing && <span className="flex items-center gap-1 text-[#c98758]"><RefreshCw size={10} className="animate-spin" /> Checking exact deletion scope…</span>}
                <span>{formatStorageBytes(inventory.summary.protectedBytes)} protected</span>
                <span>{formatStorageBytes(inventory.summary.reclaimableBytes)} can delete</span>
                {inventory.summary.eligibleBytes > 0 && (
                  <button
                    type="button"
                    data-storage-clean-ready
                    disabled={confirmationPreparing}
                    className="ml-auto flex h-7 items-center gap-1 rounded border border-[#74452c] bg-[#21150f] px-2.5 text-[#d18b5f] disabled:cursor-wait disabled:opacity-50"
                    onClick={confirmEligibleDelete}
                  >
                    {confirmationPreparing ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />} Clean all ready · {formatStorageBytes(inventory.summary.eligibleBytes)}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {confirmation && (
        <div data-storage-confirmation className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs text-[#bbb]">
          <Trash2 size={14} className="text-red-300" />
          <span>{deleting
            ? `Deleting ${deleteProgress?.completed || 0}/${deleteProgress?.total || confirmation.items} · removed ${deleteProgress?.removed || 0}${deleteProgress?.failed ? ` · failed ${deleteProgress.failed}` : ''}… keep Noted Terminal open`
            : `Delete ${confirmation.items} item${confirmation.items === 1 ? '' : 's'} · reclaim up to ${formatStorageBytes(confirmation.bytes)}?`}</span>
          <button type="button" data-storage-cancel-delete className="ml-auto flex h-7 items-center gap-1 rounded px-2 text-[#888] hover:bg-white/[0.04]" onClick={() => setConfirmation(null)} disabled={deleting}><X size={12} /> Cancel</button>
          <button type="button" data-storage-confirm-delete className="flex h-7 items-center gap-1 rounded bg-red-500/15 px-2 text-red-300" onClick={() => void applyDelete()} disabled={deleting}>
            {deleting ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />} {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
    </section>
  );
}
