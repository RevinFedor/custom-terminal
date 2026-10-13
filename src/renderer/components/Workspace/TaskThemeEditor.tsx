import React, { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { MarkdownEditor } from '@gt-editor/markdown-editor';
import '@gt-editor/markdown-editor/styles.css';
import { Sparkles } from 'lucide-react';
import type { TabTaskPlanDocument, TabTaskPlanItem, TabTaskPlanOperation } from '../../store/useWorkspaceStore';
import { electronComposerClipboardAdapter } from '../../utils/electronComposerClipboardAdapter';
import { generateTaskTheme } from '../../utils/generateTaskTheme';
import { TaskPlanPopupOwner } from './TaskPlanPopover';
import { useTaskEditorFloatingSurfaces } from '../../hooks/useTaskEditorFloatingSurfaces';
import { claimTaskPlanChildDismissal } from '../../utils/taskPlanPopupDismissal.mjs';

type Content = { shortTitle: string; title: string; body: string };
const contentOf = (task: TabTaskPlanItem): Content => ({ shortTitle: task.shortTitle || '', title: task.title, body: task.body || '' });
const equal = (a: Content, b: Content) => a.shortTitle === b.shortTitle && a.title === b.title && a.body === b.body;
export type TaskThemeEditorHandle = { save: () => Promise<boolean> };

/** Metadata belongs to Noted; only the body is a GT MarkdownEditor document. */
const TaskThemeEditor = forwardRef<TaskThemeEditorHandle, {
  task: TabTaskPlanItem;
  draft: boolean;
  readOnly: boolean;
  apply: (operations: TabTaskPlanOperation[]) => Promise<TabTaskPlanDocument | null>;
  onCreated: () => void;
  onCancel: () => void;
  onMenuOpen: (open: boolean) => void;
  onError: (message: string) => void;
  renderDescription: (props: { value: string; onDraftChange: (title: string | null) => void; onCommit: () => Promise<boolean> }) => React.ReactNode;
}>(function TaskThemeEditor({ task, draft, readOnly, apply, onCreated, onCancel, onMenuOpen, onError, renderDescription }, ref) {
  const [content, setContent] = useState<Content>(() => contentOf(task));
  const current = useRef(content), base = useRef<Content | null>(draft ? null : contentOf(task));
  const pending = useRef<Promise<boolean> | null>(null);
  const alive = useRef(true), version = useRef(0), generation = useRef(0);
  const [menu, setMenu] = useState(false), [awaitingPaste, setAwaitingPaste] = useState(false), [busy, setBusy] = useState(false);
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const popupOwner = useContext(TaskPlanPopupOwner);
  const { onEditorView: handleEditorView, trackGesture } = useTaskEditorFloatingSurfaces(popupOwner, setLibraryMenuOpen);
  const generating = useRef(false);
  const root = useRef<HTMLDivElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ apply, onCreated, onCancel, onError }); latest.current = { apply, onCreated, onCancel, onError };
  const change = useCallback((patch: Partial<Content>) => {
    const next = { ...current.current, ...patch };
    if (equal(next, current.current)) return;
    current.current = next; version.current++;
    setContent(current.current);
  }, []);
  const descriptionDisplay = useRef(content.title); descriptionDisplay.current = content.title;
  const descriptionDraft = useCallback((draftTitle: string | null) => {
    const title = draftTitle ?? descriptionDisplay.current;
    if (current.current.title === title) return;
    // PlanTitleField owns its in-progress draft and Escape baseline. Do not
    // echo each keystroke back as its committed value.
    current.current = { ...current.current, title }; version.current++;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (draft || pending.current || !base.current) return;
    const incoming = contentOf(task), previous = base.current;
    // A remote edit may update clean fields, but cannot silently overwrite a
    // local edit to the same field. Its next save must fail the Main guard.
    const conflict = (Object.keys(previous) as Array<keyof Content>).some(key =>
      current.current[key] !== previous[key] && incoming[key] !== previous[key]);
    if (conflict) return;
    const next = { ...current.current };
    for (const key of Object.keys(previous) as Array<keyof Content>) {
      if (next[key] === previous[key]) next[key] = incoming[key];
    }
    base.current = incoming; current.current = next; setContent(next);
  }, [task, draft]);
  useEffect(() => {
    onMenuOpen(menu || libraryMenuOpen);
  }, [menu, libraryMenuOpen, onMenuOpen]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && (nameInput.current?.contains(event.target)
        || root.current?.querySelector('[data-task-plan-command-menu]')?.contains(event.target))) return;
      if (popupOwner) claimTaskPlanChildDismissal(event, popupOwner);
      setMenu(false);
    };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [menu, popupOwner]);

  const save = (): Promise<boolean> => {
    if (readOnly) return Promise.resolve(true);
    if (pending.current) return pending.current;
    const work = Promise.resolve().then(async () => {
      while (true) {
        const raw = { ...current.current };
        if (!base.current && !raw.shortTitle.trim() && !raw.title.trim() && !raw.body.trim()) return true;
        // /ai is an editor command, never a task title saved by blur.
        if (/^\/ai\s*$/i.test(raw.shortTitle) && !raw.title && !raw.body) return true;
        const title = raw.title.trim() || raw.shortTitle.trim() || raw.body.trim().split(/\r?\n/)[0].slice(0, 500);
        const snapshot = { ...raw, title };
        if (base.current && equal(snapshot, base.current)) return true;
        const document = await latest.current.apply([base.current
          ? { type: 'update_task', taskId: task.id, ...snapshot, ifMatches: base.current }
          : { type: 'add_task', id: task.id, ...snapshot }]);
        const saved = document?.items.find(value => value.id === task.id);
        if (!saved) {
          latest.current.onError('Не удалось сохранить задачу. Текст остался в редакторе.'); return false;
        }
        const created = !base.current;
        base.current = contentOf(saved);
        const normalizedName = snapshot.shortTitle.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
        if (base.current.body !== snapshot.body || base.current.shortTitle !== normalizedName) {
          // A paired build stores these fields. An older/skewed Main may accept
          // the old title operation but omit them: bind its real ID, keep the
          // complete local content, and never mistake that partial ACK for save.
          if (created) latest.current.onCreated();
          latest.current.onError('Приложение не сохранило все поля задачи. Обновите его; полный текст остался в редакторе.');
          return false;
        }
        if (equal(current.current, raw)) {
          current.current = base.current;
          if (alive.current) setContent(current.current);
        }
        if (created) latest.current.onCreated();
        if (equal(current.current, base.current) || !alive.current) return true;
      }
    });
    pending.current = work;
    void work.finally(() => { if (pending.current === work) pending.current = null; });
    return work;
  };
  useImperativeHandle(ref, () => ({ save }));
  const aiPaste = async (body: string) => {
    if (!body.trim() || generating.current) return;
    generating.current = true;
    setAwaitingPaste(false); setMenu(false);
    // Commit the ORIGINAL body before asking AI. Failure never replaces it
    // with a summary or leaves it only inside a temporary editor document.
    change(body === current.current.body ? { body }
      : { body, shortTitle: '', title: body.trim().split(/\r?\n/)[0].slice(0, 500) });
    const request = ++generation.current, editVersion = version.current;
    setBusy(true);
    try {
      if (!(await save())) return;
      if (request !== generation.current || editVersion !== version.current) return;
      const expected = { ...base.current! };
      const metadata = await generateTaskTheme(body);
      // Closing presentation is not cancellation of the accepted AI action.
      // Continue for this exact persisted task; Main's content guard rejects
      // a changed/deleted target. Only UI feedback needs a mounted editor.
      if (request !== generation.current || editVersion !== version.current) return;
      const document = await latest.current.apply([{ type: 'update_task', taskId: task.id, ...metadata, ifMatches: expected }]);
      const saved = document?.items.find(value => value.id === task.id);
      if (!saved) throw new Error('Задача изменилась: ответ AI не применён. Исходный текст сохранён.');
      base.current = contentOf(saved);
      if (alive.current && request === generation.current && editVersion === version.current) {
        current.current = base.current; setContent(current.current);
      }
    } catch (error: any) {
      if (alive.current) latest.current.onError((error?.message || 'Не удалось сформировать названия') + '. Исходный текст задачи сохранён.');
    } finally { generating.current = false; if (alive.current && request === generation.current) setBusy(false); }
  };
  const armPaste = () => {
    setMenu(false); change({ shortTitle: /^\/ai\s*$/i.test(current.current.shortTitle) ? '' : current.current.shortTitle });
    setAwaitingPaste(true); nameInput.current?.focus({ preventScroll: true });
  };
  const fieldStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', minWidth: 0,
    background: '#19191c', color: '#d2d2d7', border: '1px solid #39333f', borderRadius: 4,
    padding: '4px 5px', fontSize: 12, outline: 'none' };
  return <div ref={root} data-task-theme-editor
    onKeyDownCapture={event => trackGesture(event.nativeEvent)} onContextMenuCapture={event => trackGesture(event.nativeEvent)}
    onBlur={event => {
    if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return;
    if (!menu && !awaitingPaste) void save();
  }} onKeyDown={event => {
    if (event.key === 'Escape' && (menu || awaitingPaste)) {
      event.preventDefault(); event.stopPropagation(); setMenu(false); setAwaitingPaste(false);
    } else if (event.key === 'Escape' && !libraryMenuOpen && !base.current) {
      event.preventDefault(); event.stopPropagation(); generation.current++; latest.current.onCancel();
    }
  }} onPasteCapture={event => {
    if (!awaitingPaste) return;
    event.preventDefault(); event.stopPropagation(); void aiPaste(event.clipboardData.getData('text/plain'));
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, position: 'relative' }}>
      <input ref={nameInput} data-task-plan-autofocus={draft ? '' : undefined} aria-label="Короткое название" readOnly={readOnly}
        value={content.shortTitle} placeholder={awaitingPaste ? 'Вставьте текст' : 'Короткое название'} maxLength={500}
        onChange={event => { change({ shortTitle: event.target.value }); setMenu(/^\/ai\s*$/i.test(event.target.value)); }}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.code === 'Slash') { event.preventDefault(); event.stopPropagation(); setMenu(value => !value); }
          if (event.key === 'Enter') {
            event.preventDefault(); if (menu) armPaste();
            else if (!base.current && !Object.values(current.current).some(value => value.trim())) latest.current.onCancel();
            else void save();
          }
          // Header paste uses Electron transport, not the GT editor's global
          // waiting flag. The body editor has its own native clipboard keymap.
          if ((event.metaKey || event.ctrlKey) && event.code === 'KeyV' && awaitingPaste) {
            event.preventDefault(); event.stopPropagation(); void Promise.resolve(electronComposerClipboardAdapter.readText()).then(aiPaste);
          }
        }} style={{ ...fieldStyle, flex: 1 }} />
      <span style={{ color: '#777', fontSize: 10, whiteSpace: 'nowrap' }}>{content.body.length} симв.</span>
      {busy && <span role="status" style={{ flexShrink: 0, color: '#a78bfa', fontSize: 10 }}>AI…</span>}
      {menu && !readOnly && <div data-task-plan-command-menu role="menu" style={{ position: 'absolute', left: 0, top: '100%', zIndex: 1,
        background: '#242427', border: '1px solid #554766', borderRadius: 4, padding: 3 }}>
        <button type="button" role="menuitem" onMouseDown={event => event.preventDefault()} onClick={armPaste}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', fontSize: 12, color: '#c4b5fd', background: '#a78bfa18', border: 0, borderRadius: 3, cursor: 'pointer' }}><Sparkles size={12} /> AI Paste</button>
      </div>}
    </div>
    <div style={{ marginTop: 4 }}>{renderDescription({ value: content.title,
      onDraftChange: descriptionDraft, onCommit: save })}</div>
    <div data-task-theme-body style={{ height: 190, minHeight: 60, marginTop: 4, border: '1px solid #39333f', borderRadius: 4, overflow: 'hidden' }}>
      <MarkdownEditor content={content.body} onChange={body => change({ body })} clipboard={electronComposerClipboardAdapter} onEditorView={handleEditorView}
        fontSize={12} contentPaddingX={5} contentPaddingY={5} showLineNumbers={false} wordWrap compact readOnly={readOnly} />
    </div>
    {!readOnly && !busy && content.body && <button type="button" aria-label="Сформировать названия с AI"
      onMouseDown={event => event.preventDefault()} onClick={() => void aiPaste(content.body)}
      style={{ display: 'inline-flex', padding: '3px 4px', color: '#a78bfa', background: 'transparent', border: 0, cursor: 'pointer', marginTop: 2 }}><Sparkles size={12} /></button>}
  </div>;
});
export default TaskThemeEditor;
