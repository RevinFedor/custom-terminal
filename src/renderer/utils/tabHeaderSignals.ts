/**
 * Один запрос показателей шапки вкладки вместо нескольких одновременных.
 *
 * Шрам 02.11 (прод): первый скролл сразу после перехода на вкладку стоил до
 * 345 мс, при том что максимальная СИНХРОННАЯ блокировка главного потока в том
 * же окне — 45 мс. Поток не считал, он разгребал очередь: на один переход
 * приходило до 189 операций, и почти все — мелкие запросы об одной и той же
 * вкладке. Колесо вставало за ними.
 *
 * Здесь две вещи, обе про очередь, а не про вычисления:
 *
 * 1. Один канал вместо трёх. Главный процесс отвечает теми же значениями из
 *    тех же источников; прежние каналы сохранены для остальных вызывающих.
 *
 * 2. Склейка одновременных запросов об одной вкладке. Шапка монтируется в
 *    нескольких местах сразу — центральная поверхность, боковая панель,
 *    удерживаемые окна. Без склейки объединение одного запроса просто
 *    умножилось бы на число панелей.
 *
 * Это транспорт, не контракт: ни одна возможность не убавилась, владелец
 * значений прежний, живые подписки не затронуты.
 */

type HeaderSignals = {
  contextPct: { pct: number | null; exact?: boolean; reason?: string } | null;
  cacheStats: { cacheRead?: number; cacheCreate?: number; input?: number; ts?: number } | null;
  provider: Record<string, unknown> | null;
  partial?: boolean;
  errors?: string[];
};

// Запись живёт ровно столько, сколько летит запрос: снимается в `finally`.
// Срока у неё нет намеренно — он был бы мёртвым условием. Склейка покрывает
// только одновременные вызовы, а следующий переход на вкладку всегда читает
// заново: процент контекста меняется каждый ход, и показать прошлое значение
// хуже, чем не показать ничего.
const inFlight = new Map<string, Promise<HeaderSignals | null>>();

function ipc(): { invoke: (channel: string, payload: unknown) => Promise<unknown> } | null {
  try { return (window as any).require?.('electron')?.ipcRenderer || null; }
  catch { return null; }
}

/**
 * Читает показатели шапки для вкладки. Одновременные вызовы об одной вкладке
 * получают один и тот же ответ, не создавая второй запрос.
 *
 * Отказ не бросается: шапка показывает значения по мере готовности, и
 * отсутствие засева не должно ронять её монтирование.
 */
export function headerSignals(tabId: string): Promise<HeaderSignals | null> {
  if (!tabId) return Promise.resolve(null);
  const existing = inFlight.get(tabId);
  if (existing) return existing;

  const bridge = ipc();
  if (!bridge) return Promise.resolve(null);

  const promise = bridge.invoke('tab:get-header-signals', { tabId })
    .then(value => (value && typeof value === 'object' ? value as HeaderSignals : null))
    .catch(() => null)
    .finally(() => {
      // Снимается сразу после ответа: следующий переход на эту вкладку обязан
      // получить свежие значения, а не остаток прошлого окна склейки.
      if (inFlight.get(tabId) === promise) inFlight.delete(tabId);
    });

  inFlight.set(tabId, promise);
  return promise;
}

/** Диагностика: сколько запросов сейчас в полёте. */
export function tabHeaderSignalsInFlight(): number {
  return inFlight.size;
}
