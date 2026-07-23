/* ============================================================
   @noted/claude-blocks — selection → markdown serializer
   ------------------------------------------------------------
   Проблема: react-markdown рендерит markdown в семантический HTML
   (`<li>`, `<strong>`, заголовки). При копировании выделения мышью
   браузер сериализует *отрисованный* DOM в текст и теряет markdown-
   структуру: маркер списка `-` пропадает (рисуется CSS-буллетом, не
   текстом), отступы строк схлопываются, пустые строки между блоками
   исчезают (margin вместо реального `\n`).

   Решение: на `copy`-событии внутри `.cb-prose` берём ВЫДЕЛЕННЫЙ
   фрагмент (`Range.cloneContents()`) и сериализуем его обратно в
   markdown-эквивалент — `<li>` → `- `, заголовки → `#`, между
   блоками `\n\n`, code-блоки в ``` fences. Работает и для частичного
   выделения (cloneContents даёт ровно выбранный поддерево-срез).
   ============================================================ */

// Inline serialization: concat text, unwrap <strong>/<em>/<code>/<a> to their
// text (the markdown markers `**`/`*`/`` ` `` are visual-only here — we keep
// the readable text, not re-inject asterisks, to match what the user sees and
// expects to paste). Hex-chips (`<span data-hex-chip>`) carry their literal
// `#RRGGBB` as text content already.
function inlineText(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent || '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') out += '\n';
      else if (tag === 'button') return; // UI chrome (code-block Copy) — never content
      else out += inlineText(el);
    }
  });
  return out;
}

const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Inline-level tags accumulate into the CURRENT text run instead of opening a
// new block. Without this, a fragment whose top level is raw inline nodes —
// every partial-paragraph selection, and EVERY code-block selection (the
// syntax highlighter wraps each token in a <span>) — serialized one entry per
// node, and the '\n\n' join exploded a single line into token-per-paragraph
// output («копируется с огромными разрывами»).
const INLINE = new Set(['span', 'strong', 'em', 'b', 'i', 'code', 'a', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'small', 'abbr', 'kbd']);

// Serialize a block-level element subtree to markdown-ish text.
// `indent` accumulates for nested lists.
function serializeBlock(el: HTMLElement, indent: string, out: string[]): void {
  const tag = el.tagName.toLowerCase();

  // Our own code-block wrapper (MarkdownCodeBlock renders the highlighter with
  // PreTag="div", so the `pre` branch below never fires for it). The header strip
  // (lang label + Copy button) is UI chrome — skip it; the body becomes a fence.
  const cls = el.classList;
  if (cls && cls.contains('cb-code-head')) return;
  if (cls && cls.contains('cb-code-block')) {
    const codeEl = el.querySelector('code') || el;
    const code = (codeEl.textContent || '').replace(/^\n+/, '').replace(/\n+$/, '');
    out.push(indent + '```\n' + code.split('\n').map((l) => indent + l).join('\n') + '\n' + indent + '```');
    return;
  }

  if (HEADING.has(tag)) {
    const level = Number(tag[1]);
    out.push(indent + '#'.repeat(level) + ' ' + inlineText(el).trim());
    return;
  }
  if (tag === 'p') {
    out.push(indent + inlineText(el).trim());
    return;
  }
  if (tag === 'blockquote') {
    // each line of the inner text gets a "> " prefix
    const inner: string[] = [];
    serializeChildren(el, '', inner);
    out.push(inner.join('\n').split('\n').map((l) => indent + '> ' + l).join('\n'));
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    // The whole list is ONE out-entry (items separated by single '\n') — each
    // item used to be its own entry, and the caller's '\n\n' join put a blank
    // line between every bullet (the same "огромные разрывы" class as the
    // code-block explosion). Nested lists serialize into a sub-array and join
    // into the same entry.
    const lines: string[] = [];
    let i = 1;
    el.childNodes.forEach((li) => {
      if (li.nodeType !== Node.ELEMENT_NODE) return;
      const liEl = li as HTMLElement;
      if (liEl.tagName.toLowerCase() !== 'li') return;
      const marker = ordered ? `${i}. ` : '- ';
      // First line = the li's own inline text (excluding nested lists);
      // nested ul/ol get recursed with deeper indent.
      const ownInline = liInlineOnly(liEl).trim();
      lines.push(indent + marker + ownInline);
      liEl.childNodes.forEach((c) => {
        if (c.nodeType === Node.ELEMENT_NODE) {
          const ct = (c as HTMLElement).tagName.toLowerCase();
          if (ct === 'ul' || ct === 'ol') {
            const sub: string[] = [];
            serializeBlock(c as HTMLElement, indent + '  ', sub);
            if (sub.length) lines.push(sub.join('\n'));
          }
        }
      });
      i++;
    });
    if (lines.length) out.push(lines.join('\n'));
    return;
  }
  if (tag === 'pre') {
    // Code block — raw text (inlineText skips the Copy <button> that lives in
    // the block header), wrapped in a fence as ONE out-entry. It used to push
    // every line as its own entry; the caller joins entries with '\n\n', so a
    // copied block came out with a blank line between every code line.
    const code = inlineText(el).replace(/^\n+/, '').replace(/\n$/, '');
    out.push(indent + '```\n' + code.split('\n').map((l) => indent + l).join('\n') + '\n' + indent + '```');
    return;
  }
  if (tag === 'hr') {
    out.push(indent + '---');
    return;
  }
  if (tag === 'table') {
    // best-effort: rows as "| a | b |" lines
    el.querySelectorAll('tr').forEach((tr) => {
      const cells = [...tr.children].map((c) => inlineText(c as HTMLElement).trim());
      out.push(indent + '| ' + cells.join(' | ') + ' |');
    });
    return;
  }
  // Unknown block container — recurse into children.
  serializeChildren(el, indent, out);
}

// li inline text EXCLUDING nested ul/ol (those are serialized separately).
function liInlineOnly(li: HTMLElement): string {
  let out = '';
  li.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent || '';
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const t = (child as HTMLElement).tagName.toLowerCase();
      if (t === 'ul' || t === 'ol') return; // handled by recursion
      if (t === 'p') out += inlineText(child as HTMLElement); // loose list <li><p>…
      else if (t === 'br') out += '\n';
      else out += inlineText(child as HTMLElement);
    }
  });
  return out;
}

function serializeChildren(root: Node, indent: string, out: string[]): void {
  // Inline runs ACCUMULATE into one out-entry; only real block elements flush.
  // The old per-node push treated every text node and every <span> as its own
  // block — and since the caller joins entries with '\n\n', selecting inside a
  // syntax-highlighted code block (token-per-span DOM) pasted as one word per
  // paragraph. Internal whitespace of a run is preserved (code newlines survive);
  // only the run's outer blank edges are trimmed.
  let run = '';
  const flush = () => {
    const t = run.replace(/^\n+/, '').replace(/\n+$/, '');
    if (t.trim()) out.push(indent + t);
    run = '';
  };
  root.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      run += child.textContent || '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') { run += '\n'; return; }
      if (tag === 'button') return;            // UI chrome (Copy) — not content
      if (INLINE.has(tag)) { run += inlineText(el); return; }
      flush();
      serializeBlock(el, indent, out);
    }
  });
  flush();
}

/**
 * Serialize a selection Range (cloned contents) to markdown text.
 * Returns null if nothing meaningful was extracted (caller keeps default copy).
 */
export function selectionToMarkdown(range: Range): string | null {
  const frag = range.cloneContents();
  if (!frag || !frag.childNodes.length) return null;
  const out: string[] = [];
  serializeChildren(frag, '', out);
  const text = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}
