/**
 * «Запустить» в контекстном меню вкладки: кого именно и чем.
 *
 * В меню всегда стоит одна кнопка в правом слоте: пока сессия жива — «Стоп»,
 * пока не запущена — «Запустить». Раньше второго состояния не было вовсе:
 * на незапущенной вкладке слот показывал серую надпись «Stop», которую нельзя
 * нажать. Это худший из возможных ответов — место занято сообщением о том, что
 * сделать ничего нельзя, ровно в тот момент, когда сделать НУЖНО именно одно:
 * запустить.
 *
 * Правило то же, что у кнопки состояния в переписке
 * (`historyTerminalActivityAction.mjs`): живое действие вытесняет запуск, и
 * ничего третьего у кнопки нет. Здесь оно применяется к НАБОРУ вкладок, потому
 * что меню открывают и на выделении из нескольких.
 *
 * Смешанный набор решается в пользу «Стоп»: остановить лишнюю вкладку — потеря
 * секунды, запустить агента там, где уже кто-то работает, — потеря контекста.
 */

/** Какой агент запустится на этой вкладке и с какой сессии. */
export function resolveTabRunTarget(tab, { ptyOwner = null } = {}) {
  if (!tab) return null;
  // Вкладка агента в SDK-режиме живёт без своего терминала: запускать её
  // отсюда нечем, её кнопка Run — внутри самой вкладки.
  if (tab.tabType === 'claude-sdk') return null;
  if (tab.tabType === 'file') return null;

  const owner = ptyOwner
    || (tab.commandType === 'claude' || tab.commandType === 'codex' ? tab.commandType : null);
  if (owner !== 'claude' && owner !== 'codex') return null;

  const sessionId = owner === 'claude' ? tab.claudeSessionId : tab.codexSessionId;
  return {
    tabId: tab.id,
    toolType: owner,
    // Есть сохранённая сессия — продолжаем её, нет — начинаем новую. Это тот же
    // выбор, который делает панель истории; здесь он только называется вслух,
    // чтобы подпись кнопки могла его показать.
    mode: sessionId ? 'resume' : 'fresh',
    sessionId: sessionId || null,
    cwd: tab.cwd || null,
  };
}

/**
 * Что показать в правом слоте меню для набора вкладок.
 *
 * `runningIds` — вкладки с живым процессом (их считает вызывающая сторона: она
 * знает и про PTY, и про занятость SDK-вкладки).
 */
export function resolveTabMenuRunState(tabs, runningIds = new Set()) {
  const targets = [];
  let running = 0;
  for (const tab of tabs || []) {
    if (!tab) continue;
    if (runningIds.has(tab.id)) { running += 1; continue; }
    const target = resolveTabRunTarget(tab, { ptyOwner: tab.__ptyOwner || null });
    if (target) targets.push(target);
  }

  // Живое действие вытесняет запуск — см. вводный комментарий.
  if (running > 0) return { kind: 'stop', targets: [], count: running };
  if (targets.length > 0) {
    return {
      kind: 'run',
      targets,
      count: targets.length,
      // Одна вкладка — говорим, что именно произойдёт: продолжить прежний
      // разговор или начать новый. Для набора это уже не одно утверждение,
      // поэтому там только число.
      mode: targets.length === 1 ? targets[0].mode : null,
      toolType: targets.length === 1 ? targets[0].toolType : null,
    };
  }
  // Ни живых процессов, ни того, кого можно запустить: обычная терминальная
  // вкладка, файл или SDK. Слот остаётся, но пустым — иначе строка кнопок
  // меняет ширину от вкладки к вкладке.
  return { kind: 'none', targets: [], count: 0 };
}

/** Подпись кнопки запуска. */
export function tabMenuRunLabel(state) {
  if (!state || state.kind !== 'run') return '';
  if (state.count > 1) return `Запустить ${state.count}`;
  return state.mode === 'resume' ? 'Продолжить' : 'Запустить';
}
