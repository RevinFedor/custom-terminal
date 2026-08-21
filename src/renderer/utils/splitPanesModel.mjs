// Pure rules of the split workspace.
//
// A pane = { projectId, tabId, tabs? }: a STRIP of tabs with exactly one of
// them shown. `tabId` is the shown one — the meaning it always had, so every
// reader that asks "which tab is in this pane" keeps working unchanged.
// `panes.length === 0` — single mode: the center shows ONE tab
// (store.centerTab). Focus is an index into panes; the focused pane's tab (or
// centerTab in single mode) is what every tab-owned surface (control bar,
// History, Timeline, task plan) follows.
//
// The CENTER is decoupled from the sidebar project: activating a tab changes
// only what the center shows, and an explicit project click (titlebar,
// dashboard, project chip in the attach row) moves ONLY the sidebar pointer
// (focusedProjectId) — it never activates a tab and never touches the panes.
//
// Approved navigation rule (one rule for sidebar click / Ctrl+Tab / Cmd+P —
// i.e. every TAB activation):
//   • target tab already visible in a pane → focus that pane, composition
//     unchanged;
//   • otherwise → the pane in focus replaces its tab with the target.

// ── How much the workspace holds: as much as the user asks for ────────────
//
// There is NO cap on columns or rows (removed 2026-08-17). Юзер: *«ограничение
// на количество окон быть не должно… я открыл 4 окна и новые создать не могу,
// такого быть не должно»*.
//
// The caps existed to protect readability — a terminal squeezed under ~300px
// stops being usable. But that protection was already being done by something
// else, and better: SPLIT_MIN_FRACTION keeps every pane at ≥15% of the axis, and
// the user can drag the dividers. A hard count did not add safety on top of
// that; it only refused a layout the user had explicitly asked for, from a rule
// nobody could see. Judging "too small" belongs to the person looking at the
// screen, not to a constant guessing at their monitor.
//
// The history of these numbers is a warning about counting the wrong thing. It
// started as a flat "at most 3 panes", written when a pane and a column were the
// same thing. Vertical splitting arrived later and silently changed what that
// number meant: it stopped capping the columns on screen and started capping the
// whole GRID, forbidding a 2×2 layout that is only two columns wide. That was
// fixed by splitting it into two caps — and the two caps then multiplied into a
// third, invisible limit of six panes, which is what the user hit. A limit that
// keeps changing meaning under you is a sign it was never the real constraint.
//
// Kept as `Infinity` rather than deleted so the call sites keep reading as
// "checked against the limit": bringing a cap back is then one line here, not an
// archaeology exercise across four functions. `MAX_SPLIT_PANES` also still names
// the restore-time truncation, which now truncates nothing.
export const MAX_SPLIT_COLUMNS = Infinity;
export const MAX_ROWS_PER_COLUMN = Infinity;
/** Total cap, derived — used for restore-time truncation, not for decisions. */
export const MAX_SPLIT_PANES = MAX_SPLIT_COLUMNS * MAX_ROWS_PER_COLUMN;

// ── Two dimensions ────────────────────────────────────────────────────────
//
// A pane carries a `column` index. The panes array stays FLAT and stays the
// single source of identity: focus is still an index into it, and activation,
// removal, restore and the tab lookups are untouched by the second dimension.
// Only GEOMETRY reads `column`.
//
// That is deliberate. Turning the list into a real tree would have rewritten
// every one of those rules at once; here the invariant is small enough to state
// in one line and check in one function:
//
//   panes are ordered by column; within a column, array order is row order.
//
// STORAGE RULE, and the whole reason this stays readable:
//
//   a purely horizontal layout stores NO `column` at all — byte-identical to
//   what was saved before this feature existed. `column` appears only once a
//   layout actually stacks, and then it appears on EVERY pane.
//
// So a missing column means "this pane is its own column, at its array
// position". That is what every legacy session is, and it restores unchanged.
// Reading a missing column as 0 instead would have stacked every restored
// layout into one column — same panes, same order, completely different
// screen. The pre-existing horizontal-split test caught exactly that.
//
// The mixed case (some panes with a column, some without) is never produced:
// normalizeColumns writes all-or-nothing.
const paneColumn = (pane, index) => {
  const c = Number(pane && pane.column);
  return Number.isFinite(c) && c >= 0 ? Math.floor(c) : index;
};

/** Columns as arrays of {pane, index}, left to right, rows top to bottom. */
export function paneColumns(panes) {
  const list = Array.isArray(panes) ? panes : [];
  const byColumn = new Map();
  list.forEach((pane, index) => {
    const col = paneColumn(pane, index);
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col).push({ pane, index });
  });
  return [...byColumn.keys()].sort((a, b) => a - b).map((col) => byColumn.get(col));
}

/**
 * Close gaps in column numbering and restore the sort invariant.
 *
 * Removing the only pane of a middle column would otherwise leave columns
 * [0, 2]: the geometry still renders two columns, but every index-based rule
 * that assumes "column N is the Nth column on screen" silently points one
 * column too far right.
 */
export function normalizeColumns(panes) {
  const columns = paneColumns(panes);
  // Nothing stacked → canonical legacy shape, no column fields at all. Keeps
  // saved sessions and object equality exactly as they were.
  const stacked = columns.some((rows) => rows.length > 1);
  const flat = [];
  columns.forEach((rows, columnIndex) => {
    rows.forEach(({ pane }) => {
      // When stacking, the column is written EXPLICITLY on every pane: after
      // this, a pane's column never depends on its array position again, so a
      // later splice cannot move it to a different column by accident.
      flat.push(stacked ? { ...pane, column: columnIndex } : stripColumn(pane));
    });
  });
  return flat;
}

// Column 0 is the default, so it is never stored — keeps saved layouts and
// equality checks identical to what they were before this feature.
const stripColumn = (pane) => {
  if (!pane || !('column' in pane)) return pane;
  const { column, ...rest } = pane;
  return rest;
};

// An EMPTY pane ({ projectId: '', tabId: '' }) is a placeholder slot: the
// user pressed the split button and has not picked the new pane's tab yet.
// It is focusable, invisible to tab lookups (no real tabId), never survives
// a restart (sanitizePanes drops it), and the next activation fills the
// focused placeholder through the standard replace rule.
export const isEmptyPane = (p) => !p || !p.tabId;

const clampIndex = (panes, index) => Math.max(0, Math.min(panes.length - 1, index | 0));

/**
 * ОДНО окно с вкладкой — это одиночный режим, просто другими словами.
 *
 * Правило старое (им заканчивается удаление окон), но раньше оно жило только
 * там: раскладка «из одного» иначе и не получалась. С рабочими пространствами
 * получается — новое пространство открывается одним ПУСТЫМ окном, и первая же
 * положенная туда вкладка его заполняет. Без схлопывания вокруг единственной
 * вкладки на весь экран остались бы рамка фокуса и шапка панели, то есть
 * состояние, которого в приложении никогда не было.
 *
 * Пустое окно НЕ схлопывается: оно и есть содержимое пустого пространства, а
 * «окон нет» здесь означает одиночный режим, который всегда показывает вкладку
 * центра — то есть чужая вкладка сама приехала бы в пустое пространство.
 *
 * Возвращает `null`, когда схлопывать нечего.
 */
export function collapseLonePane(panes) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length !== 1 || !list[0] || !list[0].tabId) return null;
  return { panes: [], focusedIndex: 0 };
}

const finalizeRemoval = (panes, focusedIndex, idx) => {
  const filtered = panes.filter((_, i) => i !== idx);
  const real = filtered.filter((p) => !isEmptyPane(p));
  // A split needs ≥2 REAL panes to stay a split; a dangling [real, empty]
  // pair collapses too (placeholder without a purpose).
  if (real.length <= 1) {
    // Name the pane that SURVIVED. Collapsing returns an empty list, so there
    // is no focus index left to read the answer from — and the caller needs
    // one, because single mode shows exactly one tab. Without this the center
    // kept showing the tab whose pane had just been removed, which is visible
    // every time the removed pane was the focused one.
    return { panes: [], focusedIndex: 0, survivor: real[0] || null };
  }
  let focus = focusedIndex;
  if (idx < focus) focus -= 1;
  // Emptying a middle column must not leave a hole in the numbering — see
  // normalizeColumns. Order is preserved, so the focus index still points at
  // the same pane.
  const next = normalizeColumns(filtered);
  return { panes: next, focusedIndex: clampIndex(next, focus), survivor: null };
};

// Activation of (projectId, tabId) with split active. Returns next state.
//
// Three cases:
//   • the tab is SHOWN somewhere      → focus that pane, change nothing;
//   • the tab has a CHIP somewhere    → focus that pane and show it there;
//   • the tab is nowhere              → it REPLACES the shown chip of the
//                                       focused window, in place.
//
// The last case has been BOTH ways, and the second reversal is deliberate, not
// a forgotten lesson. Первая версия заменяла; юзер попросил добавление в конец
// (*«чтобы когда я слева нажимаю на вкладку, она не заменяла текущую, а
// открывалась в конце»*) — тогда обычный клик был ЕДИНСТВЕННЫМ жестом, и
// замена молча уносила из окна вкладку, которую человек сам туда положил.
// С появлением ⌘-клика («открыть в новом окне») жестов стало два, и роли
// разделились: обычный клик МЕНЯЕТ текущее окно, ⌘ добавляет новое. Юзер о
// возвращённом append: *«клик по вкладке не кладёт, меняет окно, а добавляет в
// конце»* — то есть рост полосы от навигации снова стал багом.
//
// В КОНЕЦ полосы вкладка попадает жестами, которые так и называются: двойной
// клик по шапке, «Move to window», перетаскивание. Активация — «покажи здесь»,
// и её след в полосе — замена показанного чипа, с уходом прежнего в историю
// окна (⌘[ вернёт его).
export function resolveSplitActivation(panes, focusedIndex, projectId, tabId) {
  if (!Array.isArray(panes) || panes.length === 0) {
    return { panes: [], focusedIndex: 0, changed: false };
  }
  const shownAt = panes.findIndex((p) => p && p.tabId && p.tabId === tabId);
  if (shownAt >= 0) {
    return { panes, focusedIndex: shownAt, changed: shownAt !== focusedIndex };
  }
  const heldAt = paneIndexHoldingTab(panes, tabId);
  if (heldAt >= 0) {
    // Its window already has a slot for it: show it there rather than dragging
    // it into whichever pane happens to hold focus. A tab lives in one window,
    // and activation goes TO the tab — moving the tab to the focus would tear it
    // out of the strip the user built.
    const pane = panes[heldAt];
    const next = panes.slice();
    next[heldAt] = paneWithHistoryFrom(paneWithTabs(pane, paneTabs(pane), tabId), pane);
    return { panes: next, focusedIndex: heldAt, changed: true };
  }
  const at = clampIndex(panes, focusedIndex);
  const slot = panes[at];
  const next = panes.slice();
  // REPLACE the shown chip in place: the incoming tab takes the slot the shown
  // one occupied, so the positions the user navigates by do not shift, and the
  // strip does not grow from ordinary navigation. The outgoing tab leaves the
  // window (its chip is gone) and lands in the pane's history — the pane's own
  // ⌘[ brings it back.
  //
  // An EMPTY window (a placeholder) has no strip at all — replaceInStrip on an
  // empty list is an insert, so the tab simply fills it.
  //
  // The pane keeps its COLUMN, and this is why the strip is rebuilt through
  // `paneWithTabs(slot, …)` rather than written as a bare {projectId, tabId}:
  // that dropped the column and the pane silently jumped out of its stack —
  // measured live, filling the lower row of a split column turned two stacked
  // 409px rows into two 623px side-by-side columns.
  const swapped = replaceInStrip(paneTabs(slot), slot.tabId, projectId, tabId);
  next[at] = paneWithHistoryFrom(paneWithTabs(slot, swapped, tabId), slot);
  const lone = collapseLonePane(next);
  if (lone) return { ...lone, changed: true };
  return { panes: next, focusedIndex: at, changed: true };
}

// ── The strip: a pane holds a LIST of tabs, one of them shown ─────────────
//
// A pane used to hold exactly one tab, so "what is in this window" and "what is
// on screen in it" were the same sentence. They are now two:
//
//   pane.tabs   — the strip, in the order the chips are drawn, left to right
//   pane.tabId  — which of them is SHOWN (unchanged meaning, unchanged readers)
//
// STORAGE RULE, the same one `column` follows: a single-tab pane stores NO
// `tabs` at all, byte-identical to every layout saved before this existed. The
// list appears the moment a second chip does. So a missing list means "the strip
// is just [tabId]" — which is what every legacy session is, and it restores
// unchanged. `paneTabs` is the only reader of the raw field for that reason:
// nothing else may treat "absent" as "empty".
//
// The array stays FLAT and stays the source of truth for order. Order is the
// user's (double-click appends, drag would reorder) — never recency, because the
// strip is a MAP the user builds, and a map that reshuffles itself is unreadable.
// That is the same lesson the pane header's recent-list died of.

// A strip entry is {projectId, tabId} — the same shape as a history entry and as
// the pane itself. Ids alone would have been shorter and wrong: panes are
// cross-project, so "close this project" has to find its chips inside strips,
// and a bare id cannot answer whose it is.
//
// The three operations below work on a BARE strip, with no pane around it,
// because the same strip exists in a place that has no pane: the single-mode
// centre, where the workspace is not split at all. Sharing the arithmetic is the
// point — the two surfaces must agree on what "add", "remove" and "replace in
// place" mean, or the header would behave differently before and after a split.

/** Insert a chip; `at` omitted appends. Existing chip → unchanged. */
export function insertIntoStrip(strip, projectId, tabId, at = null) {
  const list = Array.isArray(strip) ? strip : [];
  if (!tabId || list.some((e) => e && e.tabId === tabId)) return list;
  const insertAt = at === null || at === undefined
    ? list.length
    : Math.max(0, Math.min(list.length, at | 0));
  const next = list.slice();
  next.splice(insertAt, 0, { projectId, tabId });
  return next;
}

/** Drop a chip. Returns the same array when it was not there. */
export function removeFromStrip(strip, tabId) {
  const list = Array.isArray(strip) ? strip : [];
  if (!tabId || !list.some((e) => e && e.tabId === tabId)) return list;
  return list.filter((e) => e && e.tabId !== tabId);
}

/**
 * Swap one chip for another WITHOUT moving it — the shape of ordinary
 * navigation: a window shows something else now, but the strip the user built
 * keeps its order and its other chips.
 */
export function replaceInStrip(strip, outgoingTabId, projectId, tabId) {
  const list = Array.isArray(strip) ? strip : [];
  if (!tabId) return list;
  if (list.some((e) => e && e.tabId === tabId)) return list; // already a chip
  const at = list.findIndex((e) => e && e.tabId === outgoingTabId);
  if (at === -1) return insertIntoStrip(list, projectId, tabId);
  const next = list.slice();
  next[at] = { projectId, tabId };
  return next;
}

/** The pane's strip, in chip order. Never empty for a real pane. */
export function paneTabs(pane) {
  if (!pane) return [];
  const list = Array.isArray(pane.tabs) ? pane.tabs.filter((e) => e && e.tabId) : [];
  if (list.length > 0) return list;
  return pane.tabId ? [{ projectId: pane.projectId, tabId: pane.tabId }] : [];
}

/**
 * Does this pane hold that tab at all — shown, or merely present as a chip?
 *
 * Id-only, because tab ids are globally unique (`<projectId>-tab-<n>`) and every
 * caller of this one has nothing but an id: "a tab was closed", "is this tab
 * anywhere". The map below is the exception — it is given a PAIR and must honour
 * it, so it uses the strict form.
 */
export function paneHoldsTab(pane, tabId) {
  return !!tabId && paneTabs(pane).some((e) => e.tabId === tabId);
}

/** Strict form: the chip must belong to that project too. */
function paneHoldsTabOfProject(pane, projectId, tabId) {
  return !!tabId && paneTabs(pane).some((e) => e.tabId === tabId && e.projectId === projectId);
}

/**
 * Write a strip back onto a pane, collapsing the single-tab case to the legacy
 * shape (see the storage rule above).
 *
 * The pane's own projectId follows the SHOWN tab, because that is what it has
 * always meant — every existing reader of pane.projectId is asking about what is
 * on screen there.
 */
function paneWithTabs(pane, tabs, shownTabId) {
  const list = tabs.filter((e) => e && e.tabId);
  const shown = list.find((e) => e.tabId === shownTabId) || list[0] || null;
  const { tabs: _drop, ...rest } = pane || {};
  const next = { ...rest, projectId: shown ? shown.projectId : '', tabId: shown ? shown.tabId : '' };
  if (list.length > 1) next.tabs = list.map((e) => ({ projectId: e.projectId, tabId: e.tabId }));
  return next;
}

/** Every tab held by any pane — shown or not. The switcher's "on screen" set. */
export function allPaneTabIds(panes) {
  const out = [];
  (Array.isArray(panes) ? panes : []).forEach((pane) => {
    paneTabs(pane).forEach(({ tabId }) => { if (!out.includes(tabId)) out.push(tabId); });
  });
  return out;
}

/** Which pane holds this tab (shown or not), or -1. */
export function paneIndexHoldingTab(panes, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  if (!tabId) return -1;
  return list.findIndex((pane) => paneHoldsTab(pane, tabId));
}

/**
 * Add a tab to a pane's strip and show it. Already there → just show it.
 *
 * ONE TAB LIVES IN ONE WINDOW, and this is where that is enforced: a tab that
 * was in another window LEAVES it. The chip MOVES, it is never copied.
 *
 * Two panes naming the same tab is not a cosmetic duplicate. A live terminal is
 * one DOM node, so it is drawn in exactly one of them — and the other window
 * loses everything, header included, because a window's whole chrome is
 * rendered by the tab it shows. What the user sees is not "the same tab twice"
 * but a black rectangle where a window used to be: *«переместил вкладку — окно
 * тупо пропало»*. The window was intact the whole time; it was showing a tab
 * that was being drawn somewhere else.
 *
 * The invariant lives here and not in the callers because there is no caller
 * for whom the copy would be right: putting a tab into a window always means it
 * is now THERE. So «move to window» needs no detach step of its own, and the
 * next caller cannot forget one.
 *
 * A window whose last chip left this way becomes a placeholder — «нет вкладки»,
 * waiting for the next tab — not a closed window: taking a tab out of a window
 * is not dismissing the window. Their indices come back in `emptied`, and the
 * indices of everything else survive, because a placeholder keeps its slot.
 *
 * `at` inserts at a position; omitted appends (the double-click on empty header
 * space, which always means "one more, at the end"). Returns null when nothing
 * changes, so callers skip the write.
 */
export function addTabToPane(panes, paneIndex, projectId, tabId, at = null) {
  const list = Array.isArray(panes) ? panes : [];
  if (!list[paneIndex] || !tabId) return null;
  // Detach FIRST, from every OTHER pane: only after that does the target's own
  // strip describe the whole truth. Removal never changes the array length, so
  // `paneIndex` still means the same window below.
  let detached = list;
  const emptied = [];
  list.forEach((pane, index) => {
    if (index === paneIndex || !paneHoldsTab(pane, tabId)) return;
    const res = removeTabFromPane(detached, index, tabId);
    if (!res) return;
    detached = res.panes;
    if (res.emptied) emptied.push(index);
  });
  const moved = detached !== list;
  const pane = detached[paneIndex];
  const strip = paneTabs(pane);
  if (strip.some((e) => e.tabId === tabId)) {
    if (pane.tabId === tabId) return moved ? { panes: detached, emptied } : null;
    const next = detached.slice();
    next[paneIndex] = paneWithHistoryFrom(paneWithTabs(pane, strip, tabId), pane);
    return { panes: next, emptied };
  }
  const insertAt = at === null || at === undefined
    ? strip.length
    : Math.max(0, Math.min(strip.length, at | 0));
  const grown = strip.slice();
  grown.splice(insertAt, 0, { projectId, tabId });
  const next = detached.slice();
  // The outgoing SHOWN tab goes into the pane's history: it stops being visible
  // here even though its chip stays. The history answers "what did this window
  // show before", which is exactly what changed.
  next[paneIndex] = paneWithHistoryFrom(paneWithTabs(pane, grown, tabId), pane);
  return { panes: next, emptied };
}

/**
 * Remove a tab from ONE pane's strip.
 *
 * When the removed tab was the shown one, the NEIGHBOUR takes over — the chip to
 * the right, or the left when there is none. Not the freshest, not the first:
 * the strip is a spatial map, and after a chip goes the eye is already where its
 * neighbour is. (Same reason the strip is not ordered by recency.)
 *
 * Returns `{ panes, emptied }`; `emptied` is true when the last chip left and the
 * pane became a placeholder. Only the placeholder's own ✕ closes the window —
 * clearing what is inside a window is not dismissing the window.
 */
export function removeTabFromPane(panes, paneIndex, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  const pane = list[paneIndex];
  if (!pane || !tabId) return null;
  const strip = paneTabs(pane);
  const at = strip.findIndex((e) => e.tabId === tabId);
  if (at === -1) return null;
  const rest = strip.filter((e) => e.tabId !== tabId);
  const next = list.slice();
  if (rest.length === 0) {
    const { tabs: _drop, ...bare } = pane;
    next[paneIndex] = { ...bare, projectId: '', tabId: '' };
    return { panes: next, emptied: true };
  }
  const shown = pane.tabId === tabId
    ? rest[Math.min(at, rest.length - 1)].tabId
    : pane.tabId;
  // History only moves when what is SHOWN changes.
  const rebuilt = paneWithTabs(pane, rest, shown);
  next[paneIndex] = pane.tabId === tabId ? paneWithHistoryFrom(rebuilt, pane) : rebuilt;
  return { panes: next, emptied: false };
}

/**
 * A tab was closed or moved away entirely: drop it from EVERY strip.
 *
 * A pane that held it without showing it simply loses a chip — nothing about the
 * layout changes there, which is why this is separate from emptyPaneByClosedTab.
 * Returns null when no strip contained it.
 */
export function dropTabFromAllPaneStrips(panes, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  if (!tabId) return null;
  let changed = false;
  let next = list;
  list.forEach((pane, index) => {
    if (!paneHoldsTab(pane, tabId)) return;
    const res = removeTabFromPane(next, index, tabId);
    if (!res) return;
    changed = true;
    next = res.panes;
  });
  return changed ? { panes: next } : null;
}

/**
 * Tabs changed OWNER (moved to another project). Rewrite the project on every
 * chip that names one of them, in every strip.
 *
 * Three call sites move tabs across projects (one tab, a selection, a whole
 * group) and each used to patch only the pane's own `projectId` — i.e. only the
 * SHOWN chip. An unshown chip kept pointing at the project the tab had left, and
 * the next restore would drop it as a tab that does not exist there.
 *
 * @param {(tabId: string) => boolean} moved  is this tab one of the moved ones
 */
export function reprojectPaneTabs(panes, moved, projectId) {
  const list = Array.isArray(panes) ? panes : [];
  return list.map((pane) => {
    if (!pane || !pane.tabId) return pane;
    const strip = paneTabs(pane);
    if (!strip.some((e) => moved(e.tabId))) return pane;
    const next = strip.map((e) => (moved(e.tabId) ? { projectId, tabId: e.tabId } : e));
    return paneWithTabs(pane, next, pane.tabId);
  });
}

/**
 * Move a tab's chip within its own strip (drag inside the header).
 * Returns null when the move is a no-op.
 */
export function reorderPaneTab(panes, paneIndex, tabId, toIndex) {
  const list = Array.isArray(panes) ? panes : [];
  const pane = list[paneIndex];
  if (!pane || !tabId) return null;
  const strip = paneTabs(pane);
  const from = strip.findIndex((e) => e.tabId === tabId);
  if (from === -1) return null;
  const to = Math.max(0, Math.min(strip.length - 1, toIndex | 0));
  if (to === from) return null;
  const moved = strip.slice();
  const [entry] = moved.splice(from, 1);
  moved.splice(to, 0, entry);
  const next = list.slice();
  next[paneIndex] = paneWithTabs(pane, moved, pane.tabId);
  return { panes: next };
}

/**
 * Поменять местами СОДЕРЖИМОЕ двух окон.
 *
 * Не то же, что «перенести вкладку в другое окно»: там вкладка уходит из одного
 * места в другое, а окно, откуда она ушла, живёт дальше своей жизнью. Здесь
 * меняются местами два окна целиком — со всеми своими вкладками, с тем, какая
 * из них показана, и с их прошлым. Юзер: *«у меня есть окно, в нём 6 вкладок; я
 * выбираю другое окно, и эти два окна меняются местами»*.
 *
 * МЕСТО остаётся за окном, а не переезжает с содержимым: колонка и порядок строк
 * — это раскладка на экране, и обмен не должен её перекраивать. Поэтому
 * переставляется всё, КРОМЕ `column`: два окна разной высоты просто обменялись
 * содержимым, а сетка осталась той же самой.
 *
 * Фокус едет ЗА СОДЕРЖИМЫМ: человек назвал два окна и ждёт, что его вкладки
 * окажутся на новом месте, — значит и рамка фокуса должна быть там же.
 */
export function swapPanes(panes, focusedIndex, a, b) {
  const list = Array.isArray(panes) ? panes : [];
  const from = a | 0;
  const to = b | 0;
  if (from === to) return null;
  if (!list[from] || !list[to]) return null;
  const next = list.slice();
  // Колонка принадлежит МЕСТУ: снимаем её с приезжающего окна и надеваем ту,
  // что была у места. Пустые панели тоже участвуют — «поменять местами с пустым
  // окном» это законный способ подвинуть содержимое, не создавая ничего нового.
  const keepColumn = (pane, place, placeIndex) => {
    const column = paneColumn(place, placeIndex);
    const body = stripColumn(pane);
    return 'column' in place ? { ...body, column } : body;
  };
  next[from] = keepColumn(list[to], list[from], from);
  next[to] = keepColumn(list[from], list[to], to);
  const focused = focusedIndex === from ? to : focusedIndex === to ? from : focusedIndex;
  return { panes: normalizeColumns(next), focusedIndex: focused };
}

// ── What this pane showed before ──────────────────────────────────────────
//
// Recency at PANE level, which the global tab history cannot answer: "what was
// in THIS slot before the current tab" is a different question from "which tab
// did the user visit before". Started as a single prev slot (one step back for
// the file middle-click); now a LIST, because the per-pane Ctrl+Tab switcher
// navigates the pane's own past — same mechanism, deeper.
//
// The list holds what the pane showed BEFORE its current tab, most recent
// first, deduped, capped. It rides on the pane object itself, so it persists
// with the layout and dies with the pane — a pane's history has no meaning
// once the pane is gone.
export const PANE_HISTORY_CAP = 60; // = GLOBAL_TAB_MRU_CAP; both lists answer "where was I"

/**
 * The pane's visit list. Reads the legacy one-step `prevProjectId/prevTabId`
 * shape as a one-entry history, so sessions saved before the list existed
 * restore with their memory intact.
 */
export function paneHistory(pane) {
  if (!pane) return [];
  if (Array.isArray(pane.history)) return pane.history;
  if (pane.prevTabId) return [{ projectId: pane.prevProjectId, tabId: pane.prevTabId }];
  return [];
}

const pushHistoryEntry = (history, outgoing) => {
  if (!outgoing || !outgoing.tabId) return history.slice(0, PANE_HISTORY_CAP);
  const filtered = history.filter((e) => e && e.tabId !== outgoing.tabId);
  return [{ projectId: outgoing.projectId, tabId: outgoing.tabId }, ...filtered]
    .slice(0, PANE_HISTORY_CAP);
};

/**
 * Build the pane object that replaces `previousPane` with `nextPane`, carrying
 * the history forward with the outgoing tab pushed on top.
 *
 * EVERY writer that swaps a pane's tab must go through this. The pane object is
 * rebuilt from scratch on activation, so anything not explicitly carried is
 * silently erased — that is exactly how the one-step prev field would have
 * vanished, and how the history would quietly reset on every switch.
 */
export function paneWithHistoryFrom(nextPane, previousPane) {
  const prior = paneHistory(previousPane).filter((e) => e && e.tabId !== nextPane.tabId);
  if (!previousPane || !previousPane.tabId || previousPane.tabId === nextPane.tabId) {
    return prior.length > 0 ? { ...nextPane, history: prior } : nextPane;
  }
  return { ...nextPane, history: pushHistoryEntry(prior, previousPane) };
}

/**
 * The pane's history filtered down to what can actually be SHOWN here now:
 * entries whose tab still exists and is not currently visible in any pane
 * (including this pane's own current tab). This is the row source for the
 * per-pane switcher and the step-back target list — one filter, two consumers.
 */
export function restorablePaneHistory(panes, paneIndex, tabExists = () => true) {
  const list = Array.isArray(panes) ? panes : [];
  const pane = list[paneIndex];
  if (!pane) return [];
  // Anything with a CHIP counts as already here: offering it as a "bring back"
  // would be offering a click on a chip the user can already see.
  const visible = new Set(allPaneTabIds(list));
  return paneHistory(pane).filter((e) => (
    e && e.tabId && !visible.has(e.tabId) && tabExists(e.projectId, e.tabId)
  ));
}

/**
 * Middle-click on a pane showing a FILE: put the pane's previous tab back
 * instead of removing the pane. Steps to the first RESTORABLE entry — a dead
 * or elsewhere-visible head does not kill the gesture when an older entry is
 * still valid.
 *
 * Returns null when there is nothing to step back to — the caller then falls
 * back to the normal "remove this pane" behaviour, so the gesture never becomes
 * a no-op.
 */
export function restorePanePreviousTab(panes, focusedIndex, tabId, tabExists = () => true) {
  const list = Array.isArray(panes) ? panes : [];
  const idx = list.findIndex((p) => p && p.tabId === tabId);
  if (idx === -1) return null;
  const candidates = restorablePaneHistory(list, idx, tabExists);
  if (candidates.length === 0) return null;
  const target = candidates[0];
  const pane = list[idx];
  const next = list.slice();
  // The restored tab takes the OUTGOING chip's place in the strip: this gesture
  // undoes "I opened a file here", so the slot it opened into is exactly where
  // the previous tab belongs. Other chips are untouched.
  const strip = paneTabs(pane).map((entry) => (
    entry.tabId === tabId ? { projectId: target.projectId, tabId: target.tabId } : entry
  ));
  // The outgoing tab becomes the newest history entry, so the gesture toggles;
  // everything older survives underneath.
  next[idx] = paneWithHistoryFrom(paneWithTabs(pane, strip, target.tabId), pane);
  return { panes: next, focusedIndex: clampIndex(next, focusedIndex), restoredIndex: idx };
}

/**
 * Drop one tab from ONE pane's history (middle-click on a row of the pane's
 * switcher list — "forget this", not "close this"). Returns null when nothing
 * changed, so callers can skip the store write.
 */
export function dropFromPaneHistory(panes, paneIndex, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  const pane = list[paneIndex];
  if (!pane || !tabId) return null;
  const history = paneHistory(pane);
  const filtered = history.filter((e) => e && e.tabId !== tabId);
  const hadLegacy = !Array.isArray(pane.history) && !!pane.prevTabId;
  if (filtered.length === history.length && !hadLegacy) return null;
  const next = list.slice();
  // Normalise to the list shape while dropping the legacy prev fields — after a
  // removal they would resurrect the entry on the next paneHistory read.
  const { prevProjectId, prevTabId, ...rest } = pane;
  next[paneIndex] = filtered.length > 0 ? { ...rest, history: filtered } : stripHistory(rest);
  return { panes: next };
}

/**
 * A tab was CLOSED: purge it from every pane's history. A closed tab must not
 * be offered as a step-back target anywhere (restorablePaneHistory would skip
 * it anyway, but a dead entry also wastes the cap and survives into the saved
 * session).
 */
export function dropTabFromAllPaneHistories(panes, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  if (!tabId) return null;
  let changed = false;
  const next = list.map((pane, i) => {
    const res = dropFromPaneHistory(list, i, tabId);
    if (!res) return pane;
    changed = true;
    return res.panes[i];
  });
  return changed ? { panes: next } : null;
}

const stripHistory = (pane) => {
  if (!pane || !('history' in pane)) return pane;
  const { history, ...rest } = pane;
  return rest;
};

// ПКМ «Добавить в рабочую область». From single mode the current center tab
// becomes pane 0 and the added tab pane 1. An existing empty placeholder is
// filled instead of appending a third column. Returns null when nothing to do
// (same tab, already present, or the workspace is full).
export function addPane(panes, focusedIndex, current, added) {
  if (!added || !added.tabId) return null;
  // Already SOMEWHERE in the workspace — including as an unshown chip. A tab
  // lives in one window; a second copy would be a second live terminal for the
  // same session, which cannot exist.
  if (paneIndexHoldingTab(panes, added.tabId) >= 0) return null;
  if (panes.length === 0) {
    if (!current || !current.tabId || current.tabId === added.tabId) return null;
    return { panes: [current, added], focusedIndex: 1 };
  }
  const emptyIdx = panes.findIndex(isEmptyPane);
  if (emptyIdx >= 0) {
    const next = panes.slice();
    // Same rule as resolveSplitActivation: the placeholder's COLUMN is part of
    // the layout the user built, not part of the tab being dropped into it.
    const slot = panes[emptyIdx];
    next[emptyIdx] = slot && slot.column !== undefined
      ? { ...added, column: slot.column }
      : added;
    return collapseLonePane(next) || { panes: next, focusedIndex: emptyIdx };
  }
  // Appending puts the tab in a NEW column, so the column cap decides.
  if (paneColumns(panes).length >= MAX_SPLIT_COLUMNS) return null;
  return { panes: [...panes, added], focusedIndex: panes.length };
}

/**
 * Can this pane still be split, and in which direction?
 *
 * ONE answer for the button, its menu and the model, so the control can be
 * DISABLED with a reason instead of vanishing — a control that disappears at
 * the limit reads as a bug ("кнопка пропала"), while a greyed one with a
 * tooltip states the rule.
 */
export function splitAvailability(panes, paneIndex) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length === 0) return { horizontal: true, vertical: true, reason: null };
  if (list.some(isEmptyPane)) {
    return { horizontal: false, vertical: false, reason: 'placeholder' };
  }
  const columns = paneColumns(list);
  const horizontal = columns.length < MAX_SPLIT_COLUMNS;
  const idx = clampIndex(list, paneIndex === null || paneIndex === undefined ? 0 : paneIndex);
  const column = paneColumn(list[idx], idx);
  const rowsHere = list.filter((pane, i) => paneColumn(pane, i) === column).length;
  const vertical = rowsHere < MAX_ROWS_PER_COLUMN;
  return {
    horizontal,
    vertical,
    reason: horizontal || vertical ? null : (columns.length >= MAX_SPLIT_COLUMNS ? 'columns-full' : 'rows-full'),
  };
}

// Split button in the attach row: open a new EMPTY pane and focus it. From
// single mode the current center tab becomes pane 0. Only one placeholder at
// a time — a second click while one is open is a no-op. `afterIndex` is the
// pane the button was pressed in: the placeholder opens immediately to its
// RIGHT (pressing split in pane 0 of [A,B] gives [A,∅,B], not [A,B,∅]).
export function addEmptyPane(panes, focusedIndex, current, afterIndex = null) {
  if (!Array.isArray(panes)) return null;
  if (panes.length === 0) {
    if (!current || !current.tabId) return null;
    return { panes: [stripColumn(current), { projectId: '', tabId: '' }], focusedIndex: 1 };
  }
  // This gesture opens a NEW COLUMN, so it is capped by columns — not by the
  // total pane count, which would refuse while the screen still has room.
  if (paneColumns(panes).length >= MAX_SPLIT_COLUMNS) return null;
  if (panes.some(isEmptyPane)) return null;

  // A horizontal split opens a NEW COLUMN right of the pressed pane's column,
  // so everything at or beyond it shifts one column right. Without this, a
  // pane split sideways inside a column that was itself split vertically would
  // silently join that column as another row — i.e. the opposite direction.
  const anchorIndex = afterIndex === null
    ? clampIndex(panes, focusedIndex)
    : clampIndex(panes, afterIndex);
  const anchorColumn = paneColumn(panes[anchorIndex], anchorIndex);
  const newColumn = anchorColumn + 1;

  const shifted = panes.map((pane, index) => {
    const col = paneColumn(pane, index);
    return col >= newColumn ? { ...pane, column: col + 1 } : { ...pane, column: col };
  });
  // Keep the flat array sorted by column: the placeholder goes after the last
  // pane of the anchor's column.
  let insertAt = shifted.length;
  for (let i = 0; i < shifted.length; i += 1) {
    if (paneColumn(shifted[i], i) > anchorColumn) { insertAt = i; break; }
  }
  const next = shifted.slice();
  next.splice(insertAt, 0, { projectId: '', tabId: '', column: newColumn });
  // normalizeColumns strips the columns again if the result is purely
  // horizontal — the common case, and the one that must stay legacy-shaped.
  return { panes: normalizeColumns(next), focusedIndex: insertAt };
}

/**
 * Right-click on the split button: open an empty pane ABOVE or BELOW the pane
 * it was pressed in, inside that pane's own column.
 *
 * From single mode the current center tab becomes the first pane, exactly as
 * the horizontal split does — the two gestures differ only in which direction
 * the new slot opens.
 */
export function addEmptyPaneVertical(panes, focusedIndex, current, atIndex, side = 'below') {
  if (!Array.isArray(panes)) return null;
  const placeholder = { projectId: '', tabId: '' };

  if (panes.length === 0) {
    if (!current || !current.tabId) return null;
    // BOTH panes must carry column 0 explicitly. Leaving the column off would
    // mean "each pane is its own column" (the storage rule above) — i.e. the
    // horizontal split, which is the opposite of what was asked. Measured
    // live before this was fixed: two 623px columns side by side, equal
    // height, instead of one column of two half-height rows.
    const first = { ...current, column: 0 };
    const added = { ...placeholder, column: 0 };
    return side === 'above'
      ? { panes: [added, first], focusedIndex: 0 }
      : { panes: [first, added], focusedIndex: 1 };
  }

  if (panes.some(isEmptyPane)) return null;

  const anchorIndex = clampIndex(panes, atIndex === null || atIndex === undefined ? focusedIndex : atIndex);
  const anchor = panes[anchorIndex];
  if (!anchor) return null;

  const column = paneColumn(anchor, anchorIndex);
  // This gesture stacks INSIDE one column, so only that column's height is at
  // stake: a full neighbouring column must not block it.
  const rowsHere = panes.filter((pane, index) => paneColumn(pane, index) === column).length;
  if (rowsHere >= MAX_ROWS_PER_COLUMN) return null;
  // Every column becomes explicit BEFORE splicing: with implicit columns an
  // insertion shifts array positions and therefore silently re-columns every
  // pane after it. This call always stacks, so the explicit form is the
  // canonical one here.
  const next = panes.map((pane, index) => ({ ...pane, column: paneColumn(pane, index) }));
  // Inserting directly beside the anchor keeps the flat array sorted by column
  // AND puts the new row in the right vertical position within that column.
  const insertAt = side === 'above' ? anchorIndex : anchorIndex + 1;
  next.splice(insertAt, 0, { ...placeholder, column });
  return { panes: next, focusedIndex: insertAt };
}

// Remove a tab's pane (ПКМ «Убрать окно»). A single remaining REAL pane
// collapses the split back to single mode. This closes the WINDOW, so it takes
// the whole strip with it — unlike emptyPaneByClosedTab, which removes one chip.
export function removePaneByTab(panes, focusedIndex, tabId) {
  if (!tabId) return null;
  const idx = paneIndexHoldingTab(panes, tabId);
  if (idx === -1) return null;
  return finalizeRemoval(panes, focusedIndex, idx);
}

/**
 * Take a tab OUT OF ITS PANE, leaving the pane itself in place and empty.
 *
 * Two intentions used to run the same code, and both of them destroyed the
 * slot the user had built:
 *   • «закрыть вкладку» (sidebar list, ✕) — the tab is deleted, but the layout
 *     is not part of what was deleted;
 *   • «убрать вкладку из окна» (middle-click on the pane's chip) — the tab goes
 *     on living in the sidebar, it simply stops being SHOWN here.
 * Both end the same way: the pane stays and becomes a placeholder waiting for
 * the next tab. Closing the pane itself is a separate gesture (the ✕ that a
 * placeholder shows) — a window is not something you dismiss by accident while
 * clearing what is inside it.
 *
 * Reported live, twice: a tab open in the second column was closed from the
 * sidebar and the whole pane vanished with it; and the middle-click on the
 * chip removed the pane instead of just emptying it.
 *
 * TWO panes count exactly like three: the second window STAYS and goes empty.
 * The first version collapsed a two-pane split to single mode here, reasoning
 * that "one live pane plus a placeholder is a split of one" — but that is the
 * layout question, and this gesture is not about the layout at all. Reported
 * live: with two windows open, clearing one closed it, because two is the
 * common case and the collapse rule swallowed it. Only the placeholder's own ✕
 * closes a window.
 *
 * With STRIPS this removes ONE CHIP, not the window's contents: the neighbouring
 * chip takes over and the window goes empty only when the last one leaves. Same
 * sentence as before, one level finer — "the pane stays, it just stops showing
 * this tab" now has a step between "showing it" and "showing nothing".
 *
 * Returns null when the tab has no pane.
 */
export function emptyPaneByClosedTab(panes, focusedIndex, tabId) {
  const list = Array.isArray(panes) ? panes : [];
  if (!tabId) return null;
  const idx = paneIndexHoldingTab(list, tabId);
  if (idx === -1) return null;
  // The slot keeps its COLUMN — the geometry the user built is what stays. The
  // strip's other chips stay too; history is carried by removeTabFromPane when
  // what is SHOWN changes, and the entry for a closed tab is purged separately
  // (dropTabFromAllPaneHistories).
  const res = removeTabFromPane(list, idx, tabId);
  if (!res) return null;
  return { panes: res.panes, focusedIndex: clampIndex(res.panes, focusedIndex), emptiedIndex: idx };
}

// Remove a pane by position — the only way to close an EMPTY placeholder
// (✕ in its row or Escape while it is focused).
export function removePaneAt(panes, focusedIndex, index) {
  if (!Array.isArray(panes) || index < 0 || index >= panes.length) return null;
  return finalizeRemoval(panes, focusedIndex, index);
}

/**
 * A project was closed: its tabs are gone, so its CHIPS are gone.
 *
 * A pane survives if any chip of another project remains in it — closing one
 * project must not tear down a window that is also showing a different one. The
 * pane disappears only when the whole strip belonged to the closed project.
 */
export function removePanesByProject(panes, focusedIndex, projectId) {
  if (!projectId) return null;
  const list = Array.isArray(panes) ? panes : [];
  let changed = false;
  const rebuilt = list.map((pane) => {
    if (isEmptyPane(pane)) return pane;
    const strip = paneTabs(pane);
    const kept = strip.filter((e) => e.projectId !== projectId);
    if (kept.length === strip.length) return pane;
    changed = true;
    if (kept.length === 0) return null; // whole window belonged to that project
    return paneWithTabs(pane, kept, pane.tabId);
  });
  if (!changed) return null;
  const next = rebuilt.filter(Boolean);
  if (next.filter((p) => !isEmptyPane(p)).length <= 1) return { panes: [], focusedIndex: 0 };
  const focusedTab = list[clampIndex(list, focusedIndex)];
  const keptFocus = next.findIndex((p) => p && p.tabId === focusedTab?.tabId);
  return { panes: normalizeColumns(next), focusedIndex: keptFocus >= 0 ? keptFocus : 0 };
}

// Restore-time validation: keep panes whose tab still exists, PLUS windows the
// user deliberately left empty. A split needs at least two panes to survive.
// Each surviving pane's HISTORY is scrubbed of dead tabs too — entries for tabs
// deleted while the app was closed would otherwise sit in the saved layout
// forever.
//
// An empty pane used to be purely session-transient (the split button opens one
// and the next activation fills it, so losing it on restart cost nothing). Once
// clearing a window became a normal gesture, that stopped being true: a window
// the user emptied on purpose is part of the layout, and dropping it on restart
// silently closed a window they had chosen to keep.
export function sanitizePanes(panes, focusedIndex, tabExists) {
  const valid = (Array.isArray(panes) ? panes : [])
    .map((p) => {
      if (!p || typeof p.projectId !== 'string' || typeof p.tabId !== 'string') return null;
      if (!p.tabId) return p; // deliberately empty window
      // Scrub the STRIP, not just the shown tab: a chip whose tab was deleted
      // while the app was closed would restore as a dead chip, and if it was the
      // shown one the whole window would be dropped even though its other chips
      // are alive. The shown tab is re-picked from what survived, in strip order.
      const strip = paneTabs(p).filter((e) => e && e.tabId && tabExists(e.projectId, e.tabId));
      if (strip.length === 0) return null;
      return paneWithTabs(p, strip, p.tabId);
    })
    .filter(Boolean);
  // Одна вкладка — одно окно, и на входе с диска тоже. Раскладка приходит из
  // сохранённой сессии: она может быть старше этого правила или поправлена
  // руками, а вкладка, названная двумя окнами, рисуется только в одном — второе
  // остаётся чёрным прямоугольником без шапки. Снимаем дубликат ЗДЕСЬ, чтобы
  // такая раскладка не пережила перезапуск.
  //
  // Право на вкладку получает окно, которое её ПОКАЗЫВАЕТ: отобрать чип у него
  // значит погасить как раз то окно, где вкладка сейчас и нарисована. Среди
  // равных — первое по порядку. Окно, оставшееся совсем без чипов, уходит: это
  // не окно, которое человек намеренно оставил пустым.
  const owner = new Map();
  valid.forEach((pane, index) => {
    if (pane.tabId && !owner.has(pane.tabId)) owner.set(pane.tabId, index);
  });
  valid.forEach((pane, index) => {
    paneTabs(pane).forEach(({ tabId }) => { if (!owner.has(tabId)) owner.set(tabId, index); });
  });
  const unique = valid
    .map((pane, index) => {
      if (!pane.tabId) return pane; // намеренно пустое окно
      const strip = paneTabs(pane).filter((e) => owner.get(e.tabId) === index);
      return strip.length === 0 ? null : paneWithTabs(pane, strip, pane.tabId);
    })
    .filter(Boolean)
    .map((p) => {
      const history = paneHistory(p).filter((e) => e && e.tabId && tabExists(e.projectId, e.tabId));
      const { prevProjectId, prevTabId, ...rest } = p;
      return history.length > 0 ? { ...rest, history } : stripHistory(rest);
    });
  // Раскладка из одних пустых окон — ТОЖЕ раскладка. Это ровно то, как выглядит
  // только что созданное рабочее пространство: окно есть, вкладок в нём нет.
  //
  // Раньше здесь стояло «нет ни одной вкладки — значит, нечего восстанавливать»,
  // и это было верно, пока пустая панель означала «нажал деление, ещё не выбрал
  // вкладку». С пространствами такое состояние стало обычным и долгим, а его
  // потеря означает не «стало пусто», а обратное: без окон приложение переходит
  // в одиночный режим, который ВСЕГДА показывает вкладку центра — то есть чужая
  // вкладка сама приезжает в пустое пространство.
  //
  // Схлопывание одинокого НАСТОЯЩЕГО окна остаётся: одно окно с вкладкой и есть
  // одиночный режим, это не потеря, а то же самое другими словами.
  if (unique.length === 0) return { panes: [], focusedIndex: 0 };
  const loneUnique = collapseLonePane(unique);
  if (loneUnique) return loneUnique;
  // Truncation keeps whole COLUMNS: a flat slice can cut a stacked column in
  // half and leave a lone row where the user had a pair. Restores are already
  // within the caps in practice — this is the backstop for a hand-edited or
  // future-version session.
  const kept = [];
  paneColumns(unique).slice(0, MAX_SPLIT_COLUMNS).forEach((rows) => {
    rows.slice(0, MAX_ROWS_PER_COLUMN).forEach(({ pane }) => kept.push(pane));
  });
  const next = normalizeColumns(kept);
  if (next.length === 0) return { panes: [], focusedIndex: 0 };
  // То же правило после обрезки по пределам: уходит только одинокое окно С
  // ВКЛАДКОЙ (оно же одиночный режим), пустое остаётся.
  return collapseLonePane(next) || { panes: next, focusedIndex: clampIndex(next, focusedIndex) };
}

// ── Раскладка целиком, одним описанием ────────────────────────────────────
//
// Every function above is a GESTURE: one click's worth of change, with the
// guards a gesture needs (only one placeholder at a time, because a person has
// to fill it before making another). An API caller does not make gestures — it
// states the arrangement it wants: «эти две вкладки справа, каждая своим окном»
// or «эти две справа, в одном окне». Composing that out of gestures means four
// round-trips that can each half-fail, and the placeholder guard refuses the
// second step anyway.
//
// So this is its own path, and it is ATOMIC: one call returns the whole new
// layout or nothing. The nesting of `windows` carries the distinction that used
// to need a separate flag — outer array is windows, inner array is the strip
// inside one window:
//
//   [[codex], [claude]]   → two windows side by side
//   [[codex, claude]]     → one window, two chips
//
// A tab named here MOVES: it lives in exactly one window, so placing it
// somewhere is also taking it out of wherever it was.

/**
 * @param {Array} panes                   current panes ([] = single mode)
 * @param {number} focusedIndex
 * @param {object} spec
 * @param {number} [spec.anchorIndex]     window to place relative to (default: focused)
 * @param {'right'|'left'|'above'|'below'} spec.side
 * @param {Array<Array<{projectId: string, tabId: string}>>} spec.windows
 * @param {'columns'|'rows'} [spec.divide] how several windows divide the new area
 * @param {{projectId: string, tabId: string}|null} current  centre tab (single mode)
 * @returns {{panes: Array, focusedIndex: number, placedIndices: number[]}|null}
 */
export function arrangePanes(panes, focusedIndex, spec, current = null) {
  const windows = (Array.isArray(spec?.windows) ? spec.windows : [])
    .map((strip) => (Array.isArray(strip) ? strip.filter((e) => e && e.tabId) : []))
    .filter((strip) => strip.length > 0);
  if (windows.length === 0) return null;
  const side = spec?.side === 'left' || spec?.side === 'above' || spec?.side === 'below'
    ? spec.side
    : 'right';
  // TWO different questions, and conflating them was the first bug here:
  //   • WHERE the new area goes relative to the anchor  → `side`;
  //   • HOW several windows divide THAT area            → `divide`.
  // «справа, и раздели это окно на два по горизонтали» means one new column to
  // the right, split into two rows — not two rows added to the anchor's own
  // column, which is what a single flag produced.
  const intoAnchorColumn = side === 'above' || side === 'below';
  const divideRows = intoAnchorColumn || spec?.divide === 'rows';

  let list = Array.isArray(panes) ? panes.slice() : [];
  // Single mode: the centre becomes the first window, exactly as the split
  // gestures do — otherwise "put this to the right of what I am looking at"
  // would have nothing to be to the right OF.
  if (list.length === 0) {
    if (!current || !current.tabId) return null;
    list = [stripColumn(current)];
  }

  // The named tabs are MOVING: pull them out of wherever they are now. A window
  // that loses its last chip this way disappears — it was showing one of the
  // tabs being rearranged, so leaving an empty box behind would be leaving
  // debris from the very move the caller asked for. A window the user had
  // deliberately left empty is untouched (it holds none of these tabs).
  const anchorPaneBefore = list[clampIndex(list, (
    Number.isInteger(spec?.anchorIndex) ? spec.anchorIndex : focusedIndex
  ))];
  const moving = windows.flat();
  moving.forEach(({ tabId }) => {
    const res = dropTabFromAllPaneStrips(list, tabId);
    if (res) list = res.panes;
  });
  list = list.filter((pane) => !isEmptyPane(pane) || panes.some((p) => p === pane));

  // The anchor may have been the pane that just disappeared; then the layout has
  // no "relative to" left and the new windows simply take the whole area.
  const anchorAt = list.indexOf(anchorPaneBefore);
  const anchorIndex = anchorAt >= 0 ? anchorAt : (list.length > 0 ? clampIndex(list, 0) : -1);
  if (anchorIndex < 0) {
    // Nothing left to anchor to: the arrangement IS the workspace.
    const built = windows.map((strip, i) => paneWithTabs(
      divideRows ? { column: 0 } : { column: i },
      strip,
      strip[0].tabId,
    ));
    const next = normalizeColumns(built);
    return { panes: next, focusedIndex: 0, placedIndices: next.map((_, i) => i) };
  }

  const anchorColumn = paneColumn(list[anchorIndex], anchorIndex);
  // Columns become EXPLICIT before any splice: with implicit columns an
  // insertion shifts array positions and therefore silently re-columns every
  // pane after it (the lesson addEmptyPaneVertical documents).
  const explicit = list.map((pane, index) => ({ ...pane, column: paneColumn(pane, index) }));

  if (intoAnchorColumn) {
    // «сверху/снизу» — the new windows join the anchor's OWN column as rows.
    const built = windows.map((strip) => paneWithTabs({ column: anchorColumn }, strip, strip[0].tabId));
    // Rows of one column are contiguous in the array, so "above" means before
    // the first of them and "below" after the last.
    const rows = explicit
      .map((pane, index) => ({ pane, index }))
      .filter(({ pane }) => pane.column === anchorColumn);
    const insertAt = side === 'above'
      ? rows[0].index
      : rows[rows.length - 1].index + 1;
    const next = explicit.slice();
    next.splice(insertAt, 0, ...built);
    const normalized = normalizeColumns(next);
    return {
      panes: normalized,
      focusedIndex: insertAt,
      placedIndices: built.map((_, i) => insertAt + i),
    };
  }

  // A new AREA opens beside the anchor — at its column (left) or right after it
  // (right) — and everything at or beyond that shifts along. How many COLUMNS
  // that area takes is the second question: side by side (default) it is one
  // column per window; divided into rows it is a single column of rows.
  const firstNewColumn = side === 'left' ? anchorColumn : anchorColumn + 1;
  const newColumnCount = divideRows ? 1 : windows.length;
  const shifted = explicit.map((pane) => (
    pane.column >= firstNewColumn ? { ...pane, column: pane.column + newColumnCount } : pane
  ));
  const built = windows.map((strip, i) => paneWithTabs(
    { column: divideRows ? firstNewColumn : firstNewColumn + i },
    strip,
    strip[0].tabId,
  ));
  // Keep the flat array sorted by column: the block goes before the first pane
  // whose column is now past the new ones.
  let insertAt = shifted.length;
  for (let i = 0; i < shifted.length; i += 1) {
    if (shifted[i].column >= firstNewColumn) { insertAt = i; break; }
  }
  const next = shifted.slice();
  next.splice(insertAt, 0, ...built);
  const normalized = normalizeColumns(next);
  return {
    panes: normalized,
    focusedIndex: insertAt,
    placedIndices: built.map((_, i) => insertAt + i),
  };
}

/**
 * The workspace as an API caller reads it: windows in SCREEN order, each with
 * its strip, which chip is shown, and where it sits in the grid.
 *
 * Screen order, not array order — the array is sorted by column but a reader
 * asking "what is the window on the right" must not have to know that.
 */
export function describeWorkspace(panes, focusedIndex, current = null) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length === 0) {
    return {
      split: false,
      windows: current && current.tabId
        ? [{
          index: 0,
          column: 0,
          row: 0,
          focused: true,
          shownTabId: current.tabId,
          tabs: [{ projectId: current.projectId, tabId: current.tabId }],
        }]
        : [],
    };
  }
  const focus = clampIndex(list, focusedIndex);
  const windows = [];
  paneColumns(list).forEach((rows, columnIndex) => {
    rows.forEach(({ pane, index }, rowIndex) => {
      windows.push({
        index,
        column: columnIndex,
        row: rowIndex,
        focused: index === focus,
        empty: isEmptyPane(pane),
        shownTabId: pane.tabId || null,
        tabs: paneTabs(pane).map((e) => ({ projectId: e.projectId, tabId: e.tabId })),
      });
    });
  });
  return { split: true, windows };
}

// Geometry: equal columns, no draggable divider (v1). Returns percent rects.
export function paneRects(count) {
  const n = Math.max(1, count);
  const w = 100 / n;
  return Array.from({ length: n }, (_, i) => ({ leftPct: i * w, widthPct: w }));
}

// ── Resizable dividers ────────────────────────────────────────────────────
//
// Sizes are FRACTIONS, not pixels: `cols[c]` is column c's share of the full
// width (summing to 1), `rows[c][j]` is row j's share of column c's height.
// Fractions survive window resizes and monitor moves unchanged, which is what
// a saved layout must do.
//
// The sizes object lives BESIDE the panes (its own store/session field), not
// on the pane objects: a column's width belongs to the column, not to any one
// pane in it — and pane objects are rebuilt wholesale on every activation, so
// geometry riding on them would need carrying through every writer (the
// paneWithHistoryFrom lesson, for a field no tab writer cares about).
//
// DRIFT RULE: panes change without the sizes knowing (pane added or removed,
// whole project closed). Every reader therefore normalizes AT READ TIME
// against the current structure — a dimension whose stored count still
// matches keeps its fractions, a dimension that no longer matches resets to
// equal. No pane writer needs to know sizes exist, which is the whole reason
// none of them had to change for this feature.

export const SPLIT_MIN_FRACTION = 0.15;

const equalFractions = (n) => {
  const count = Math.max(1, n | 0);
  return Array.from({ length: count }, () => 1 / count);
};

const validFractionList = (list, count) => (
  Array.isArray(list) && list.length === count
  && list.every((f) => Number.isFinite(f) && f > 0)
);

// Stored fractions may carry float drift from earlier resizes; readers always
// see an exact sum of 1.
const renormalizeFractions = (list) => {
  const sum = list.reduce((a, b) => a + b, 0);
  return sum > 0 ? list.map((f) => f / sum) : equalFractions(list.length);
};

/**
 * Materialize sizes for the CURRENT pane structure: kept where the stored
 * count matches, equal where it does not (or where nothing is stored).
 */
export function normalizeSplitSizes(panes, sizes) {
  const columns = paneColumns(panes);
  if (columns.length === 0) return { cols: [], rows: [] };
  const cols = validFractionList(sizes && sizes.cols, columns.length)
    ? renormalizeFractions(sizes.cols)
    : equalFractions(columns.length);
  const rows = columns.map((rowsOfCol, c) => (
    validFractionList(sizes && sizes.rows && sizes.rows[c], rowsOfCol.length)
      ? renormalizeFractions(sizes.rows[c])
      : equalFractions(rowsOfCol.length)
  ));
  return { cols, rows };
}

const EQUAL_EPS = 1e-3;
const isEqualSplit = (list) => list.every((f) => Math.abs(f - 1 / list.length) < EQUAL_EPS);

/**
 * The STORED form: null when every dimension is an equal split. An untouched
 * layout stores no sizes at all — same storage philosophy as `column`: the
 * default is absent, so legacy sessions and equality checks stay byte-stable,
 * and stale sizes from a dead layout self-clean on the next pack.
 */
export function packSplitSizes(panes, sizes) {
  const norm = normalizeSplitSizes(panes, sizes);
  if (norm.cols.length === 0) return null;
  if (isEqualSplit(norm.cols) && norm.rows.every(isEqualSplit)) return null;
  return norm;
}

/**
 * Drag math for ONE divider in a fraction list: move `deltaFr` from the right
 * neighbour to the left one (negative = the other way), clamped so neither
 * drops below `minFr`. Total is preserved by construction. Returns the input
 * list unchanged when the divider index is invalid or there is no room.
 */
export function resizeFractions(fractions, dividerIndex, deltaFr, minFr = SPLIT_MIN_FRACTION) {
  const list = Array.isArray(fractions) ? fractions : [];
  const k = dividerIndex | 0;
  if (k < 0 || k >= list.length - 1 || !Number.isFinite(deltaFr)) return list;
  const a = list[k];
  const b = list[k + 1];
  const low = minFr - a;
  const high = b - minFr;
  if (low > high) return list; // both neighbours already at the minimum
  const d = Math.max(low, Math.min(high, deltaFr));
  if (d === 0) return list;
  const next = list.slice();
  next[k] = a + d;
  next[k + 1] = b - d;
  return next;
}

/** Short stable string for memo/selector keys; '' when sizes are absent. */
export function splitSizesFingerprint(sizes) {
  if (!sizes) return '';
  const f = (x) => Math.round(x * 1000);
  return (sizes.cols || []).map(f).join(',')
    + '|' + (sizes.rows || []).map((r) => r.map(f).join(',')).join(';');
}

/**
 * Уголки ФОКУСНОГО окна, где встречаются колоночная и строчная перегородки, —
 * ручки диагонального ресайза.
 *
 * Только у окна в фокусе, и это не украшение, а разрешение конфликта: в углу
 * сходятся до четырёх окон, и «чей» это угол, без правила не ответить. Фокус
 * уже выбран человеком — юзер: *«это работает только на той вкладке, на
 * которой у меня фокус, потому что там очевидно скапливаются конфликты»*.
 *
 * Каждый уголок называет ДВЕ перегородки: колоночную (общую для всей
 * раскладки) и строчную СВОЕЙ колонки. Пример юзера: колонка 1 — две вкладки
 * друг над другом, колонка 2 — одна; фокус на нижней вкладке колонки 1, её
 * правый верхний угол тянет одновременно границу колонок и границу строк
 * первой колонки.
 */
export function splitCornerDescriptors(panes, focusedIndex, sizes = null) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length < 2) return [];
  const columns = paneColumns(list);
  const norm = normalizeSplitSizes(list, sizes);
  const at = clampIndex(list, focusedIndex);
  let c = -1;
  let j = -1;
  columns.forEach((rows, columnIndex) => rows.forEach((row, rowIndex) => {
    if (row.index === at) { c = columnIndex; j = rowIndex; }
  }));
  if (c < 0) return [];
  let left = 0;
  for (let i = 0; i < c; i += 1) left += norm.cols[i] * 100;
  let top = 0;
  for (let i = 0; i < j; i += 1) top += norm.rows[c][i] * 100;
  const xEdges = [];
  if (c > 0) xEdges.push({ side: 'left', dividerIndex: c - 1, xPct: left });
  if (c < columns.length - 1) {
    xEdges.push({ side: 'right', dividerIndex: c, xPct: left + norm.cols[c] * 100 });
  }
  const yEdges = [];
  if (j > 0) yEdges.push({ side: 'top', dividerIndex: j - 1, yPct: top });
  if (j < columns[c].length - 1) {
    yEdges.push({ side: 'bottom', dividerIndex: j, yPct: top + norm.rows[c][j] * 100 });
  }
  const out = [];
  xEdges.forEach((x) => yEdges.forEach((y) => {
    out.push({
      id: `corner:${x.side}:${y.side}`,
      colDividerIndex: x.dividerIndex,
      rowColumnIndex: c,
      rowDividerIndex: y.dividerIndex,
      xPct: x.xPct,
      yPct: y.yPct,
      // Диагональ курсора — по паре сторон: right+top и left+bottom это ↗↙.
      cursor: (x.side === 'right') === (y.side === 'top') ? 'nesw-resize' : 'nwse-resize',
    });
  }));
  return out;
}

/**
 * The dividers to render, with their line positions in percent:
 *   {kind:'col', dividerIndex, xPct}                       — between columns
 *   {kind:'row', columnIndex, dividerIndex, yPct, leftPct, widthPct}
 *                                                          — between rows
 * `id` is stable across drags ('col:0', 'row:1:0') for React keys and DOM
 * lookup during the live drag.
 */
export function splitDividerDescriptors(panes, sizes = null) {
  const columns = paneColumns(panes);
  if (columns.length === 0) return [];
  const norm = normalizeSplitSizes(panes, sizes);
  const out = [];
  let left = 0;
  columns.forEach((rows, c) => {
    const widthPct = norm.cols[c] * 100;
    if (c < columns.length - 1) {
      out.push({ id: `col:${c}`, kind: 'col', dividerIndex: c, xPct: left + widthPct });
    }
    let top = 0;
    rows.forEach((_, j) => {
      const heightPct = norm.rows[c][j] * 100;
      if (j < rows.length - 1) {
        out.push({
          id: `row:${c}:${j}`,
          kind: 'row',
          columnIndex: c,
          dividerIndex: j,
          yPct: top + heightPct,
          leftPct: left,
          widthPct,
        });
      }
      top += heightPct;
    });
    left += widthPct;
  });
  return out;
}

/**
 * Full 2-D geometry: fractional columns across the width, fractional rows
 * inside each column — equal splits when `sizes` is absent. Returns one rect
 * per pane, in the SAME order as the panes array, so callers index it
 * directly.
 */
export function paneGridRects(panes, sizes = null) {
  const columns = paneColumns(panes);
  const rects = new Array(Array.isArray(panes) ? panes.length : 0);
  if (!sizes) {
    // The exact pre-resize arithmetic (i * 100/n, not cumsum of 1/n): the two
    // differ in the last float digit, and every consumer of the default
    // geometry — tests included — is pinned to this form.
    const colCount = Math.max(1, columns.length);
    const colW = 100 / colCount;
    columns.forEach((rows, columnIndex) => {
      const rowH = 100 / Math.max(1, rows.length);
      rows.forEach(({ index }, rowIndex) => {
        rects[index] = {
          leftPct: columnIndex * colW,
          widthPct: colW,
          topPct: rowIndex * rowH,
          heightPct: rowH,
        };
      });
    });
    return rects;
  }
  const norm = normalizeSplitSizes(panes, sizes);
  let left = 0;
  columns.forEach((rows, columnIndex) => {
    const widthPct = norm.cols[columnIndex] * 100;
    let top = 0;
    rows.forEach(({ index }, rowIndex) => {
      const heightPct = norm.rows[columnIndex][rowIndex] * 100;
      rects[index] = { leftPct: left, widthPct, topPct: top, heightPct };
      top += heightPct;
    });
    left += widthPct;
  });
  return rects;
}

/**
 * В КАКОЙ ФОРМЕ отрисована вкладка: как окно раскладки или как одиночный центр.
 *
 * Существует потому, что форма — это СТРУКТУРА дерева, а не оформление. Пока
 * ответ считался по одному текущему пространству, переключение пространств
 * переворачивало его для каждой вкладки («была окном — стала не-окном»), и
 * React был обязан снести и собрать заново всё поддерево окна вместе с живым
 * терминалом. На проде это стоило 200–330мс сплошной блокировки на клик плюс
 * повторную заливку буферов (до 920КБ на вкладку) — при том, что сама
 * раскладка пересчитывается за 0–1мс.
 *
 * Поэтому форму назначает не «текущая раскладка», а ВСЕ раскладки сразу:
 * вкладка, разложенная в окне хоть одного пространства, всегда рисуется как
 * окно. Скрытые пространства меняют только видимость и геометрию — структура
 * дерева не шевелится, терминал живёт непрерывно.
 *
 * `paneIndex >= 0` — окно ВИДИМОГО пространства (у него есть прямоугольник и
 * номер); `HIDDEN_PANE_INDEX` — та же форма, но принадлежит скрытому
 * пространству: рисуется, не показывается, номера окна не имеет.
 */
export const HIDDEN_PANE_INDEX = -2;

export function resolveTabPaneShape(tabId, visiblePanes, hiddenPaneLists = []) {
  if (!tabId) return -1;
  const visible = paneIndexHoldingTab(visiblePanes, tabId);
  if (visible >= 0) return visible;
  const lists = Array.isArray(hiddenPaneLists) ? hiddenPaneLists : [];
  for (const panes of lists) {
    if (paneIndexHoldingTab(panes, tabId) >= 0) return HIDDEN_PANE_INDEX;
  }
  return -1;
}

/** True when this pane shares its column with another — i.e. it is short. */
export function paneIsStacked(panes, index) {
  const list = Array.isArray(panes) ? panes : [];
  const target = list[index];
  if (!target) return false;
  const col = paneColumn(target, index);
  let seen = 0;
  list.forEach((pane, i) => { if (paneColumn(pane, i) === col) seen += 1; });
  return seen > 1;
}

// ── Layout map: "which pane is this tab in", drawn as cells ────────────────
//
// The sidebar card cannot answer "where is this tab open" with tints or edges:
// its edges already carry the process bar, its left inset the status marker,
// its bottom the task squares, and the active-tab background highlight was
// deliberately removed. So the answer is a tiny map whose CELL POSITION mirrors
// the pane's POSITION ON SCREEN — read without reading.
//
// Returns one cell per pane, left-to-right in screen order:
//   state 'self-focused' — this tab's pane, shown there, and it holds focus
//   state 'self'         — this tab's pane, shown there, not focused
//   state 'held'         — this tab's pane, but a NEIGHBOURING CHIP is shown
//   state 'other'        — some other pane
// Single mode (panes.length === 0) still returns ONE cell so an open tab always
// carries a mark; `mine` is then simply "is this the center tab".
//
// The 'held' state exists because a pane now holds a strip: a tab can be in a
// window without being the one on screen there. With only "mine / not mine" the
// mark would claim the tab is visible when it is not — and "where is it" and
// "can I see it" are exactly the two questions a person asks of this mark. So the
// CELL says which window, and how it is filled says whether it is showing.
//
// Returns [] when the tab is in no pane at all. Callers must still RESERVE the
// slot in that case — a map that appears and disappears makes the tab name
// jitter every time the tab enters or leaves the workspace.
export function paneMapCells(panes, focusedIndex, projectId, tabId, centerTab = null) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length === 0) {
    const isCenter = !!centerTab
      && centerTab.projectId === projectId
      && centerTab.tabId === tabId;
    // The single center surface is always the focused one by definition.
    return isCenter ? [{ mine: true, state: 'self-focused' }] : [];
  }
  const focus = clampIndex(list, focusedIndex);
  let found = false;
  const cells = list.map((pane, index) => {
    const shown = !!pane && pane.projectId === projectId && pane.tabId === tabId;
    const held = !shown && paneHoldsTabOfProject(pane, projectId, tabId);
    if (shown || held) found = true;
    return {
      mine: shown || held,
      state: shown ? (index === focus ? 'self-focused' : 'self') : (held ? 'held' : 'other'),
    };
  });
  return found ? cells : [];
}

/**
 * Same answer as paneMapCells, but shaped as COLUMNS OF ROWS so the mark can
 * mirror a 2-D layout. A flat cell list cannot: two panes stacked in one column
 * would draw as two side-by-side cells, i.e. as a layout the user does not have.
 *
 * Returns [] when the tab is in no pane — callers still reserve the slot.
 */
export function paneMapGrid(panes, focusedIndex, projectId, tabId, centerTab = null) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length === 0) {
    const flat = paneMapCells(list, focusedIndex, projectId, tabId, centerTab);
    return flat.length > 0 ? [flat] : [];
  }
  const focus = clampIndex(list, focusedIndex);
  let found = false;
  const grid = paneColumns(list).map((rows) => rows.map(({ pane, index }) => {
    const shown = !!pane && pane.projectId === projectId && pane.tabId === tabId;
    const held = !shown && paneHoldsTabOfProject(pane, projectId, tabId);
    if (shown || held) found = true;
    return {
      mine: shown || held,
      state: shown ? (index === focus ? 'self-focused' : 'self') : (held ? 'held' : 'other'),
    };
  }));
  return found ? grid : [];
}
