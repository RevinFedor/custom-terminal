// Перезапустить ТОЛЬКО сервер `terminal` в живом MCP-хабе, если установка
// действительно заменила его код на диске.
//
// ЗАЧЕМ. Хаб намеренно detached (`ppid=1`) и переживает Build Install: иначе
// каждая установка рвала бы MCP всем вкладкам сразу. Новый Main на старте
// вызывает `ensure()` и принимает уже живой хаб как есть, до `launch()` дело не
// доходит. Значит после установки на диске лежит новый `terminal-server.mjs`, а
// в памяти продолжает исполняться старый — и так до ручного рестарта.
//
// Шрам 02.11.2026 (локальное время, Asia/Bangkok): хаб 99730 поднят в 17:13;
// установка в 20:28:44 заменила app.asar и в 20:28:48 переписала
// `~/.claude/mcp/terminal-server.mjs`; новый Main в 20:29:12 принял прежний хаб.
// Живой сервер исполнял код от 17:13 ещё двенадцать минут, пока в 20:40:43
// сосед не позвал рестарт руками. В 20:42 вкладки получили
// `stale_transcript_revision` — это тот самый симптом. Доказательство, что
// установка детей не трогает: у `terminal` в `/mcp/_status` тогда стоял
// `restarts: 1` — ровно один, тот ручной.
//
// ГРАНИЦЫ, намеренно узкие:
//
//   • ТОЛЬКО `terminal`. Не `_restart-all` и не смена поколения хаба: у
//     `electron` и `ios` в `~/.noted-terminal/mcp-hub.json` стоит
//     `stateful: true`, и рестарт сбросил бы им живое состояние —
//     CDP-подключение и сессию симулятора. Остальные пять серверов не наши.
//   • Только при доказанном изменении. `installTerminalMcp()` уже отвечает на
//     этот вопрос: `changed.runtime` выставляется, лишь когда содержимое
//     файла отличается от установленного. Придумывать свой детектор — значит
//     завести второй источник правды о том же факте.
//   • Недоступный хаб НЕ роняет установку. Если его нет или он не ответил,
//     сервер всё равно поднимется позже уже с новым файлом; терять из-за
//     этого готовую установку несоразмерно. Оба исхода попадают в лог.
//
// Клиентов это не рвёт: постоянного сокета к 53133 у них нет, каждый вызов
// инструмента — отдельный HTTP-запрос, а `restartServer` поднимает только
// ребёнка, оставляя порт и сам хаб живыми. Список инструментов не меняется —
// сервер тот же, пересоздавать сессии вкладкам не нужно.

const HUB_RESTART_URL = 'http://127.0.0.1:53133/mcp/_restart/terminal';
const TIMEOUT_MS = 5000;

/**
 * Прочитать ответ `install:terminal-mcp` и сказать, менялся ли код сервера.
 *
 * Шаг печатает свой результат как JSON, но в общий поток установки, где перед
 * ним идут строки npm. Поэтому берётся последний JSON-объект вывода, а не весь
 * текст: это тот же единственный `process.stdout.write` в конце скрипта.
 *
 * Неразобранный вывод — НЕ «ничего не менялось». Такой ответ означает, что
 * факт неизвестен, и решение принимает вызывающая сторона.
 *
 * @returns {{known: boolean, changed: boolean, files: string[]}}
 */
export function readTerminalMcpRuntimeChange(output) {
  const text = String(output || '');
  const start = text.lastIndexOf('\n{');
  const candidate = start >= 0 ? text.slice(start + 1) : text.trimStart().startsWith('{') ? text : '';
  if (!candidate.trim()) return { known: false, changed: false, files: [] };
  let parsed;
  try { parsed = JSON.parse(candidate); } catch { return { known: false, changed: false, files: [] }; }
  const changed = parsed?.changed;
  if (!changed || typeof changed.runtime !== 'boolean') return { known: false, changed: false, files: [] };
  return {
    known: true,
    changed: changed.runtime === true,
    files: Array.isArray(changed.runtimeFiles) ? changed.runtimeFiles.map(String) : [],
  };
}

/**
 * Перезапустить `terminal` в хабе. Никогда не бросает: установка уже прошла, и
 * её результат не может зависеть от доступности мессенджера.
 *
 * @returns {Promise<{ok: boolean, reason?: string, restarts?: number|null}>}
 */
export async function restartTerminalMcpServer(options = {}) {
  const url = options.url || HUB_RESTART_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'fetch_unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.ok !== true) {
      return { ok: false, reason: 'hub_refused', status: response.status,
        error: payload?.error || null };
    }
    const restarts = Number(payload?.server?.restarts);
    return { ok: true, restarts: Number.isFinite(restarts) ? restarts : null };
  } catch (error) {
    // Хаба просто нет — обычный случай, не авария: он поднимется сам уже с
    // новым файлом.
    const refused = /ECONNREFUSED|fetch failed/i.test(String(error?.message || ''));
    return { ok: false,
      reason: controller.signal.aborted ? 'timeout' : refused ? 'hub_unavailable' : 'network_error',
      error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Шаг установщика: решить по выводу `install:terminal-mcp` и, если код менялся,
 * перезапустить сервер.
 *
 * @returns {Promise<{restarted: boolean, reason: string, files?: string[], restarts?: number|null}>}
 */
export async function refreshTerminalMcpRuntime(output, {
  restart = restartTerminalMcpServer,
  log = () => {},
} = {}) {
  const change = readTerminalMcpRuntimeChange(output);
  if (!change.known) {
    // Нераспознанный вывод шага. Молча пропустить — значит оставить вкладкам
    // старый код после настоящей замены файла; это и был исходный шрам.
    log('terminal MCP: не удалось прочитать результат install:terminal-mcp — перезапускаю на всякий случай');
  } else if (!change.changed) {
    log('terminal MCP: код сервера не менялся, перезапуск не нужен');
    return { restarted: false, reason: 'unchanged' };
  } else {
    log('terminal MCP: код сервера обновлён (' + change.files.join(', ') + ') — перезапускаю в хабе');
  }
  const result = await restart();
  if (result.ok) {
    log('terminal MCP: сервер перезапущен в хабе'
      + (result.restarts === null || result.restarts === undefined ? '' : ' (restarts=' + result.restarts + ')'));
    return { restarted: true, reason: change.known ? 'changed' : 'unknown-output',
      files: change.files, restarts: result.restarts };
  }
  log('terminal MCP: перезапустить не удалось (' + result.reason + ')'
    + ' — установка продолжается, сервер поднимется позже уже с новым файлом');
  return { restarted: false, reason: result.reason, files: change.files };
}

export const TERMINAL_MCP_RESTART_URL = HUB_RESTART_URL;
