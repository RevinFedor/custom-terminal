import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { archiveRecordKey, validateArchiveSnapshot, filterArchiveRecords, archiveRestoreTarget,
  archiveActionRequest, archiveActionAcknowledged, archiveReceiptMatches } from '../../utils/globalTabArchive.mjs';
import './GlobalTabArchive.css';

export type GlobalArchiveRecord = {
  id: number; namespace: string; tab_id?: string | null; name?: string | null; cwd?: string | null;
  workflowId?: string | null; workflowName?: string | null; notes?: string | null;
  command_type?: string | null; tab_type?: string | null; protected?: boolean; protectedReason?: string;
  [field: string]: unknown;
};
export type GlobalArchiveSnapshot = {
  version: 1; history: GlobalArchiveRecord[]; favorites: GlobalArchiveRecord[]; revision?: unknown;
};
export type ArchiveRequest = {
  version: 1; namespace: string; requestId: string; historyId?: number; favoriteId?: number;
  expectedTabId?: string; expectedRevision?: unknown; targetWorkflowId?: string; record: GlobalArchiveRecord;
  background?: boolean; name?: string; notes?: string;
};
type Receipt = boolean | { success?: boolean; ok?: boolean; tabId?: string; message?: string;
  historyDeleteFailed?: boolean; disposition?: 'not-applied'; [field: string]: unknown } | null | undefined;
type Action = (request: ArchiveRequest) => Promise<Receipt>;
export interface GlobalTabArchiveProps {
  // Root may supply () => ipcRenderer.invoke('workflow:archive-read'). No store imports or implicit launches.
  readArchive: () => Promise<GlobalArchiveSnapshot>;
  workflows: { id: string; name: string; kind?: string }[];
  onRestore: Action;
  onOpenFavorite: Action;
  onDeleteHistory: Action;
  onRemoveFavorite: Action;
  onAddFavorite?: Action;
  onRename?: Action;
  onRefreshTitle?: Action;
  onUpdateNotes?: Action;
  // Read-only History + Timeline, including exact iteration search jump. Never restore in this renderer.
  renderPreview?: (record: GlobalArchiveRecord, context: { kind: 'history' | 'favorite'; entryUuid?: string }) => React.ReactNode;
  searchArchive?: (request: { version: 1; query: string; mode: 'titles' | 'iterations';
    workflowId?: string; cwd?: string; dateFrom?: string }) => Promise<{ version: 1; history: GlobalArchiveRecord[] }>;
  onClose?: () => void;
}

type Selection = { kind: 'history' | 'favorite'; key: string; row: GlobalArchiveRecord };
type Confirmation = { selection: Selection; revision: unknown };

export default function GlobalTabArchive(props: GlobalTabArchiveProps) {
  const [snapshot, setSnapshot] = useState<GlobalArchiveSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<'history' | 'favorite'>('history');
  const [query, setQuery] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [cwd, setCwd] = useState('');
  const [target, setTarget] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<'name' | 'notes' | null>(null);
  const [draft, setDraft] = useState('');
  const [searchMode, setSearchMode] = useState<'titles' | 'iterations'>('titles');
  const [dateFrom, setDateFrom] = useState('');
  const [searchRows, setSearchRows] = useState<GlobalArchiveRecord[] | null>(null);
  const [searching, setSearching] = useState(false);
  const alive = useRef(true), readEpoch = useRef(0), searchEpoch = useRef(0);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const locks = useRef(new Set<string>());
  // Unknown receipt retries retain the immutable original request and ID, rather than sending a new intent.
  const requests = useRef(new Map<string, ArchiveRequest>());
  const load = useCallback(async () => {
    const epoch = ++readEpoch.current;
    setLoading(true);
    try {
      const next = validateArchiveSnapshot(await props.readArchive());
      if (!alive.current || epoch !== readEpoch.current) return;
      setSnapshot(next); snapshotRef.current = next; setError('');
      setSelected(previous => {
        if (!previous) return null;
        const row = (previous.kind === 'history' ? next.history : next.favorites)
          .find(row => archiveRecordKey(previous.kind, row) === previous.key);
        return row ? { ...previous, row } : null;
      });
    } catch (cause) {
      if (alive.current && epoch === readEpoch.current) setError(String((cause as Error)?.message || cause));
    } finally { if (alive.current && epoch === readEpoch.current) setLoading(false); }
  }, [props.readArchive]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; readEpoch.current++; searchEpoch.current++; }; }, [load]);
  useEffect(() => { searchEpoch.current++; setSearchRows(null); setSearching(false); }, [query, workflow, cwd, searchMode, dateFrom]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmation) setConfirmation(null);
      else if (editing) setEditing(null);
      else props.onClose?.();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [confirmation, editing, props.onClose]);

  const rows = useMemo(() => filterArchiveRecords(kind === 'history'
    ? searchRows ?? snapshot?.history ?? [] : snapshot?.favorites ?? [],
  { query: searchRows && kind === 'history' ? '' : query, workflowId: workflow, cwd }), [kind, snapshot, query, workflow, cwd, searchRows]);
  const directories = useMemo(() => [...new Set([...(snapshot?.history ?? []), ...(snapshot?.favorites ?? [])]
    .map(row => row.cwd).filter(Boolean))] as string[], [snapshot]);
  const availableWorkflows = useMemo(() => {
    const values = new Map(props.workflows.map(value => [value.id, value.name]));
    for (const row of [...(snapshot?.history ?? []), ...(snapshot?.favorites ?? [])])
      if (row.workflowId && !values.has(row.workflowId)) values.set(row.workflowId, row.workflowName || 'Удалённый workflow');
    return [...values];
  }, [props.workflows, snapshot]);

  const run = async (action: string, selection: Selection, callback: Action | undefined, extra: Partial<ArchiveRequest> = {}, revision?: unknown) => {
    if (!callback || !snapshotRef.current || locks.current.has(selection.key) || selection.row.protected) return;
    const requestKey = JSON.stringify([selection.key, action, extra, ['restore', 'open'].includes(action) ? target : '']);
    let request = requests.current.get(requestKey);
    if (!request) {
      try {
        const targetWorkflowId = ['restore', 'open'].includes(action)
          ? archiveRestoreTarget(selection.row, props.workflows, target) : undefined;
        request = { ...archiveActionRequest(selection.kind, selection.row,
          revision === undefined ? snapshotRef.current : { ...snapshotRef.current, revision },
          crypto.randomUUID(), targetWorkflowId), ...extra };
        requests.current.set(requestKey, request);
      } catch (cause) { setError(String((cause as Error).message)); return; }
    }
    locks.current.add(selection.key); setPending(new Set(locks.current)); setNotice(''); setError('');
    try {
      const receipt = await callback(structuredClone(request));
      if (!alive.current) return;
      if (!archiveReceiptMatches(receipt, request)) {
        setError('Подтверждение относится к другой записи. Запись сохранена.');
        return;
      }
      if (!archiveActionAcknowledged(receipt, action)) {
        // Only an explicit, audited negative disposition releases an immutable intent.
        // Plain false, missing ACK and thrown transport errors remain unknown and reuse the same ID.
        if (receipt && typeof receipt === 'object' && receipt.disposition === 'not-applied') requests.current.delete(requestKey);
        setError((typeof receipt === 'object' && receipt?.message) || 'Действие не подтверждено. Запись сохранена.');
        return;
      }
      requests.current.delete(requestKey);
      setConfirmation(null); setEditing(null);
      setNotice(typeof receipt === 'object' && receipt?.historyDeleteFailed
        ? 'Вкладка открыта, запись архива сохранена.' : 'Готово');
      searchEpoch.current++; setSearchRows(null); setSearching(false);
      await load(); // No optimistic removal: reread exact durable records after acknowledgment.
    } catch (cause) {
      if (alive.current) setError(String((cause as Error)?.message || 'Нет подтверждения действия.'));
    } finally {
      locks.current.delete(selection.key);
      if (alive.current) setPending(new Set(locks.current));
    }
  };
  const semanticSearch = async () => {
    if (!props.searchArchive || searching || query.trim().length < 2) return;
    const epoch = ++searchEpoch.current; setSearching(true); setError('');
    try {
      const result = await props.searchArchive({ version: 1, query: query.trim(), mode: searchMode,
        workflowId: workflow || undefined, cwd: cwd || undefined, dateFrom: dateFrom || undefined });
      if (epoch !== searchEpoch.current || !alive.current) return;
      if (result?.version !== 1 || !Array.isArray(result.history)) throw new Error('Unsupported search response');
      for (const row of result.history) archiveRecordKey('history', row);
      setSearchRows(result.history);
    } catch (cause) { if (alive.current && epoch === searchEpoch.current) setError(String((cause as Error).message)); }
    finally { if (alive.current && epoch === searchEpoch.current) setSearching(false); }
  };
  const choose = (row: GlobalArchiveRecord) => {
    setSelected({ kind, key: archiveRecordKey(kind, row), row }); setEditing(null); setNotice('');
  };
  const busy = selected ? pending.has(selected.key) : false;
  const disabled = busy || !!selected?.row.protected;
  return <section className="global-tab-archive" data-global-tab-archive aria-label="Архив и избранное">
    <header className="gta-toolbar">
      <div className="gta-tabs" role="tablist" aria-label="Сохранённые вкладки">
        <button role="tab" aria-selected={kind === 'history'} onClick={() => { setKind('history'); setSelected(null); }}>Архив <small>{snapshot?.history.length ?? 0}</small></button>
        <button role="tab" aria-selected={kind === 'favorite'} onClick={() => { setKind('favorite'); setSelected(null); }}>Избранное <small>{snapshot?.favorites.length ?? 0}</small></button>
      </div>
      <button aria-label="Обновить архив" disabled={loading} onClick={() => void load()}>↻</button>
      {props.onClose && <button aria-label="Закрыть архив" onClick={props.onClose}>×</button>}
    </header>
    <div className="gta-filters">
      <input aria-label="Поиск архива" placeholder="Название, папка, заметки…" value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="Фильтр workflow" value={workflow} onChange={event => setWorkflow(event.target.value)}><option value="">Все workflows</option>{availableWorkflows.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select aria-label="Фильтр директории" value={cwd} onChange={event => setCwd(event.target.value)}><option value="">Все директории</option>{directories.map(path => <option key={path}>{path}</option>)}</select>
    </div>
    {kind === 'history' && props.searchArchive && <div className="gta-search-tools">
      <select aria-label="Тип поиска" value={searchMode} onChange={event => setSearchMode(event.target.value as typeof searchMode)}><option value="titles">По смыслу названия</option><option value="iterations">По итерациям</option></select>
      <input type="date" aria-label="Закрыты начиная с" value={dateFrom} onChange={event => setDateFrom(event.target.value)} />
      <button disabled={searching || query.trim().length < 2} onClick={() => void semanticSearch()}>{searching ? 'Поиск…' : 'Найти'}</button>
      {searchRows && <button onClick={() => { searchEpoch.current++; setSearchRows(null); }}>Сбросить результаты</button>}
    </div>}
    {error && <div role="alert" className="gta-error">{error}</div>}
    {notice && <div role="status" className="gta-notice">{notice}</div>}
    <div className="gta-body">
      <div className="gta-list" aria-busy={loading}>
        {rows.map((row, index) => {
          const key = archiveRecordKey(kind, row);
          // Search may return several iterations of one record; mutation identity stays the storage key.
          return <button className="gta-row" key={key + ':' + String(row.entryUuid ?? index)} data-archive-record={key}
            aria-pressed={selected?.key === key} onClick={() => choose(row)}
            onAuxClick={event => { if (event.button === 1 && kind === 'history') { event.preventDefault(); void run('restore', { kind, key, row }, props.onRestore, { background: true }); } }}>
            <span className="gta-row-title">{row.name || 'Без названия'}</span>
            <span className="gta-row-meta">{row.workflowName || 'Без workflow'} · {row.command_type || row.tab_type || 'terminal'}</span>
            <span className="gta-row-path" title={row.cwd || ''}>{row.cwd || 'Директория не сохранена'}</span>
          </button>;
        })}
        {!rows.length && <p className="gta-empty">{loading ? 'Загрузка…' : query || workflow || cwd ? 'Ничего не найдено' : kind === 'history' ? 'Закрытых вкладок пока нет' : 'В избранном пока пусто'}</p>}
      </div>
      <div className="gta-details">
        {!selected ? <p className="gta-empty">Выберите запись для просмотра</p> : <>
          <div className="gta-actions">
            <select aria-label="Куда восстановить" value={target} disabled={disabled} onChange={event => setTarget(event.target.value)}><option value="">Прежний workflow / Inbox</option>{props.workflows.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>
            <button disabled={disabled} data-archive-open onClick={() => void run(selected.kind === 'history' ? 'restore' : 'open', selected, selected.kind === 'history' ? props.onRestore : props.onOpenFavorite)}>{busy ? 'Ожидание…' : selected.kind === 'history' ? 'Восстановить' : 'Открыть'}</button>
            {selected.kind === 'history' && <button disabled={disabled} onClick={() => void run('restore', selected, props.onRestore, { background: true })}>В фоне</button>}
            {selected.kind === 'history' && props.onAddFavorite && <button disabled={disabled} onClick={() => void run('favorite', selected, props.onAddFavorite)}>В избранное</button>}
            {selected.kind === 'history' && props.onRename && <button disabled={disabled} onClick={() => { setDraft(selected.row.name || ''); setEditing('name'); }}>Переименовать</button>}
            {selected.kind === 'history' && props.onRefreshTitle && <button disabled={disabled} onClick={() => void run('title', selected, props.onRefreshTitle)}>Обновить название</button>}
            {props.onUpdateNotes && <button disabled={disabled} onClick={() => { setDraft(selected.row.notes || ''); setEditing('notes'); }}>Изменить заметки</button>}
            <button className="gta-danger" disabled={disabled} data-archive-delete onClick={() => setConfirmation({ selection: structuredClone(selected), revision: snapshotRef.current?.revision })}>{selected.kind === 'history' ? 'Удалить запись' : 'Убрать из избранного'}</button>
          </div>
          {selected.row.protected && <p role="status">{selected.row.protectedReason || 'Запись используется активной операцией'}</p>}
          {editing && <form className="gta-editor" onSubmit={event => { event.preventDefault(); void run(editing, selected, editing === 'name' ? props.onRename : props.onUpdateNotes, { [editing]: draft }); }}>
            <textarea aria-label={editing === 'name' ? 'Название записи' : 'Заметки записи'} value={draft} onChange={event => setDraft(event.target.value)} />
            <button disabled={disabled || (editing === 'name' && !draft.trim())}>Сохранить</button><button type="button" onClick={() => setEditing(null)}>Отмена</button>
          </form>}
          {props.renderPreview ? props.renderPreview(selected.row, { kind: selected.kind, entryUuid: typeof selected.row.entryUuid === 'string' ? selected.row.entryUuid : undefined }) : <div className="gta-metadata">
            <dl><dt>Директория</dt><dd>{selected.row.cwd || '—'}</dd><dt>Тип</dt><dd>{selected.row.command_type || selected.row.tab_type || 'terminal'}</dd></dl>
            {selected.row.notes && <p className="gta-notes">{selected.row.notes}</p>}
          </div>}
        </>}
      </div>
    </div>
    {confirmation && <div className="gta-confirm-shade"><div role="dialog" aria-modal="true" aria-label="Подтверждение удаления" className="gta-confirm">
      <p>{confirmation.selection.kind === 'history' ? 'Удалить эту запись архива?' : 'Убрать запись из избранного?'}</p><p className="gta-confirm-name">{confirmation.selection.row.name || 'Без названия'}</p>
      <p>Файлы на диске останутся.</p>
      <button disabled={pending.has(confirmation.selection.key)} data-archive-confirm onClick={() => void run('delete', confirmation.selection, confirmation.selection.kind === 'history' ? props.onDeleteHistory : props.onRemoveFavorite, {}, confirmation.revision)}>Удалить</button>
      <button autoFocus onClick={() => setConfirmation(null)}>Отмена</button>
    </div></div>}
  </section>;
}
