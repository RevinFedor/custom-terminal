// Модель поиска ПО ИТЕРАЦИЯМ (промптам) для переключателя вкладок.
//
// В переключателе два поиска, и это два разных вопроса:
//
//   • «по вкладкам» — как называется вкладка. Мгновенный, локальный, по именам
//     того, что открыто прямо сейчас.
//   • «по итерациям» — что в этих вкладках ПИСАЛИ. Одна строка результата =
//     один промпт, а не вкладка целиком.
//
// Ищем БУКВАЛЬНО и только по ОТКРЫТЫМ вкладкам. Оба ограничения намеренные:
//
//   • буквально — «просто ищите наиболее точное слово». Смысловой поиск здесь
//     уже есть на домашней странице проекта; он отвечает на другой вопрос
//     («о чём был разговор») и стоит внешнего вызова на каждую букву;
//   • по открытым — у результата должно быть куда вести. Строка ведёт на
//     вкладку и прокручивает переписку к найденному промпту; закрытую вкладку
//     пришлось бы сначала восстанавливать, а это уже не переход, а действие.
//
// Что показывать и что подсвечивать, решает main (`iteration-search-match.js`):
// он один считает совпадения и отдаёт готовые смещения. Здесь — только форма
// списка, выбор проектов и адрес перехода.

/** Короче двух символов запрос не отправляется: ответом будет весь архив. */
export const ITERATION_MIN_QUERY = 2;
/** Сколько промптов показывать из одной вкладки. */
export const ITERATION_MAX_PER_TAB = 20;
/** Сколько строк показывать всего. */
export const ITERATION_MAX_TOTAL = 200;

/**
 * Какие вкладки спрашивать.
 *
 * Берём только вкладки с СОХРАНЁННОЙ сессией: у вкладки без сессии нет и
 * промптов на диске, а поход за ними — это чтение файла, которого нет.
 *
 * Порядок — свежесть (тот же, что в списке вкладок): main сохраняет его в
 * ответе, поэтому группы вкладок в результатах идут так же, как человек привык
 * видеть вкладки, а не по выдуманной оценке совпадения.
 *
 * @param {object} args
 * @param {Map<string, {tabs: Map<string, any>, projectPath?: string}>} args.openProjects
 * @param {Array<{projectId: string, tabId: string}>} [args.globalMru]
 * @param {Set<string>|string[]} [args.projectFilter] выбранные проекты; пусто = все
 * @returns {Array<{projectId, tabId, sessionId, toolType, cwd, tabName}>}
 */
export function collectIterationTargets({ openProjects, globalMru = [], projectFilter = null }) {
  const wanted = projectFilter
    ? (projectFilter instanceof Set ? projectFilter : new Set(projectFilter))
    : null;
  const rank = new Map();
  (globalMru || []).forEach((entry, index) => {
    if (entry && entry.tabId && !rank.has(entry.tabId)) rank.set(entry.tabId, index);
  });

  const targets = [];
  let natural = 0;
  openProjects.forEach((workspace, projectId) => {
    if (wanted && wanted.size > 0 && !wanted.has(projectId)) return;
    workspace.tabs.forEach((tab) => {
      // Дочерние вкладки суб-агентов не строки переключателя ни на одной
      // поверхности — здесь то же правило.
      if (!tab || tab.parentTabId) return;
      const sessionId = tab.codexSessionId || tab.claudeSessionId || '';
      if (!sessionId) return;
      targets.push({
        projectId,
        tabId: tab.id,
        sessionId,
        toolType: tab.codexSessionId ? 'codex' : 'claude',
        cwd: tab.cwd || workspace.projectPath || null,
        tabName: tab.name || '',
        _rank: rank.has(tab.id) ? rank.get(tab.id) : Infinity,
        _natural: natural++,
      });
    });
  });
  targets.sort((left, right) => (left._rank - right._rank) || (left._natural - right._natural));
  return targets.map(({ _rank, _natural, ...target }) => target);
}

/**
 * Разложить плоский ответ main по вкладкам, сохранив порядок обеих осей.
 *
 * Группировка по вкладке — не украшение: без неё десять промптов из одной
 * вкладки читаются как десять разных мест, и человек теряет то единственное,
 * что ему нужно от результата, — В КАКОЙ вкладке он это писал.
 *
 * @param {Array<object>} matches ответ main (уже в нужном порядке)
 * @param {(tabId: string) => object|null} tabMeta
 * @returns {Array<{kind:'iteration-tab'|'iteration', ...}>} плоский список строк
 */
export function buildIterationRows(matches, tabMeta = () => null) {
  const rows = [];
  let lastTabId = null;
  for (const match of matches || []) {
    if (!match || !match.tabId || !match.entryUuid) continue;
    if (match.tabId !== lastTabId) {
      const meta = tabMeta(match.tabId) || {};
      rows.push({
        kind: 'iteration-tab',
        tabId: match.tabId,
        projectId: match.projectId || meta.projectId || null,
        projectName: meta.projectName || '',
        projectIcon: meta.projectIcon || null,
        tabName: meta.tabName || match.tabId,
        tabColor: meta.tabColor || null,
        toolType: match.toolType === 'codex' ? 'codex' : 'claude',
      });
      lastTabId = match.tabId;
    }
    rows.push({ kind: 'iteration', hit: match });
  }
  return rows;
}

/**
 * Влить пришедший кусок (одна вкладка) в уже показанный список.
 *
 * Куски приходят порознь, по мере разбора вкладок, и порядок задаёт не приход,
 * а свежесть вкладок — она известна заранее. Поэтому вливаем НА МЕСТО: группа
 * встаёт туда, где стоит её вкладка в порядке опроса, а не в конец. Иначе
 * первый показанный ответ уезжал бы вниз каждый раз, когда доразобралась более
 * свежая вкладка, — то самое «список прыгает под курсором».
 *
 * @param {Array<object>} current уже показанные совпадения (плоский список)
 * @param {{tabId: string, hits: Array<object>}} chunk
 * @param {string[]} tabOrder порядок вкладок, в котором их опрашивали
 * @returns {Array<object>} новый плоский список
 */
export function mergeIterationChunk(current, chunk, tabOrder = []) {
  if (!chunk || !chunk.tabId || !Array.isArray(chunk.hits) || chunk.hits.length === 0) {
    return current || [];
  }
  const rank = new Map();
  tabOrder.forEach((tabId, index) => { if (!rank.has(tabId)) rank.set(tabId, index); });
  const byTab = new Map();
  for (const hit of current || []) {
    if (!hit || !hit.tabId) continue;
    if (!byTab.has(hit.tabId)) byTab.set(hit.tabId, []);
    byTab.get(hit.tabId).push(hit);
  }
  // Повтор той же вкладки заменяет её группу, а не удваивает: тот же кусок
  // может прийти второй раз при замене режима поиска.
  byTab.set(chunk.tabId, chunk.hits);
  return Array.from(byTab.entries())
    .sort((left, right) => (
      (rank.has(left[0]) ? rank.get(left[0]) : Infinity)
      - (rank.has(right[0]) ? rank.get(right[0]) : Infinity)
    ))
    .flatMap(([, hits]) => hits);
}

/** Сколько строк-промптов в списке — для счётчика найденного. */
export function countIterationHits(rows) {
  return (rows || []).filter((row) => row && row.kind === 'iteration').length;
}

/** Сколько вкладок дали совпадения — вторая половина того же счётчика. */
export function countIterationTabs(rows) {
  return (rows || []).filter((row) => row && row.kind === 'iteration-tab').length;
}

/**
 * Высота панели результатов.
 *
 * Доля экрана, а не фиксированные пиксели: на 4K-мониторе половина высоты —
 * это уже больше, чем весь экран ноутбука, а на ноутбуке та же половина не
 * вмещает и трёх промптов. Поэтому чем меньше экран, тем большую его долю
 * занимает панель — на маленьком экране места просто нет, чтобы его беречь.
 *
 * @param {number} viewportH высота окна, px
 * @param {number} dockTop сколько сверху занято полосами, px
 */
export function iterationPanelMaxHeight(viewportH, dockTop = 0) {
  const height = Number(viewportH) || 0;
  if (height <= 0) return 0;
  const share = height >= 1400 ? 0.5 : height >= 1000 ? 0.65 : 0.8;
  const available = Math.max(0, height - dockTop - 24);
  return Math.max(0, Math.round(Math.min(height * share, available)));
}

/**
 * Номер выделенного результата среди всех найденных — «7/135» в строке ввода.
 *
 * Считается ОТ СПИСКА, а не своим счётчиком: второй счётчик разошёлся бы с
 * выделением на первом же обновлении списка, и стрелки двигали бы одно, а
 * число показывало другое.
 *
 * @param {Array<object>} rows строки списка
 * @param {number} selectedIndex индекс выделенной строки
 * @returns {number} 1-based номер, либо 0 если выделено не совпадение
 */
export function iterationHitPosition(rows, selectedIndex) {
  let position = 0;
  for (let index = 0; index < (rows || []).length; index += 1) {
    if (rows[index]?.kind !== 'iteration') continue;
    position += 1;
    if (index === selectedIndex) return position;
  }
  return 0;
}

/**
 * Куда ведёт строка результата.
 *
 * Промпт живёт в конкретной вкладке, и вкладка эта открыта — иначе её тут не
 * было бы. Поэтому ответ короткий: какую вкладку показать и на какой промпт
 * прокрутить переписку.
 */
export function resolveIterationTarget(hit) {
  return {
    projectId: String(hit?.projectId || ''),
    tabId: String(hit?.tabId || ''),
    entryUuid: String(hit?.entryUuid || ''),
  };
}

/**
 * Разбить текст на куски «обычный / найденный» по смещениям от main.
 *
 * Renderer НЕ ищет сам: своё правило подсветки рано или поздно разошлось бы с
 * тем, по которому промпт вообще попал в список, и строка выглядела бы ложным
 * срабатыванием при верном совпадении.
 *
 * @param {string} text
 * @param {Array<{start:number,end:number}>} offsets
 * @returns {Array<{text: string, hit: boolean}>}
 */
export function splitByOffsets(text, offsets) {
  const source = String(text == null ? '' : text);
  const hits = (offsets || [])
    .filter((hit) => hit && Number.isFinite(hit.start) && Number.isFinite(hit.end) && hit.end > hit.start)
    .sort((left, right) => left.start - right.start);
  const parts = [];
  let cursor = 0;
  for (const hit of hits) {
    const start = Math.max(cursor, Math.min(hit.start, source.length));
    const end = Math.max(start, Math.min(hit.end, source.length));
    if (start > cursor) parts.push({ text: source.slice(cursor, start), hit: false });
    if (end > start) parts.push({ text: source.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), hit: false });
  return parts.length > 0 ? parts : [{ text: source, hit: false }];
}
