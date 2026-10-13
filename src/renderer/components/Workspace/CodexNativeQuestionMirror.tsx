import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle, SkipForward, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { controlCodexNativeQuestion, useCodexNativeQuestion } from '../../utils/codexNativeQuestions';

export default function CodexNativeQuestionMirror({ tabId, onRecoverDraft }: {
  tabId: string; onRecoverDraft: (text: string) => void;
}) {
  const state = useCodexNativeQuestion(tabId);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const drafts = useRef(new Map<string, { draft: string; selected: number | null; baseDraft: string }>());
  const currentKey = useRef('');
  const field = useRef({ draft: '', selected: null as number | null, baseDraft: '' });
  const recover = useRef(onRecoverDraft); recover.current = onRecoverDraft;
  const hasQuestion = !!state;
  const questionKey = state?.expanded ? state.questionId || state.title : '';
  useEffect(() => {
    if (!state?.expanded || !questionKey || currentKey.current === questionKey) return;
    if (currentKey.current) drafts.current.set(currentKey.current, { ...field.current });
    currentKey.current = questionKey;
    const saved = drafts.current.get(questionKey) || { draft: state.draft || '',
      selected: state.draft ? null : state.options.length
        ? Number(state.optionIndex ?? 0) < state.options.length ? state.optionIndex ?? 0 : null
        : null,
      baseDraft: state.draft || '' };
    field.current = { ...saved }; setDraft(saved.draft); setSelected(saved.selected);
  }, [questionKey, state?.expanded]);
  useEffect(() => {
    if (hasQuestion || busyRef.current) return;
    const saved = new Map(drafts.current);
    if (currentKey.current) saved.set(currentKey.current, field.current);
    const text = [...saved.values()].map(item => item.draft.trim()).filter(Boolean).join('\n\n');
    if (text) recover.current(text);
    drafts.current.clear(); currentKey.current = ''; field.current = { draft: '', selected: null, baseDraft: '' };
    setDraft(''); setSelected(null);
  }, [hasQuestion, busy]);
  async function act(action: string) {
    if (!state || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const key = currentKey.current;
    const answer = draft.trim() || (selected !== null ? state.options[selected] || '' : '');
    try {
      const result = await controlCodexNativeQuestion(tabId, action, action === 'answer'
        ? { answer, baseDraft: field.current.baseDraft,
          ...(!draft.trim() && selected !== null ? { optionIndex: selected } : {}) } : {});
      if (!result?.success) {
        const reason = result?.error;
        const text = reason === 'semantic-frame-timeout'
          ? 'Не удалось подтвердить действие с вопросом. Проверь терминал: команда могла уже сработать.'
          : reason === 'question_not_actionable'
            ? 'Форма вопроса не распознана. Повторная команда не отправлена — проверь терминал.'
            : reason === 'question_state_changed' || reason === 'question_owner_changed'
              ? 'Вопрос изменился или уже закрыт. Команда не подтверждена.'
              : 'Вопрос Codex: ' + (reason || 'операция не подтверждена');
        useUIStore.getState().showToast(text,
          'error', 5000, false, undefined, undefined, undefined, tabId);
      } else if (action === 'skip' || action === 'answer') {
        drafts.current.delete(key);
        if (currentKey.current === key) {
          field.current = { draft: '', selected: null, baseDraft: '' }; setDraft(''); setSelected(null);
        }
      }
    } catch (error) {
      useUIStore.getState().showToast('Вопрос Codex: ' + String((error as Error)?.message || error),
        'error', 5000, false, undefined, undefined, undefined, tabId);
    } finally { busyRef.current = false; setBusy(false); }
  }
  if (!state) return null;
  const button: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '3px 7px', border: '1px solid #514262', borderRadius: 5,
    background: '#17121d', color: '#c4b5fd', fontSize: 'inherit', cursor: 'pointer' };
  return <div data-codex-native-question-bar={tabId} style={{ position: 'relative', zIndex: 12,
    display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4, fontSize: 12 }}
    onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <button style={button} disabled={busy} aria-expanded={state.expanded}
      data-codex-native-question-open title="Открыть текущий вопрос Codex"
      onClick={() => void act(state.expanded ? 'close' : 'open')}>
      <HelpCircle size={13}/>{state.count === 1 ? 'Вопрос' : 'Вопросы ' + state.count}
    </button>
    <button style={button} disabled={busy} data-codex-native-question-skip
      title="Пропустить текущий вопрос, не останавливая Codex" onClick={() => void act('skip')}>
      <SkipForward size={13}/>Пропустить
    </button>
    {state.expanded && <div data-codex-native-question-card
      style={{ position: 'absolute', bottom: 'calc(100% + 5px)', left: 0, width: 'min(620px, 100%)',
        maxHeight: 'min(320px, 65vh)', overflowY: 'auto', padding: 10, boxSizing: 'border-box',
        borderRadius: 7, border: '1px solid #665180', background: '#17131e', color: '#ded5eb',
        boxShadow: '0 5px 20px #0009', zIndex: 20 }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void act('close'); } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
        <span style={{ flex: 1 }}>Вопрос {Number(state.current) + 1} / {state.count}</span>
        <button style={button} disabled={busy || state.current === 0} aria-label="Предыдущий вопрос"
          onClick={() => void act('previous')}><ChevronLeft size={13}/></button>
        <button style={button} disabled={busy || Number(state.current) >= state.count - 1} aria-label="Следующий вопрос"
          onClick={() => void act('next')}><ChevronRight size={13}/></button>
        <button style={button} disabled={busy} aria-label="Закрыть вопрос" onClick={() => void act('close')}><X size={13}/></button>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginBottom: 8 }}>{state.title}</div>
      {state.options.map((option, index) => <label key={index} style={{ display: 'flex', gap: 6,
        alignItems: 'flex-start', padding: '4px 5px', marginBottom: 2, borderRadius: 4,
        background: selected === index && !draft ? '#332342' : 'transparent', cursor: 'pointer' }}>
        <input type="radio" name={'codex-question-' + tabId} checked={selected === index && !draft}
          disabled={busy} onChange={() => {
            field.current = { draft: '', selected: index, baseDraft: state.draft };
            setSelected(index); setDraft('');
          }}/>
        <span style={{ overflowWrap: 'anywhere' }}>{option}</span>
      </label>)}
      <textarea data-codex-native-question-answer aria-label="Свой ответ на вопрос Codex"
        data-dictation-owner-key={state.targetId + ":" + questionKey}
        placeholder={state.options.length ? 'Или свой ответ…' : 'Введите ответ…'} value={draft}
        disabled={busy} onChange={event => {
          field.current = { ...field.current, draft: event.target.value, selected: null };
          setDraft(event.target.value); setSelected(null);
        }} style={{ width: '100%', minHeight: 56, maxHeight: 120, resize: 'vertical', boxSizing: 'border-box',
          marginTop: 6, padding: 7, border: '1px solid #50415e', borderRadius: 4,
          background: '#100d15', color: '#eee', font: 'inherit', outline: 'none' }}/>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
        <button style={button} data-codex-native-question-submit disabled={busy || (!draft.trim() && selected === null)}
          onClick={() => void act('answer')}>{busy ? 'Отвечаю…' : 'Ответить'}</button>
      </div>
    </div>}
  </div>;
}
