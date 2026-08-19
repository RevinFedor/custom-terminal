import React, { useState } from 'react';
import { User as UserIcon } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';

const ToggleRow = ({
  title,
  hint,
  active,
  accent,
  onToggle,
  disabled = false,
  indent = false,
  isLastChild = false,
}: {
  title: string;
  hint?: string;
  active: boolean;
  accent: string;
  onToggle: () => void;
  disabled?: boolean;
  indent?: boolean;
  isLastChild?: boolean;
}) => (
  <label
    className={`flex items-center justify-between gap-3 group/label ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    style={{ position: 'relative', paddingLeft: indent ? 20 : 2, paddingRight: 2, paddingTop: 3, paddingBottom: 3 }}
    onClick={() => { if (!disabled) onToggle(); }}
  >
    {indent && (
      <>
        <span aria-hidden style={{ position: 'absolute', left: 8, top: 0, bottom: isLastChild ? '50%' : 0, width: 1, backgroundColor: '#333' }} />
        <span aria-hidden style={{ position: 'absolute', left: 8, top: '50%', width: 8, height: 1, backgroundColor: '#333' }} />
      </>
    )}
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
      <span className="group-hover/label:text-white" style={{ color: '#d0d0d0', fontSize: indent ? 11.5 : 12, fontWeight: indent ? 500 : 600, lineHeight: 1.3 }}>
        {title}
      </span>
      {hint && <span style={{ color: '#666', fontSize: 10, lineHeight: 1.25 }}>{hint}</span>}
    </span>
    <div
      className={`relative ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} shrink-0`}
      style={{ width: 28, height: 16, borderRadius: 8, transition: 'background-color 0.15s', backgroundColor: active && !disabled ? accent : '#3a3a3a' }}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onToggle();
      }}
    >
      <div
        className="absolute bg-white rounded-full"
        style={{ top: 2, left: active ? 14 : 2, width: 12, height: 12, transition: 'left 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }}
      />
    </div>
  </label>
);

const MiniChip = ({ active, label, title, accent, onClick, italic = false }: {
  active: boolean;
  label: React.ReactNode;
  title: string;
  accent: string;
  onClick: () => void;
  italic?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className="cursor-pointer hover:opacity-85 transition-opacity inline-flex items-center"
    style={{
      background: 'transparent',
      border: 'none',
      padding: 0,
      color: active ? accent : '#555',
      fontSize: 10,
      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
      fontStyle: italic ? 'italic' : 'normal',
      lineHeight: 1.2,
    }}
  >
    {label}
  </button>
);

const Dot = () => <span aria-hidden style={{ color: '#3f3f46', fontSize: 10, lineHeight: 1.2 }}>·</span>;

// Exact sentence-case labels rendered by History's generic cards. The Plan
// detail bucket groups these rows internally, but its UI must name what the
// user actually sees instead of describing an invisible implementation class.
const PLAN_HISTORY_LABELS = 'Plan, Task create, Task update, Task list, Todo write, Tool search, Ask user question, Wait';

/**
 * One provider-neutral copy-filter surface. Provider names never participate
 * in the taxonomy: Claude Bash and Codex exec_command are transports, while
 * Read/Search/Edit/Run/Git/MCP/Web/Plan are the actions the user understands.
 */
export default function CopySessionFilterPanel({
  accent,
  showFromFork,
}: {
  accent: string;
  showFromFork: boolean;
}) {
  const includeUser = useUIStore((state) => state.copyIncludeUser);
  const includeText = useUIStore((state) => state.copyIncludeText);
  const includeThinking = useUIStore((state) => state.copyIncludeThinking);
  const includeActions = useUIStore((state) => state.copyIncludeActions);
  const includeReading = useUIStore((state) => state.copyIncludeReading);
  const includeSearch = useUIStore((state) => state.copyIncludeSearch);
  const includeEditing = useUIStore((state) => state.copyIncludeEditing);
  const includeRun = useUIStore((state) => state.copyIncludeRun);
  const includeGit = useUIStore((state) => state.copyIncludeGit);
  const includeMcp = useUIStore((state) => state.copyIncludeMcp);
  const includeWeb = useUIStore((state) => state.copyIncludeWebSearch);
  const includePlan = useUIStore((state) => state.copyIncludePlan);
  const includeOther = useUIStore((state) => state.copyIncludeOtherTools);
  const includeSubagentResult = useUIStore((state) => state.copyIncludeSubagentResult);
  const includeSubagentHistory = useUIStore((state) => state.copyIncludeSubagentHistory);
  const fromStart = useUIStore((state) => state.copyFromStart);

  const setIncludeUser = useUIStore((state) => state.setCopyIncludeUser);
  const setIncludeText = useUIStore((state) => state.setCopyIncludeText);
  const setIncludeThinking = useUIStore((state) => state.setCopyIncludeThinking);
  const setIncludeActions = useUIStore((state) => state.setCopyIncludeActions);
  const setIncludeReading = useUIStore((state) => state.setCopyIncludeReading);
  const setIncludeSearch = useUIStore((state) => state.setCopyIncludeSearch);
  const setIncludeEditing = useUIStore((state) => state.setCopyIncludeEditing);
  const setIncludeRun = useUIStore((state) => state.setCopyIncludeRun);
  const setIncludeGit = useUIStore((state) => state.setCopyIncludeGit);
  const setIncludeMcp = useUIStore((state) => state.setCopyIncludeMcp);
  const setIncludeWeb = useUIStore((state) => state.setCopyIncludeWebSearch);
  const setIncludePlan = useUIStore((state) => state.setCopyIncludePlan);
  const setIncludeOther = useUIStore((state) => state.setCopyIncludeOtherTools);
  const setIncludeSubagentResult = useUIStore((state) => state.setCopyIncludeSubagentResult);
  const setIncludeSubagentHistory = useUIStore((state) => state.setCopyIncludeSubagentHistory);
  const setFromStart = useUIStore((state) => state.setCopyFromStart);

  const [subPreferred, setSubPreferred] = useState<'result' | 'full'>('result');
  const subOn = includeSubagentResult || includeSubagentHistory;
  const subFull = includeSubagentHistory;
  const subLabel = subOn ? (subFull ? 'full' : 'result') : subPreferred;
  const enableActionDetail = (active: boolean, setter: (value: boolean) => void) => {
    if (!includeActions) setIncludeActions(true);
    setter(!(includeActions && active));
  };

  return (
    <>
      <div
        style={{
          borderBottom: '1px solid #2a2a2a',
          paddingBottom: 7,
          marginBottom: 5,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div className="flex items-center" style={{ gap: '2px 5px', minWidth: 0, flexWrap: 'wrap' }}>
          <MiniChip active={includeUser} accent={accent} onClick={() => setIncludeUser(!includeUser)} title="Запрос пользователя" label={<UserIcon size={11} strokeWidth={2} />} />
          <Dot />
          <MiniChip italic active={includeText} accent={accent} onClick={() => setIncludeText(!includeText)} title="Ответ агента" label="answer" />
          <Dot />
          <MiniChip italic active={includeThinking} accent={accent} onClick={() => setIncludeThinking(!includeThinking)} title="Рассуждение агента, если провайдер его сохранил" label="reasoning" />
          <Dot />
          <MiniChip active={includeActions} accent={accent} onClick={() => setIncludeActions(!includeActions)} title="Краткая хронология действий агента" label="actions" />
        </div>

        <div className="flex items-center" style={{ gap: '2px 5px', minWidth: 0, flexWrap: 'wrap' }}>
          <MiniChip active={includeActions && includeReading} accent={accent} onClick={() => enableActionDetail(includeReading, setIncludeReading)} title="Добавлять содержимое прочитанных файлов" label="read" />
          <Dot />
          <MiniChip active={includeActions && includeSearch} accent={accent} onClick={() => enableActionDetail(includeSearch, setIncludeSearch)} title="Добавлять результаты локального поиска" label="search" />
          <Dot />
          <MiniChip active={includeActions && includeEditing} accent={accent} onClick={() => enableActionDetail(includeEditing, setIncludeEditing)} title="Добавлять diff и записанный код" label="edit" />
          <Dot />
          <MiniChip active={includeActions && includeRun} accent={accent} onClick={() => enableActionDetail(includeRun, setIncludeRun)} title="Добавлять вывод остальных terminal-команд" label="run" />
          <Dot />
          <MiniChip active={includeActions && includeGit} accent={accent} onClick={() => enableActionDetail(includeGit, setIncludeGit)} title="Добавлять вывод Git" label="git" />
          <Dot />
          <MiniChip active={includeActions && includeMcp} accent={accent} onClick={() => enableActionDetail(includeMcp, setIncludeMcp)} title="Добавлять MCP arguments и result" label="mcp" />
          <Dot />
          <MiniChip active={includeActions && includeWeb} accent={accent} onClick={() => enableActionDetail(includeWeb, setIncludeWeb)} title="Добавлять результаты Web search/fetch" label="web" />
          <Dot />
          <MiniChip active={includeActions && includePlan} accent={accent} onClick={() => enableActionDetail(includePlan, setIncludePlan)} title={`Добавлять детали: ${PLAN_HISTORY_LABELS}`} label="plan" />
          <Dot />
          <MiniChip active={includeActions && includeOther} accent={accent} onClick={() => enableActionDetail(includeOther, setIncludeOther)} title="Добавлять данные редких действий" label="other" />
          <Dot />
          <span className="inline-flex items-center" style={{ fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, monospace', lineHeight: 1.2 }}>
            <button
              type="button"
              onClick={() => {
                if (!includeActions) {
                  setIncludeActions(true);
                  return;
                }
                if (subOn) {
                  setIncludeSubagentResult(false);
                  setIncludeSubagentHistory(false);
                } else if (subPreferred === 'full') {
                  setIncludeSubagentHistory(true);
                } else {
                  setIncludeSubagentResult(true);
                }
              }}
              className="cursor-pointer hover:opacity-85 transition-opacity"
              style={{ background: 'transparent', border: 'none', padding: 0, color: includeActions && subOn ? accent : '#555', fontFamily: 'inherit', lineHeight: 1.2 }}
            >
              sub-
            </button>
            <button
              type="button"
              onClick={() => {
                if (!subOn) {
                  setSubPreferred(subPreferred === 'result' ? 'full' : 'result');
                } else if (subFull) {
                  setIncludeSubagentHistory(false);
                  setIncludeSubagentResult(true);
                  setSubPreferred('result');
                } else {
                  setIncludeSubagentHistory(true);
                  setSubPreferred('full');
                }
              }}
              className="cursor-pointer hover:opacity-85 transition-opacity"
              style={{ background: 'transparent', border: 'none', padding: 0, color: includeActions && subOn ? accent : '#555', fontFamily: 'inherit', lineHeight: 1.2 }}
            >
              {subLabel}
            </button>
          </span>
        </div>
      </div>

      <ToggleRow title="Запрос пользователя" hint="текст, изображения и приложенные prompt-чипы" active={includeUser} accent={accent} onToggle={() => setIncludeUser(!includeUser)} />
      <ToggleRow title="Ответ агента" hint="обычный текст ответа" active={includeText} accent={accent} onToggle={() => setIncludeText(!includeText)} />
      <ToggleRow title="Рассуждение" hint="только если провайдер сохранил читаемый reasoning" active={includeThinking} accent={accent} onToggle={() => setIncludeThinking(!includeThinking)} />
      <ToggleRow title="Действия агента" hint="краткие Read / Edit / Run / MCP строки" active={includeActions} accent={accent} onToggle={() => setIncludeActions(!includeActions)} />
      <ToggleRow title="Чтение" hint="добавлять содержимое файлов" active={includeReading} accent={accent} disabled={!includeActions} indent onToggle={() => setIncludeReading(!includeReading)} />
      <ToggleRow title="Поиск" hint="добавлять результаты локального поиска" active={includeSearch} accent={accent} disabled={!includeActions} indent onToggle={() => setIncludeSearch(!includeSearch)} />
      <ToggleRow title="Правки" hint="добавлять diff, patch или записанный код" active={includeEditing} accent={accent} disabled={!includeActions} indent onToggle={() => setIncludeEditing(!includeEditing)} />
      <ToggleRow title="Команды" hint="stdout/stderr команд, не ставших другим действием" active={includeRun} accent={accent} disabled={!includeActions} indent onToggle={() => setIncludeRun(!includeRun)} />
      <ToggleRow title="Git" hint="status, diff и вывод остальных Git-команд" active={includeGit} accent={accent} disabled={!includeActions} indent onToggle={() => setIncludeGit(!includeGit)} />
      <ToggleRow title="MCP" hint="arguments и result MCP-вызовов" active={includeMcp} accent={accent} disabled={!includeActions} indent onToggle={() => setIncludeMcp(!includeMcp)} />
      <ToggleRow title="Web" hint="результаты Web search/fetch" active={includeWeb} accent={accent} disabled={!includeActions} indent onToggle={() => setIncludeWeb(!includeWeb)} />
      <ToggleRow title="План и управление" hint={PLAN_HISTORY_LABELS} active={includePlan} accent={accent} disabled={!includeActions} indent onToggle={() => setIncludePlan(!includePlan)} />
      <ToggleRow title="Прочее" hint="содержимое редких и будущих действий" active={includeOther} accent={accent} disabled={!includeActions} indent isLastChild onToggle={() => setIncludeOther(!includeOther)} />

      <div style={{ height: 1, backgroundColor: '#2a2a2a', margin: '6px 0' }} />

      <ToggleRow
        title="Субагенты"
        hint="отдельные Claude/Codex исполнители"
        active={subOn}
        accent={accent}
        disabled={!includeActions}
        onToggle={() => {
          if (subOn) {
            setIncludeSubagentHistory(false);
            setIncludeSubagentResult(false);
          } else {
            setIncludeSubagentResult(true);
          }
        }}
      />
      <ToggleRow title="Финальный результат" active={includeSubagentResult} accent={accent} disabled={!includeActions || !subOn} indent onToggle={() => setIncludeSubagentResult(!includeSubagentResult)} />
      <ToggleRow title="Вся цепочка" hint="служебная история субагента" active={includeSubagentHistory} accent={accent} disabled={!includeActions || !subOn} indent isLastChild onToggle={() => setIncludeSubagentHistory(!includeSubagentHistory)} />

      {showFromFork && (
        <>
          <div style={{ height: 1, backgroundColor: '#2a2a2a', margin: '6px 0' }} />
          <ToggleRow title="От последнего fork" active={!fromStart} accent={accent} onToggle={() => setFromStart(!fromStart)} />
        </>
      )}
    </>
  );
}
