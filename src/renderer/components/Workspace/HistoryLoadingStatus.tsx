import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { historyPreparationStatus, selectHistoryPreparation } from '../../utils/historyPreparationStatus.mjs';

// Сколько держится память о замеченной операции. Закрывает только промежуток
// между концом чтения и появлением строк; всё дольше означает, что операция
// пропала, и её стадию показывать уже нельзя (шрам 02.11 — см. ниже).
const SEEN_TTL_MS = 2000;

// Kept below HistoryPanel: progress must not rebuild the large transcript or
// subscribe retained rows. This component exists only while its loader does.
export default function HistoryLoadingStatus({ toolType, sessionId, cwd, children }: {
  toolType: string; sessionId?: string | null; cwd?: string | null; children: React.ReactNode;
}) {
  const store = historyPreparationStatus();
  const getSnapshot = useCallback(() => selectHistoryPreparation(store.getSnapshot(), {
    toolType, sessionId, cwd,
  }), [store, toolType, sessionId, cwd]);
  const operation = useSyncExternalStore(store.subscribe, getSnapshot);
  const owner = JSON.stringify([toolType, sessionId, cwd || '']);
  // Память о замеченной операции нужна для короткого промежутка между концом
  // чтения и появлением строк: без неё подпись дёргалась бы на «Читаю историю»
  // и обратно. Но это ПАМЯТЬ, а не состояние: держать её бессрочно нельзя.
  //
  // Шрам 02.11 (прод, вкладка 95c379a4fb0f): операция исчезла из хранилища, не
  // дойдя до завершения, и условие `!operation && seen.current.operation`
  // осталось истинным навсегда — «Читаю историю · строю карточки» висело
  // 2 минуты 15 секунд при ГОТОВЫХ данных (`GROUP_UNITS_BUILD … ms=0.1` сразу
  // после старта). Отвисло само лишь потому, что следующий запрос завёл новую
  // операцию и перезаписал память. Пользователь видел вечный лоадер на
  // загруженной истории.
  //
  // Поэтому память живёт ограниченное время. Промежуток, который она
  // закрывает, — доли секунды; всё дольше означает, что операция пропала, и
  // показывать её стадию уже нельзя.
  const seen = useRef<{ owner: string; operation: string | null; at: number }>({ owner, operation: null, at: 0 });
  if (seen.current.owner !== owner) seen.current = { owner, operation: null, at: 0 };
  if (operation) seen.current = { owner, operation: operation.id, at: Date.now() };
  const rememberedOperation = seen.current.operation
    && Date.now() - seen.current.at < SEEN_TTL_MS
    ? seen.current.operation : null;
  const [slowOwner, setSlowOwner] = useState<string | null>(null);
  useEffect(() => {
    // 200ms, not 1000: below this a loader only flashes, but a whole second of
    // silence made the three states look like three different mechanisms —
    // sometimes a label appeared, sometimes nothing did. Opening a tab whose
    // cache is cold takes 1-3s, so the label is the normal case, not the
    // exception.
    const timer = setTimeout(() => setSlowOwner(owner), 200);
    return () => clearTimeout(timer);
  }, [owner]);
  // Срок памяти сам по себе не вызывает перерисовку: без операции в хранилище
  // ничего не меняется, и подпись осталась бы прежней до следующего события.
  // Один таймер на исчезновение операции доводит компонент до состояния без
  // стадии. Это не опрос: он взводится ровно один раз, когда операция ушла.
  const [, tick] = useState(0);
  useEffect(() => {
    if (operation || !seen.current.operation) return;
    const left = SEEN_TTL_MS - (Date.now() - seen.current.at);
    if (left <= 0) return;
    const timer = setTimeout(() => tick(value => value + 1), left);
    return () => clearTimeout(timer);
  }, [operation]);
  const detailed = slowOwner === owner || (operation && Date.now() - operation.startedAt >= 200);
  const reading = detailed && operation?.phase === 'reading';
  const preparing = detailed && (operation?.phase === 'preparing' || (!operation && rememberedOperation));
  const percent = reading ? Math.floor(operation.completedBytes * 100 / operation.totalBytes) : null;
  // ONE sentence that gains detail, instead of three different messages
  // replacing each other. "Читаю историю" is the whole operation; the percent
  // and the stage are what we happen to know about it right now.
  const label = !detailed ? 'Читаю историю'
    : reading ? `Читаю историю · ${percent}%`
    : preparing ? 'Читаю историю · строю карточки'
    : 'Читаю историю';
  return (
    <div data-history-loading-status style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {children}
        <span>{label}</span>
      </div>
      {reading && <>
        <div role="progressbar" aria-label="Чтение истории" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={percent!} style={{ width: 200, maxWidth: '100%', height: 3, borderRadius: 2, background: '#333345', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${percent}%`, background: '#818cf8' }} />
        </div>
        <span style={{ fontSize: 11, color: '#8888a0', fontVariantNumeric: 'tabular-nums' }}>
          {Math.floor(operation.completedBytes / 1048576)} / {Math.ceil(operation.totalBytes / 1048576)} МБ
        </span>
      </>}
    </div>
  );
}
