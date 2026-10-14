import { StateField, StateEffect, type ChangeDesc, type Text } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'

/**
 * Per-line and per-range background color.
 *
 * Runtime model:
 *   - lineMap: lineStartPos -> bgId. This is line-owned metadata: when the whole
 *     line is deleted, its background disappears instead of drifting to the line
 *     that shifts into the same position.
 *   - ranges: text-owned metadata: exact character ranges remap with edits and
 *     shrink/disappear as their text is deleted.
 *
 * Persistence is backward-compatible with the old line-only shape:
 *   - no text ranges: { "12": "warn" }
 *   - with text ranges: { lines: { "12": "warn" }, ranges: [...] }
 */

export interface LineBackgroundEntry {
  id: string
  name: string
  color: string
}

export interface TextBackgroundRange {
  fromLine: number
  fromCh: number
  toLine: number
  toCh: number
  bgId: string
}

export type SerializedLineBackgrounds =
  Record<number, string> |
  {
    lines?: Record<number, string>
    ranges?: TextBackgroundRange[]
  }

interface TextBgRange {
  from: number
  to: number
  bgId: string
}

interface LineBgState {
  lineMap: Map<number, string>
  ranges: TextBgRange[]
  palette: LineBackgroundEntry[]
  decorations: DecorationSet
}

interface LineBgSnapshot {
  lines: Array<[number, string]>
  ranges: TextBgRange[]
}

interface LineBgDelta {
  prev: LineBgSnapshot
  next: LineBgSnapshot
}

// --- Effects -----------------------------------------------------------------

function cloneRange(r: TextBgRange): TextBgRange {
  return { from: r.from, to: r.to, bgId: r.bgId }
}

function snapshotFrom(lineMap: Map<number, string>, ranges: TextBgRange[]): LineBgSnapshot {
  return {
    lines: Array.from(lineMap.entries()),
    ranges: ranges.map(cloneRange),
  }
}

function mapSnapshot(snapshot: LineBgSnapshot, change: ChangeDesc): LineBgSnapshot {
  return {
    lines: snapshot.lines.map(([pos, bgId]) => [change.mapPos(pos, -1), bgId]),
    ranges: mapTextRanges(snapshot.ranges, change),
  }
}

function snapshotToLineMap(snapshot: LineBgSnapshot, doc: Text): Map<number, string> {
  const lineMap = new Map<number, string>()
  for (const [pos, bgId] of snapshot.lines) {
    if (!bgId) continue
    const clamped = Math.max(0, Math.min(pos, doc.length))
    lineMap.set(doc.lineAt(clamped).from, bgId)
  }
  return lineMap
}

/**
 * Metadata change. Carries whole prev/next snapshots instead of per-operation
 * instructions so line-mode, range-mode, overlap cutting and clears all share
 * the same undo path.
 */
export const changeLineBgEffect = StateEffect.define<LineBgDelta>({
  map: (delta, change: ChangeDesc) => ({
    prev: mapSnapshot(delta.prev, change),
    next: mapSnapshot(delta.next, change),
  }),
})

/** Replace the whole map (used on load -- NOT added to history). */
const replaceLineBgEffect = StateEffect.define<LineBgSnapshot>()
/** Replace the palette (color lookup). */
const setLineBgPaletteEffect = StateEffect.define<LineBackgroundEntry[]>()

// --- Decoration builder ------------------------------------------------------

// Sanitize a bgId into a CSS-class-safe suffix.
function classSafe(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * Inject (once, in <head>) a <style> with one rule per palette entry.
 * The decoration only adds a CLASS -- never an inline `style` attribute.
 */
function syncPaletteStyles(palette: LineBackgroundEntry[]) {
  if (typeof document === 'undefined') return
  const STYLE_ID = 'cm-line-bg-styles'
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = STYLE_ID
    document.head.appendChild(styleEl)
  }
  // Two rendering shapes share each color class:
  //  - a <span> mark hugging content or an exact text selection
  //  - a whole-line block for empty/whitespace-only line backgrounds
  // The line-block form needs `!important` + doubled class to outrank
  // `[class*="cm-indent-L"] { background-color: transparent !important }`.
  const rules = (palette || [])
    .filter(p => p && p.id && p.color)
    .flatMap(p => {
      const cls = `cm-line-bg-${classSafe(p.id)}`
      return [
        `span.${cls} { background-color: ${p.color}; border-radius: 2px; }`,
        `.cm-line.${cls}.${cls} { background-color: ${p.color} !important; }`,
      ]
    })
  styleEl.textContent = rules.join('\n')
}

function buildLineDecorations(state: { doc: Text }, lineMap: Map<number, string>, idSet: Set<string>) {
  const ranges: any[] = []
  for (const [pos, bgId] of lineMap) {
    if (!idSet.has(bgId)) continue
    if (pos < 0 || pos > state.doc.length) continue
    const cls = `cm-line-bg cm-line-bg-${classSafe(bgId)}`
    const line = state.doc.lineAt(pos)
    const text = line.text
    // Start the highlight at the first NON-whitespace char so the leading indent
    // stays uncolored, while the marker itself is included.
    const ws = text.match(/^[\t ]*/)
    const indentLen = ws ? ws[0].length : 0
    const from = line.from + indentLen
    if (from >= line.to) {
      ranges.push(Decoration.line({ class: cls }).range(line.from))
    } else {
      ranges.push(Decoration.mark({ class: cls, inclusiveStart: true, inclusiveEnd: false }).range(from, line.to))
    }
  }
  return ranges
}

function buildTextRangeDecorations(doc: Text, textRanges: TextBgRange[], idSet: Set<string>) {
  const ranges: any[] = []
  for (const r of textRanges) {
    if (!idSet.has(r.bgId)) continue
    const from = Math.max(0, Math.min(r.from, doc.length))
    const to = Math.max(0, Math.min(r.to, doc.length))
    if (from >= to) continue
    const cls = `cm-line-bg cm-line-bg-${classSafe(r.bgId)}`
    ranges.push(Decoration.mark({ class: cls, inclusiveStart: false, inclusiveEnd: false }).range(from, to))
  }
  return ranges
}

function buildDecorations(
  state: { doc: Text },
  lineMap: Map<number, string>,
  textRanges: TextBgRange[],
  palette: LineBackgroundEntry[]
): DecorationSet {
  if (lineMap.size === 0 && textRanges.length === 0) return Decoration.none
  const idSet = new Set(palette.map(p => p.id))
  const ranges = [
    ...buildLineDecorations(state, lineMap, idSet),
    ...buildTextRangeDecorations(state.doc, textRanges, idSet),
  ]
  ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  try {
    return Decoration.set(ranges, true)
  } catch {
    return Decoration.none
  }
}

// --- Mapping / normalization -------------------------------------------------

function mapLineMapThroughChanges(lineMap: Map<number, string>, tr: any): Map<number, string> {
  const next = new Map<number, string>()
  const oldDoc = tr.startState.doc
  const newDoc = tr.state.doc
  for (const [pos, bgId] of lineMap) {
    const clampedOld = Math.max(0, Math.min(pos, oldDoc.length))
    const oldLine = oldDoc.lineAt(clampedOld)
    const spanEnd = Math.min(oldLine.to + 1, oldDoc.length)
    const a = tr.changes.mapPos(oldLine.from, 1)
    const b = tr.changes.mapPos(spanEnd, -1)
    if (a >= b) continue

    const mapped = tr.changes.mapPos(pos, -1)
    const lineStart = newDoc.lineAt(Math.max(0, Math.min(mapped, newDoc.length))).from
    next.set(lineStart, bgId)
  }
  return next
}

function mapTextRanges(ranges: TextBgRange[], change: ChangeDesc): TextBgRange[] {
  const out: TextBgRange[] = []
  for (const r of ranges) {
    const from = change.mapPos(r.from, 1)
    const to = change.mapPos(r.to, -1)
    if (from >= to) continue
    out.push({ from, to, bgId: r.bgId })
  }
  return normalizeTextRanges(out)
}

function normalizeTextRanges(ranges: TextBgRange[]): TextBgRange[] {
  const sorted = ranges
    .filter(r => r && r.bgId && Number.isFinite(r.from) && Number.isFinite(r.to) && r.from < r.to)
    .map(cloneRange)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const out: TextBgRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && last.bgId === r.bgId && r.from <= last.to) {
      last.to = Math.max(last.to, r.to)
    } else {
      out.push(r)
    }
  }
  return out
}

function cutRangesBySelections(ranges: TextBgRange[], selections: Array<{ from: number; to: number }>): TextBgRange[] {
  let result = ranges.map(cloneRange)
  for (const sel of selections) {
    const from = Math.min(sel.from, sel.to)
    const to = Math.max(sel.from, sel.to)
    if (from >= to) continue
    const next: TextBgRange[] = []
    for (const r of result) {
      if (r.to <= from || r.from >= to) {
        next.push(r)
        continue
      }
      if (r.from < from) next.push({ from: r.from, to: from, bgId: r.bgId })
      if (r.to > to) next.push({ from: to, to: r.to, bgId: r.bgId })
    }
    result = next
  }
  return normalizeTextRanges(result)
}

function selectedTextRanges(view: EditorView): Array<{ from: number; to: number }> {
  return view.state.selection.ranges
    .filter(r => !r.empty)
    .map(r => ({ from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) }))
    .filter(r => r.from < r.to)
}

export function getSelectedBackgroundCharCount(view: EditorView): number {
  return selectedTextRanges(view).reduce((sum, r) => sum + (r.to - r.from), 0)
}

function bgCoveringRange(ranges: TextBgRange[], from: number, to: number): string | null {
  let cursor = from
  let bgId: string | null = null
  for (const r of ranges) {
    if (r.to <= cursor || r.from >= to) continue
    if (r.from > cursor) return null
    const coverTo = Math.min(r.to, to)
    if (!bgId) bgId = r.bgId
    else if (bgId !== r.bgId) return null
    cursor = Math.max(cursor, coverTo)
    if (cursor >= to) return bgId
  }
  return cursor >= to ? bgId : null
}

function commonSelectionBackground(ranges: TextBgRange[], selections: Array<{ from: number; to: number }>): string | null {
  let common: string | null = null
  for (const sel of selections) {
    const bg = bgCoveringRange(ranges, sel.from, sel.to)
    if (!bg) return null
    if (!common) common = bg
    else if (common !== bg) return null
  }
  return common
}

// --- StateField --------------------------------------------------------------

const lineBgField = StateField.define<LineBgState>({
  create() {
    return { lineMap: new Map(), ranges: [], palette: [], decorations: Decoration.none }
  },
  update(value, tr) {
    let lineMap = value.lineMap
    let ranges = value.ranges
    let palette = value.palette
    let dirty = false

    if (tr.docChanged) {
      lineMap = mapLineMapThroughChanges(lineMap, tr)
      ranges = mapTextRanges(ranges, tr.changes)
      dirty = true
    }

    for (const e of tr.effects) {
      if (e.is(replaceLineBgEffect)) {
        lineMap = snapshotToLineMap(e.value, tr.state.doc)
        ranges = normalizeTextRanges(e.value.ranges)
        dirty = true
      } else if (e.is(setLineBgPaletteEffect)) {
        palette = e.value
        dirty = true
      } else if (e.is(changeLineBgEffect)) {
        lineMap = snapshotToLineMap(e.value.next, tr.state.doc)
        ranges = normalizeTextRanges(e.value.next.ranges)
        dirty = true
      }
    }

    if (!dirty) return value
    return { lineMap, ranges, palette, decorations: buildDecorations(tr.state, lineMap, ranges, palette) }
  },
  provide: f => EditorView.decorations.from(f, s => s.decorations),
})

const lineBgInvertedEffects = invertedEffects.of((tr) => {
  const inverses: StateEffect<LineBgDelta>[] = []
  for (const e of tr.effects) {
    if (e.is(changeLineBgEffect)) {
      inverses.push(changeLineBgEffect.of({ prev: e.value.next, next: e.value.prev }))
    }
  }
  return inverses
})

export function lineBackgroundExtension() {
  return [lineBgField, lineBgInvertedEffects]
}

// --- Public API --------------------------------------------------------------

/** Apply (or clear with null) a background to selected text, or to lines when there is no selection. */
export function applyLineBackground(view: EditorView, bgId: string | null) {
  const st = view.state.field(lineBgField, false)
  const lineMap = st ? st.lineMap : new Map<number, string>()
  const ranges = st ? st.ranges : []
  const doc = view.state.doc
  const selections = selectedTextRanges(view)

  let nextLineMap = lineMap
  let nextRanges = ranges

  if (selections.length > 0) {
    nextRanges = cutRangesBySelections(ranges, selections)
    if (bgId) {
      nextRanges = normalizeTextRanges([
        ...nextRanges,
        ...selections.map(sel => ({ from: sel.from, to: sel.to, bgId })),
      ])
    }
  } else {
    nextLineMap = new Map(lineMap)
    const touchedLines = new Set<number>()
    for (const sel of view.state.selection.ranges) {
      const startLine = doc.lineAt(sel.from).number
      const endLine = doc.lineAt(sel.to).number
      for (let l = startLine; l <= endLine; l++) touchedLines.add(l)
    }

    for (const lineNum of touchedLines) {
      const lineStart = doc.line(lineNum).from
      const prev = nextLineMap.get(lineStart) ?? null
      if (prev === bgId) continue
      if (bgId === null) nextLineMap.delete(lineStart)
      else nextLineMap.set(lineStart, bgId)
    }
  }

  const prev = snapshotFrom(lineMap, ranges)
  const next = snapshotFrom(nextLineMap, nextRanges)
  if (snapshotsEqual(prev, next)) {
    console.log('[LineBg] apply (no-op)', { bgId, mode: selections.length ? 'range' : 'line' })
    return
  }

  view.dispatch({ effects: changeLineBgEffect.of({ prev, next }) })
  console.log('[LineBg] apply', { bgId, mode: selections.length ? 'range' : 'line', selections: selections.length })
}

function snapshotsEqual(a: LineBgSnapshot, b: LineBgSnapshot): boolean {
  if (a.lines.length !== b.lines.length || a.ranges.length !== b.ranges.length) return false
  for (let i = 0; i < a.lines.length; i++) {
    if (a.lines[i][0] !== b.lines[i][0] || a.lines[i][1] !== b.lines[i][1]) return false
  }
  for (let i = 0; i < a.ranges.length; i++) {
    const x = a.ranges[i], y = b.ranges[i]
    if (x.from !== y.from || x.to !== y.to || x.bgId !== y.bgId) return false
  }
  return true
}

function lineMapToRecord(doc: Text, lineMap: Map<number, string>): Record<number, string> {
  const out: Record<number, string> = {}
  for (const [pos, bgId] of lineMap) {
    if (pos < 0 || pos > doc.length) continue
    out[doc.lineAt(pos).number] = bgId
  }
  return out
}

function posToLineCh(doc: Text, pos: number): { line: number; ch: number } {
  const clamped = Math.max(0, Math.min(pos, doc.length))
  const line = doc.lineAt(clamped)
  return { line: line.number, ch: clamped - line.from }
}

/** Serialize current backgrounds for persistence. */
export function serializeLineBackgrounds(view: EditorView): SerializedLineBackgrounds {
  const st = view.state.field(lineBgField, false)
  if (!st) return {}
  const doc = view.state.doc
  const lines = lineMapToRecord(doc, st.lineMap)
  const ranges = st.ranges
    .map(r => {
      const from = posToLineCh(doc, r.from)
      const to = posToLineCh(doc, r.to)
      return { fromLine: from.line, fromCh: from.ch, toLine: to.line, toCh: to.ch, bgId: r.bgId }
    })
    .filter(r => r.bgId && (r.fromLine !== r.toLine || r.fromCh < r.toCh))

  if (ranges.length === 0) return lines
  return { lines, ranges }
}

function isStructuredData(data: any): data is { lines?: Record<number, string>; ranges?: TextBackgroundRange[] } {
  return !!data && typeof data === 'object' && !Array.isArray(data) && ('lines' in data || 'ranges' in data)
}

function readLegacyLines(data: any): Record<number, string> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  if (isStructuredData(data)) {
    const lines = data.lines
    return lines && typeof lines === 'object' && !Array.isArray(lines) ? lines : {}
  }
  return data
}

function posFromLineCh(doc: Text, lineNum: number, ch: number): number | null {
  if (!Number.isFinite(lineNum) || lineNum < 1 || lineNum > doc.lines) return null
  const line = doc.line(lineNum)
  const safeCh = Math.max(0, Math.min(Number.isFinite(ch) ? ch : 0, line.length))
  return line.from + safeCh
}

function snapshotFromSerialized(doc: Text, data: SerializedLineBackgrounds | null | undefined): LineBgSnapshot {
  const lineMap = new Map<number, string>()
  const lines = readLegacyLines(data)
  for (const [lineStr, bgId] of Object.entries(lines)) {
    const lineNum = parseInt(lineStr, 10)
    if (!Number.isFinite(lineNum) || lineNum < 1 || lineNum > doc.lines || !bgId) continue
    lineMap.set(doc.line(lineNum).from, String(bgId))
  }

  const ranges: TextBgRange[] = []
  const rawRanges = isStructuredData(data) && Array.isArray(data.ranges) ? data.ranges : []
  for (const r of rawRanges) {
    if (!r || typeof r !== 'object' || !r.bgId) continue
    const from = posFromLineCh(doc, Number(r.fromLine), Number(r.fromCh))
    const to = posFromLineCh(doc, Number(r.toLine), Number(r.toCh))
    if (from == null || to == null || from >= to) continue
    ranges.push({ from, to, bgId: String(r.bgId) })
  }

  return snapshotFrom(lineMap, normalizeTextRanges(ranges))
}

/** Load backgrounds from persisted data (positions resolved now). */
export function loadLineBackgrounds(view: EditorView, data: SerializedLineBackgrounds | null | undefined) {
  view.dispatch({ effects: replaceLineBgEffect.of(snapshotFromSerialized(view.state.doc, data)) })
}

/** Apply a full persisted map as an undoable metadata change. */
export function applyLineBackgroundMap(view: EditorView, data: SerializedLineBackgrounds | null | undefined) {
  const st = view.state.field(lineBgField, false)
  const curLineMap = st ? st.lineMap : new Map<number, string>()
  const curRanges = st ? st.ranges : []
  const prev = snapshotFrom(curLineMap, curRanges)
  const parsed = snapshotFromSerialized(view.state.doc, data)
  const next = isStructuredData(data)
    ? parsed
    : snapshotFrom(snapshotToLineMap(parsed, view.state.doc), curRanges)
  if (snapshotsEqual(prev, next)) return
  view.dispatch({ effects: changeLineBgEffect.of({ prev, next }) })
}

/** Push the palette (color lookup) into the field AND sync the <style> rules. */
export function setLineBackgroundPalette(view: EditorView, palette: LineBackgroundEntry[]) {
  syncPaletteStyles(palette || [])
  view.dispatch({ effects: setLineBgPaletteEffect.of(palette || []) })
}

/** Read whether the selection or active line already has a background. */
export function getActiveLineBackground(view: EditorView): string | null {
  const st = view.state.field(lineBgField, false)
  if (!st) return null
  const selections = selectedTextRanges(view)
  if (selections.length > 0) return commonSelectionBackground(st.ranges, selections)
  const lineStart = view.state.doc.lineAt(view.state.selection.main.head).from
  return st.lineMap.get(lineStart) ?? null
}
