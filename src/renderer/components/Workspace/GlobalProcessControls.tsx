import React, { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import {
  canStopObservedProcess, executeObservedProcessStops, freezeProcessStopTargets,
  processControlKey, processControlRows,
} from '../../utils/globalProcessControls.mjs';

const { ipcRenderer } = window.require('electron');
type ProcessRow = Record<string, any>;

// Mounted only inside an opened global menu. No ambient process inventory,
// extra per-tab polling, or retained hidden Home process list.
export default function GlobalProcessControls({ scope = 'agents' }: { scope?: 'agents' | 'mcp-orphans' | 'mcp' }) {
  const [rows, setRows] = useState<ProcessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<readonly ProcessRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const aliveRef = useRef(false);
  const sequenceRef = useRef(0);
  const busyRef = useRef(false);
  const readRef = useRef(0);
  const readInventory = () => ipcRenderer.invoke('system:get-dashboard-processes');

  const refresh = async () => {
    const read = ++readRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = processControlRows(await readInventory(), scope);
      if (aliveRef.current && read === readRef.current) setRows(next);
    } catch (cause: any) {
      if (aliveRef.current && read === readRef.current) setError(cause?.message || String(cause));
    } finally {
      if (aliveRef.current && read === readRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => { aliveRef.current = false; sequenceRef.current++; readRef.current++; };
  }, [scope]);

  const cancel = () => {
    if (busyRef.current) return;
    sequenceRef.current++;
    setConfirmation(null);
  };
  useEffect(() => {
    if (!confirmation) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); cancel();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [confirmation]);

  const choose = (targets: ProcessRow[], bulk = false) => {
    if (busyRef.current) return;
    const frozen = freezeProcessStopTargets(targets, bulk);
    if (!frozen.length) return;
    sequenceRef.current++;
    setOutcome(null);
    setConfirmation(frozen);
  };
  const findTab = (tabId: string) => {
    const state = useWorkspaceStore.getState();
    for (const [, workspace] of state.openProjects) {
      const tab = workspace.tabs.get(tabId);
      if (tab) return tab;
    }
    return null;
  };
  const apply = async () => {
    if (!confirmation || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const sequence = sequenceRef.current;
    const isCurrent = () => aliveRef.current && sequenceRef.current === sequence;
    try {
      const results = await executeObservedProcessStops(confirmation, {
        readInventory, invoke: (channel: string, payload: unknown) => ipcRenderer.invoke(channel, payload), findTab, isCurrent,
      });
      if (!isCurrent()) return;
      const failures = results.filter((result: any) => !result.success);
      const accepted = results.filter((result: any) => result.success).length;
      // Generic PID stop acknowledges the signal request; only some dedicated
      // Main paths wait for exit. Do not report every acknowledgement as exit.
      setOutcome(`${accepted} stop request${accepted === 1 ? '' : 's'} accepted${failures.length
        ? ' · ' + failures.map((result: any) => `PID ${result.pid}: ${result.error}`).join('; ') : ''}`);
      setConfirmation(null);
      await refresh();
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  const groups = scope === 'mcp-orphans' || scope==='mcp' ? ['mcp'] : ['claude', 'gemini', 'codex', 'electron'];
  return (
    <section data-global-process-controls={scope} className="border-t border-white/10 px-2 py-2 text-[11px] text-[#aaa]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium text-[#ddd]">{scope==='mcp'?'MCP processes':scope === 'mcp-orphans' ? 'Orphan MCP processes' : 'Process controls'}</span>
        <button type="button" data-process-refresh disabled={busy || loading} onClick={() => void refresh()}
          className="rounded border border-white/10 px-2 py-1 disabled:opacity-40">Refresh</button>
      </div>
      {loading && <div role="status">Reading processes…</div>}
      {error && <div role="alert" className="break-words text-red-300">{error}</div>}
      {outcome && <div data-process-outcome role="status" className="mb-2 break-words">{outcome}</div>}
      {groups.map(provider => {
        const items = rows.filter(row => row.provider === provider);
        if (!items.length) return null;
        const external = provider === 'electron' ? [] : items.filter(row => canStopObservedProcess(row, true));
        return <div key={provider} className="mb-2">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="capitalize text-[#ccc]">{provider === 'electron' ? 'Electron Dev' : provider} · {items.length}</span>
            {external.length > 0 && <button type="button" data-process-bulk={provider} disabled={busy}
              onClick={() => choose(external, true)} className="rounded px-2 py-1 text-red-300 hover:bg-red-500/10 disabled:opacity-40">
              {provider === 'mcp' ? 'Stop orphans' : 'Stop external'} · {external.length}
            </button>}
          </div>
          <div className="max-h-48 overflow-y-auto">
            {items.map(row => <div key={processControlKey(row)} data-process-row={row.pid}
              className="mb-1 rounded border border-white/5 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[#ccc]" title={row.cwd || row.command}>
                  {row.tabId ? findTab(row.tabId)?.name || row.tabId : row.name || row.cwd?.split('/').pop() || row.provider}
                </span>
                <span className="shrink-0 text-[10px]">PID {row.pid}</span>
                <button type="button" data-process-stop={row.pid} disabled={busy || !canStopObservedProcess(row)}
                  title={canStopObservedProcess(row) ? 'Confirm stop of this exact process' : 'Protected or not owned by this instance'}
                  onClick={() => choose([row])} className="shrink-0 rounded px-1.5 py-1 text-red-300 hover:bg-red-500/10 disabled:text-[#555] disabled:opacity-60">Stop</button>
              </div>
              <div className="flex flex-wrap gap-x-2 text-[10px] text-[#777]">
                <span>{row.ownerLabel || (row.kind === 'electron' ? 'Electron Dev' : 'external')}{row.ownerPid ? ` · owner ${row.ownerPid}` : ''}</span>
                <span>{row.startTime}</span><span>CPU {row.cpu}% · MEM {row.mem}%</span>
                {row.isOrphan && <span>orphan</span>}
              </div>
              <details className="mt-1 text-[10px] text-[#777]">
                <summary className="cursor-pointer">Command and directory</summary>
                <div className="break-all select-text">{row.command}</div>
                <div className="break-all select-text">{row.cwd || '—'}</div>
              </details>
            </div>)}
          </div>
        </div>;
      })}
      {!loading && !error && rows.length === 0 && <div className="text-[#777]">No {scope === 'mcp-orphans' ? 'orphan MCP' : 'AI or Electron Dev'} processes</div>}
      {confirmation && <div role="alertdialog" aria-label="Confirm exact process stop" data-process-confirmation
        className="mt-2 rounded border border-red-500/25 bg-red-500/5 p-2">
        <div className="mb-1 text-red-200">Stop {confirmation.length} selected process{confirmation.length === 1 ? '' : 'es'}?</div>
        <div className="max-h-40 overflow-auto">
          {confirmation.map(row => <div key={processControlKey(row)} className="mb-1 break-all text-[10px]">
            <div>PID {row.pid} · {row.provider} · {row.ownerLabel || 'external'} · {row.startTime}</div>
            <div>{row.command}</div><div>{row.cwd}</div>
            {row.tabId && <div>Tab {row.tabId} · stop agent through its current tab</div>}
            {row.kind === 'electron' && <div>Dedicated Electron Dev stop includes its owned launcher/descendants.</div>}
          </div>)}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" data-process-cancel disabled={busy} onClick={cancel} className="rounded px-2 py-1 disabled:opacity-40">Cancel</button>
          <button type="button" data-process-confirm disabled={busy} onClick={() => void apply()}
            className="rounded bg-red-500/15 px-2 py-1 text-red-200 disabled:opacity-40">{busy ? 'Checking / stopping…' : 'Stop selected'}</button>
        </div>
      </div>}
    </section>
  );
}
