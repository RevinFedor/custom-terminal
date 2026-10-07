import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';

type Revision = string | number;
type Root = { id: string; path: string; name?: string; icon?: string; enabled?: boolean; kind?: string; revision: Revision; [key: string]: unknown };
type Registry = { version: 1; revision: Revision; roots: Root[]; [key: string]: unknown };
type Draft = { id?: string; path: string; name: string; enabled: boolean };
type Mutation = { channel: string; payload: Record<string, unknown> };
const emptyDraft = (): Draft => ({ path: '', name: '', enabled: true });
const revision = (value: unknown): value is Revision => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const ipc = () => window.require('electron').ipcRenderer;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const control: React.CSSProperties = { background: '#242424', color: '#ddd', border: '1px solid #444', borderRadius: 6, padding: '6px 9px', fontSize: 12 };

function validateRegistry(value: any): Registry {
  if (value?.success === false || value?.error) throw new Error(value.message || value.error || 'Не удалось прочитать директории');
  if (value?.version !== 1 || !revision(value.revision) || !Array.isArray(value.roots)) throw new Error('Неподдерживаемый ответ реестра директорий');
  const ids = new Set<string>();
  for (const root of value.roots) {
    if (!root || typeof root.id !== 'string' || !root.id || ids.has(root.id) || typeof root.path !== 'string' || !revision(root.revision)) throw new Error('Некорректная запись директории');
    ids.add(root.id);
  }
  return value;
}

export default function DirectoryRootsSettings() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<Root | null>(null);
  const [pending, setPending] = useState<Mutation | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const lock = useRef(false);
  const editable = Boolean(registry) && !loading && !busy && !error && !pending;

  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = validateRegistry(await ipc().invoke('workflow:list-roots'));
      if (!mounted.current || request !== generation.current) return;
      setRegistry(result);
      setError('');
    } catch (failure) {
      if (mounted.current && request === generation.current) setError(errorText(failure));
      throw failure;
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load().catch(() => {});
    return () => { mounted.current = false; generation.current++; };
  }, [load]);

  // A transport error retains the exact envelope for a same-ID retry. A known
  // refusal can be reread/re-edited, but is never silently rebased and submitted.
  const mutate = async (operation: Mutation) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(''); setPending(operation);
    try {
      const response = await ipc().invoke(operation.channel, operation.payload);
      if (response?.success === false || response?.error) {
        if (mounted.current) setPending(null);
        throw new Error(response?.message || response?.error || 'Изменение не подтверждено');
      }
      if (response?.success !== true) {
        // An unrecognized ACK is not a confirmed commit. Preserve the retry
        // envelope just as for a lost response instead of inventing success.
        validateRegistry(response);
      }
      if (!mounted.current) return;
      setPending(null); setDraft(null); setRemoving(null);
      await load();
    } catch (failure) {
      if (mounted.current) setError(errorText(failure));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const save = () => {
    if (!editable || !draft || !draft.path.trim()) return;
    const existing = registry!.roots.find(root => root.id === draft.id);
    if (draft.id && !existing) { setError('Директория больше не зарегистрирована. Обновите список.'); return; }
    void mutate({ channel: 'workflow:save-root', payload: {
      mutationId: crypto.randomUUID(), expectedRevision: registry!.revision,
      ...(draft.id ? { id: draft.id } : {}), path: draft.path.trim(), name: draft.name.trim(), enabled: draft.enabled,
      // Preserve existing scope; adding a working-directory root grants no new
      // prompt availability to any existing tab.
      kind: existing?.kind ?? 'cwd',
    } });
  };

  const chooseDirectory = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const result = await ipc().invoke('app:select-directory');
      const path = typeof result === 'string' ? result : result?.path;
      if (mounted.current && path) setDraft(current => current ? { ...current, path } : current);
    } catch (failure) { if (mounted.current) setError(errorText(failure)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };

  return <section data-directory-roots style={{ marginTop: 24, borderTop: '1px solid #333', paddingTop: 16 }} aria-label="Директории">
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <h3 style={{ margin: 0, fontSize: 13, color: '#ddd' }}>Директории</h3>
      <div style={{ display: 'flex', gap: 6 }}>
        <button style={control} aria-label="Обновить директории" disabled={busy || loading || Boolean(pending)} onClick={() => void load().catch(() => {})}><RefreshCw size={13} /></button>
        <button style={control} disabled={!editable} onClick={() => { setRemoving(null); setDraft(emptyDraft()); }}><Plus size={13} style={{ display: 'inline' }} /> Директория</button>
      </div>
    </div>
    <p style={{ color: '#999', fontSize: 12 }}>Директория вкладки выбирается независимо от этого списка. Добавление директории не подключает её промпты к вкладкам автоматически.</p>
    {loading && <div role="status" style={{ color: '#aaa', fontSize: 12 }}>Загрузка директорий…</div>}
    {error && <div role="alert" style={{ color: '#f87171', fontSize: 12, marginBottom: 8 }}>{error}
      {pending ? <button style={{ ...control, marginLeft: 8 }} disabled={busy} onClick={() => void mutate(pending)}>Повторить запрос</button>
        : <button style={{ ...control, marginLeft: 8 }} disabled={busy || loading} onClick={() => void load().catch(() => {})}>Прочитать заново</button>}
    </div>}
    {registry && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {registry.roots.map(root => <div key={root.id} data-directory-root={root.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 8, border: '1px solid #333', borderRadius: 7 }}>
        {root.icon && <img src={root.icon} alt="" width={22} height={22} />}
        <button style={{ ...control, textAlign: 'left', flex: 1, minWidth: 0 }} disabled={!editable} onClick={() => { setRemoving(null); setDraft({ id: root.id, path: root.path, name: root.name || '', enabled: root.enabled !== false }); }}>
          <span style={{ display: 'block', overflowWrap: 'anywhere' }}>{root.name || root.path}</span>
          {root.name && <span style={{ display: 'block', color: '#888', overflowWrap: 'anywhere' }}>{root.path}</span>}
          {(root.missing === true || root.exists === false) && <span style={{ display: 'block', color: '#d4a34a' }}>Директория недоступна</span>}
          {root.enabled === false && <span style={{ display: 'block', color: '#888' }}>Отключена</span>}
        </button>
        <button style={control} aria-label={`Убрать регистрацию ${root.name || root.path}`} disabled={!editable} onClick={() => { setDraft(null); setRemoving(root); }}><Trash2 size={13} /></button>
      </div>)}
      {!registry.roots.length && !loading && !error && <div style={{ fontSize: 12, color: '#888' }}>Зарегистрированных директорий пока нет.</div>}
    </div>}
    {draft && <form onSubmit={event => { event.preventDefault(); save(); }} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      <label style={{ color: '#aaa', fontSize: 12 }}>Название<input aria-label="Название директории" style={{ ...control, display: 'block', width: '100%', boxSizing: 'border-box' }} disabled={busy || Boolean(pending)} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label style={{ color: '#aaa', fontSize: 12 }}>Путь<input aria-label="Путь директории" style={{ ...control, display: 'block', width: '100%', boxSizing: 'border-box' }} disabled={busy || Boolean(pending)} value={draft.path} onChange={event => setDraft({ ...draft, path: event.target.value })} /></label>
      <button type="button" style={control} disabled={!editable} onClick={() => void chooseDirectory()}><FolderOpen size={13} style={{ display: 'inline' }} /> Выбрать директорию</button>
      <label style={{ color: '#aaa', fontSize: 12 }}><input type="checkbox" disabled={!editable} checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> Включена в реестре</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={control} type="submit" disabled={!editable || !draft.path.trim()}>Сохранить директорию</button>
        <button style={control} type="button" disabled={busy || Boolean(pending)} onClick={() => setDraft(null)}>Отмена</button>
      </div>
    </form>}
    {removing && <div data-directory-remove-confirm style={{ marginTop: 12, fontSize: 12, color: '#aaa' }}>
      Убрать «{removing.name || removing.path}» из реестра? Файлы на диске и рабочие директории вкладок сохранятся. Регистрация и её привязки будут убраны.
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button style={control} disabled={!editable} onClick={() => void mutate({ channel: 'workflow:remove-root', payload: { mutationId: crypto.randomUUID(), expectedRevision: registry!.revision, id: removing.id, expectedRootRevision: removing.revision } })}>Убрать регистрацию</button>
        <button style={control} disabled={busy || Boolean(pending)} onClick={() => setRemoving(null)}>Отмена</button>
      </div>
    </div>}
  </section>;
}
