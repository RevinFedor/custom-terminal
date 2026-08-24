import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Check, ChevronDown, ChevronRight, Database, HardDrive, RefreshCw, Shield, Trash2, X } from 'lucide-react';
import ControlHint from '../UI/ControlHint';
import Tooltip from '../UI/Tooltip';
import { useUIStore } from '../../store/useUIStore';
import {
  RETENTION_DAY_OPTIONS,
  STORAGE_GROUPS,
  STORAGE_PROVIDER_FILTERS,
  STORAGE_SECTIONS,
  formatDeleteCountdown,
  formatStorageBytes,
  formatStorageDate,
  selectStorageItems,
  storageRetentionKey,
  summarizeStorageGroups,
} from '../../utils/storageBrowserModel.mjs';

const { ipcRenderer } = window.require('electron');

type ProviderFilter = 'all' | 'codex' | 'claude';
type StorageSection = 'sessions' | 'builds' | 'app';

interface StorageItem {
  id: string;
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
}

interface StorageInventory {
  success: boolean;
  generation: string;
  scannedAt: number;
  settings: {
    enabled: boolean;
    provider: ProviderFilter;
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
  error?: string;
}

interface DeleteConfirmation {
  mode: 'selected' | 'eligible';
  itemIds: string[];
  items: number;
  bytes: number;
}

const sectionIcon = (section: StorageSection) => (
  section === 'sessions' ? <HardDrive size={14} /> : section === 'builds' ? <Database size={14} /> : <Database size={14} />
);

export default function StorageBrowser() {
  const showToast = useUIStore((state) => state.showToast);
  const [expanded, setExpanded] = useState(false);
  const [inventory, setInventory] = useState<StorageInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<StorageSection>('sessions');
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [group, setGroup] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'size' | 'date' | 'iterations'>('size');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailsById, setDetailsById] = useState<Map<string, { totalIterations?: number; branchLength?: number }>>(() => new Map());
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<DeleteConfirmation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadInventory = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipcRenderer.invoke('storage:get-inventory', { force });
      if (result?.success !== true) throw new Error(result?.error || 'Storage scan failed');
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
    sort,
  }), [group, inventory?.items, provider, query, section, sort]);

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
    if (!inventory) return;
    const key = storageRetentionKey({ section, group: storageGroup });
    const settings = {
      ...inventory.settings,
      retentionDays: { ...inventory.settings.retentionDays, [key]: value },
    };
    const result = await ipcRenderer.invoke('storage:set-settings', settings);
    if (result?.success !== true) {
      showToast(result?.error || 'Could not save storage retention', 'error', 5000);
      return;
    }
    setInventory((current) => current ? { ...current, settings: result.settings } : current);
    await loadInventory(true);
  };

  const toggleRetention = async () => {
    if (!inventory) return;
    const result = await ipcRenderer.invoke('storage:set-settings', {
      ...inventory.settings,
      enabled: !inventory.settings.enabled,
    });
    if (result?.success === true) await loadInventory(true);
  };

  const eligibleItems = useMemo(() => (inventory?.items || []).filter((item) => item.eligible), [inventory?.items]);

  const confirmSelectedDelete = () => {
    if (!selected?.deletable) return;
    setConfirmation({
      mode: 'selected',
      itemIds: [selected.id],
      items: selected.affectedItems || 1,
      bytes: selected.affectedBytes || selected.sizeBytes,
    });
  };

  const confirmEligibleDelete = () => {
    if (eligibleItems.length === 0) return;
    setConfirmation({
      mode: 'eligible',
      itemIds: eligibleItems.map((item) => item.id),
      items: eligibleItems.length,
      bytes: eligibleItems.reduce((sum, item) => sum + item.sizeBytes, 0),
    });
  };

  const applyDelete = async () => {
    if (!confirmation || !inventory) return;
    setDeleting(true);
    try {
      const result = await ipcRenderer.invoke('storage:delete-items', {
        itemIds: confirmation.itemIds,
        generation: inventory.generation,
      });
      if (result?.error === 'storage_scan_stale') {
        showToast('Storage changed during confirmation. Review the refreshed list.', 'warning', 5500);
      } else if (result?.success !== true && (!result?.removed || result.removed.length === 0)) {
        showToast(result?.failures?.[0]?.detail || result?.error || 'Storage cleanup failed', 'error', 7000, true);
      } else {
        const failed = result?.failures?.length || 0;
        showToast(
          `Deleted ${result?.removed?.length || 0} item${result?.removed?.length === 1 ? '' : 's'} · ${formatStorageBytes(result?.reclaimedBytes || 0)}${failed ? ` · ${failed} failed` : ''}`,
          failed ? 'warning' : 'success',
          failed ? 6500 : 3000,
        );
      }
      setConfirmation(null);
      setSelectedId(null);
      await loadInventory(true);
    } finally {
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

  return (
    <section data-storage-browser className="my-5 max-w-[1120px] border-y border-[#292929] py-3">
      <div className="flex min-h-8 items-center gap-2">
        <button
          type="button"
          className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm text-[#aaa] transition-colors hover:bg-white/[0.03] hover:text-[#ddd]"
          onClick={() => setExpanded((value) => !value)}
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
              <button
                type="button"
                className={`ml-auto rounded-md border px-2.5 py-1 text-[11px] ${inventory.settings.enabled ? 'border-[#5d472d] bg-[#241b10] text-[#e6a45a]' : 'border-[#333] text-[#777]'}`}
                onClick={() => void toggleRetention()}
              >
                Auto-delete {inventory.settings.enabled ? 'on' : 'off'}
              </button>
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
                    className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs ${section === entry.id ? 'bg-[#2b2115] text-[#f0ae63]' : 'text-[#777] hover:bg-white/[0.04] hover:text-[#bbb]'}`}
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
                  placeholder="Search name, UUID, project or path"
                  className="ml-auto h-7 min-w-[220px] flex-1 rounded-md border border-[#303030] bg-[#0d0d0d] px-2.5 text-xs text-[#ddd] outline-none focus:border-[#555]"
                />
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value as any)}
                  className="h-7 rounded-md border border-[#303030] bg-[#171717] px-2 text-[11px] text-[#999]"
                >
                  <option value="size">Largest first</option>
                  <option value="date">Newest first</option>
                  <option value="iterations">Most iterations</option>
                </select>
              </div>

              <div className="grid min-h-[430px]" style={{ gridTemplateColumns: '210px minmax(360px, 1fr) 310px' }}>
                <aside className="border-r border-[#292929] bg-white/[0.008] py-2 pr-2">
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
                        <ControlHint label={definition.description} modifiedAction={!groupHasDeletable ? 'Never auto-deleted' : `Auto-delete: ${retentionValue == null ? 'Never' : `${retentionValue} day${retentionValue === 1 ? '' : 's'}`}`} side="right">
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
                            {summary.eligibleBytes > 0 && <span className="text-[10px] text-[#b66f40]">{formatStorageBytes(summary.eligibleBytes)}</span>}
                          </button>
                        </ControlHint>
                        {groupHasDeletable && (
                          <div className="flex items-center gap-1 border-t border-white/[0.04] px-2 py-1.5">
                            <span className="text-[9px] uppercase tracking-wide text-[#555]">Delete after</span>
                            <select
                              value={retentionValue == null ? 'never' : String(retentionValue)}
                              onChange={(event) => void updateRetention(summary.group, event.target.value === 'never' ? null : Number(event.target.value))}
                              onClick={(event) => event.stopPropagation()}
                              className="ml-auto h-5 rounded border border-[#2e2e2e] bg-[#171717] px-1 text-[10px] text-[#888]"
                            >
                              {RETENTION_DAY_OPTIONS.map((option: any) => (
                                <option key={String(option.value)} value={option.value == null ? 'never' : String(option.value)}>{option.label}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </aside>

                <section className="min-w-0 bg-transparent">
                  <div className="grid h-8 items-center gap-2 border-b border-[#292929] bg-white/[0.008] px-3 text-[9px] uppercase tracking-wide text-[#555]" style={{ gridTemplateColumns: 'minmax(160px,1fr) 110px 74px 72px 18px' }}>
                    <span>Name</span><span>Source</span><span>Date</span><span className="text-right">Size</span><span />
                  </div>
                  {visibleItems.length === 0 ? (
                    <div className="flex h-[390px] items-center justify-center text-xs text-[#555]">No matching storage items</div>
                  ) : (
                    <Virtuoso
                      style={{ height: 390 }}
                      data={visibleItems}
                      computeItemKey={(_index, item: StorageItem) => item.id}
                      itemContent={(_index, item: StorageItem) => {
                        const isSelected = item.id === selectedId;
                        const source = item.section === 'sessions'
                          ? item.notedTerminal ? 'Noted Terminal' : 'Outside'
                          : item.project;
                        return (
                          <button
                            type="button"
                            className={`grid min-h-[49px] w-full items-center gap-2 border-b border-[#222] px-3 text-left text-xs ${isSelected ? 'bg-[#211a12] shadow-[inset_2px_0_#f09018]' : 'hover:bg-[#181818]'}`}
                            style={{ gridTemplateColumns: 'minmax(160px,1fr) 110px 74px 72px 18px' }}
                            onClick={() => setSelectedId(item.id)}
                          >
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
                          </button>
                        );
                      }}
                    />
                  )}
                </section>

                <aside className="border-l border-[#292929] bg-white/[0.012] p-4">
                  {selected ? (
                    <>
                      <div className="truncate text-sm font-semibold text-[#ddd]">{selected.title}</div>
                      <div className="mt-1 break-all font-mono text-[9px] text-[#666]">{selected.sessionId || selected.id}</div>
                      <dl className="mt-4 grid grid-cols-[86px_minmax(0,1fr)] gap-x-2 gap-y-2 text-[11px]">
                        <dt className="text-[#666]">Size</dt><dd className="text-[#ccc]">{formatStorageBytes(selected.sizeBytes)}</dd>
                        <dt className="text-[#666]">Provider</dt><dd className="capitalize text-[#ccc]">{selected.provider || '—'}</dd>
                        <dt className="text-[#666]">Source</dt><dd className="text-[#ccc]">{selected.notedTerminal ? 'Noted Terminal' : 'Outside Noted Terminal'}</dd>
                        <dt className="text-[#666]">Project / CWD</dt><dd className="break-words text-[#ccc]">{selected.project || selected.cwd || '—'}</dd>
                        <dt className="text-[#666]">Iterations</dt>
                        <dd className="text-[#ccc]">{selected.iterations ?? selectedDetails?.totalIterations ?? (detailLoadingId === selected.id ? 'Loading…' : '—')}</dd>
                        <dt className="text-[#666]">Created by</dt><dd className="text-[#ccc]">{STORAGE_GROUPS[selected.group]?.label || selected.group}</dd>
                        <dt className="text-[#666]">Parent</dt><dd className="break-all font-mono text-[9px] text-[#888]">{selected.parentSessionId || '—'}</dd>
                        <dt className="text-[#666]">Modified</dt><dd className="text-[#ccc]">{formatStorageDate(selected.modifiedAt)}</dd>
                        <dt className="text-[#666]">Retention</dt><dd className="text-[#ccc]">{selected.protected ? 'Never' : formatDeleteCountdown(selected.deleteAfter)}</dd>
                      </dl>
                      <Tooltip content={selected.path} side="left">
                        <div className="mt-3 max-h-16 overflow-hidden break-all rounded border border-[#292929] bg-[#101010] p-2 font-mono text-[9px] text-[#777]">{selected.path}</div>
                      </Tooltip>
                      <div className={`mt-3 border-l-2 p-2 text-[10px] ${selected.protected ? 'border-[#555] bg-[#111] text-[#888]' : 'border-[#794325] bg-[#1c130e] text-[#b98260]'}`}>
                        {selected.protectedReason || `Deletable · ${formatDeleteCountdown(selected.deleteAfter)}`}
                        {(selected.affectedItems || 1) > 1 && <div className="mt-1">Deleting this Codex thread also affects {selected.affectedItems} files · {formatStorageBytes(selected.affectedBytes || 0)}.</div>}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button type="button" className="h-7 rounded border border-[#333] px-2 text-[10px] text-[#aaa] hover:bg-white/[0.04]" onClick={() => void copyPath()}>Copy path</button>
                        <button
                          type="button"
                          data-storage-delete-selected
                          disabled={!selected.deletable}
                          className="ml-auto flex h-7 items-center gap-1 rounded border border-red-500/25 px-2 text-[10px] text-red-300 disabled:cursor-not-allowed disabled:opacity-30"
                          onClick={confirmSelectedDelete}
                        >
                          <Trash2 size={11} /> Delete now
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-[#555]">Select an item</div>
                  )}
                </aside>
              </div>

              <div className="flex min-h-10 items-center gap-3 border-t border-[#292929] bg-white/[0.008] px-1 text-[10px] text-[#666]">
                <span>{inventory.summary.totalItems} items · {formatStorageBytes(inventory.summary.totalBytes)}</span>
                <span>{formatStorageBytes(inventory.summary.protectedBytes)} protected</span>
                <span>{formatStorageBytes(inventory.summary.reclaimableBytes)} reclaimable</span>
                {inventory.summary.eligibleBytes > 0 && (
                  <button
                    type="button"
                    data-storage-clean-ready
                    className="ml-auto flex h-7 items-center gap-1 rounded border border-[#74452c] bg-[#21150f] px-2.5 text-[#d18b5f]"
                    onClick={confirmEligibleDelete}
                  >
                    <Trash2 size={11} /> Clean ready · {formatStorageBytes(inventory.summary.eligibleBytes)}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {confirmation && (
        <div className="mt-2 flex items-center gap-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs text-[#bbb]">
          <Trash2 size={14} className="text-red-300" />
          <span>Delete {confirmation.items} item{confirmation.items === 1 ? '' : 's'} · reclaim up to {formatStorageBytes(confirmation.bytes)}?</span>
          <button type="button" data-storage-cancel-delete className="ml-auto flex h-7 items-center gap-1 rounded px-2 text-[#888] hover:bg-white/[0.04]" onClick={() => setConfirmation(null)} disabled={deleting}><X size={12} /> Cancel</button>
          <button type="button" data-storage-confirm-delete className="flex h-7 items-center gap-1 rounded bg-red-500/15 px-2 text-red-300" onClick={() => void applyDelete()} disabled={deleting}>
            {deleting ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />} Delete
          </button>
        </div>
      )}
    </section>
  );
}
