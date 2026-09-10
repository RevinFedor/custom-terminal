// Resize preserves a TEXT position, not a pixel depth inside a long message.
// Transient only: regular persisted reading anchors keep their existing format.
const ROW = '[data-history-row-real][data-history-unit-key]';
const OMIT_TEXT = 'button, svg, script, style, input, textarea, [aria-hidden="true"]';

function textNodes(row) {
  const walker = row.ownerDocument.createTreeWalker(row, 4 /* SHOW_TEXT */);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement?.closest(OMIT_TEXT)) nodes.push(node);
  }
  return nodes;
}

function prefixHash(nodes, end) {
  let hash = 2166136261;
  for (const node of nodes) {
    const text = node.textContent || '';
    const count = Math.min(text.length, end);
    for (let i = 0; i < count; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    end -= count;
    if (end <= 0) break;
  }
  return end <= 0 ? hash >>> 0 : null;
}

function charRect(doc, node, start, length = 1) {
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, Math.min(node.textContent.length, start + length));
  return range.getBoundingClientRect();
}

export function captureHistoryResizeAnchor(scroller, followBottom = false) {
  if (!scroller?.isConnected) return null;
  if (followBottom) return { kind: 'tail' };
  const viewport = scroller.getBoundingClientRect();
  for (const row of scroller.querySelectorAll(ROW)) {
    const rect = row.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    const anchor = { kind: 'row', key: row.getAttribute('data-history-unit-key'),
      uuid: row.getAttribute('data-uuid'), rowTop: rect.top - viewport.top };
    const nodes = textNodes(row);
    let offset = 0;
    for (const node of nodes) {
      const text = node.textContent || '';
      const range = row.ownerDocument.createRange();
      range.selectNodeContents(node);
      const bounds = range.getBoundingClientRect();
      if (text.trim() && bounds.height > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
        // First character on the partially visible top line. Prefix bottom is
        // monotone even across wrapped spaces, unlike individual glyph boxes.
        let lo = 0, hi = text.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          range.setStart(node, 0); range.setEnd(node, mid + 1);
          if (range.getBoundingClientRect().bottom > viewport.top) hi = mid;
          else lo = mid + 1;
        }
        // Keep UTF-16 surrogate pairs intact, as DOM Range offsets are UTF-16.
        if (lo > 0 && /[\uDC00-\uDFFF]/.test(text[lo])) lo--;
        const length = text.codePointAt(lo) > 0xffff ? 2 : 1;
        const glyph = charRect(row.ownerDocument, node, lo, length);
        if (glyph.height > 0 && glyph.bottom > viewport.top) {
          return { ...anchor, kind: 'text', offset: offset + lo, length,
            prefixHash: prefixHash(nodes, offset + lo + length), textTop: glyph.top - viewport.top };
        }
      }
      offset += text.length;
    }
    return anchor; // Non-text tool/group header: preserve its signed top gap.
  }
  return null;
}

export function measureHistoryResizeAnchor(scroller, anchor) {
  if (!scroller?.isConnected || !anchor) return null;
  if (anchor.kind === 'tail') {
    return { drift: Math.max(0, scroller.scrollHeight - scroller.clientHeight) - scroller.scrollTop, proof: 'tail' };
  }
  const row = Array.from(scroller.querySelectorAll(ROW))
    .find((node) => node.getAttribute('data-history-unit-key') === anchor.key);
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  if (rect.height <= 0) return null;
  const viewportTop = scroller.getBoundingClientRect().top;
  if (anchor.kind === 'text') {
    const nodes = textNodes(row);
    if (prefixHash(nodes, anchor.offset + anchor.length) === anchor.prefixHash) {
      let offset = anchor.offset;
      for (const node of nodes) {
        if (offset < node.textContent.length) {
          const glyph = charRect(row.ownerDocument, node, offset, anchor.length);
          if (glyph.height > 0) return { drift: glyph.top - viewportTop - anchor.textTop, proof: 'text' };
          break;
        }
        offset -= node.textContent.length;
      }
    }
  }
  // The same message can change while streaming. Do not find a look-alike
  // phrase elsewhere; fall back explicitly within the SAME display unit.
  return { drift: rect.top - viewportTop - anchor.rowTop,
    proof: anchor.kind === 'text' ? 'row-text-changed' : 'row' };
}

// Narrow UI boundary: geometry owner supplies begin/end, each History owns its
// anchor. Capture ALL panes before any participant mutates DOM/cancels writers.
const surfaces = new Map();
export function registerHistoryResizeSurface(root, prepare) {
  surfaces.set(root, prepare);
  return () => { if (surfaces.get(root) === prepare) surfaces.delete(root); };
}

export function beginHistoryResize(scope, reason = 'split-divider') {
  const prepared = [];
  for (const [root, prepare] of surfaces) {
    if (root.isConnected && scope.contains(root)) {
      const participant = prepare(reason);
      if (participant) prepared.push(participant);
    }
  }
  prepared.forEach((participant) => participant.activate());
  let done = false;
  return (changed = true) => {
    if (done) return;
    done = true;
    prepared.forEach((participant) => participant.finish(changed));
  };
}
