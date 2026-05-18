import { visit } from 'unist-util-visit';
import type { Root, ElementContent, Element, Text, Parent } from 'hast';

// #FFF | #FFFFFF | #FFFFFFFF — границы по non-word слева/справа чтобы не
// захватывать хвосты типа #ABCDEFG (7 символов).
const HEX_RE = /(?<![\w#])#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b/gi;

const expandShort = (h: string) => h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);

// YIQ contrast — стандартная формула для выбора чёрного/белого текста по фону.
// Альфа в 8-знаках игнорируем для расчёта: chip визуально показывает hue, не alpha.
const pickFg = (hex6: string) => {
  const r = parseInt(hex6.slice(0, 2), 16);
  const g = parseInt(hex6.slice(2, 4), 16);
  const b = parseInt(hex6.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 140 ? '#000' : '#fff';
};

const makeChip = (raw: string): Element => {
  const hex6 = expandShort(raw.replace(/^#/, ''));
  const fg = pickFg(hex6);
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      style: `background-color:#${hex6};color:${fg};padding:0 4px;border-radius:3px;font-family:inherit;`,
      'data-hex-chip': '',
    },
    children: [{ type: 'text', value: raw }],
  };
};

// Skip text nodes inside diff-блоков (plus/minus как git diff) — там цвета
// токенов важнее. Остальной код (включая CSS/SCSS) подсвечивается.
const parentIsDiffCode = (parent: Parent | undefined): boolean => {
  if (!parent || parent.type !== 'element') return false;
  const el = parent as Element;
  if (el.tagName !== 'code') return false;
  const cn = el.properties?.className;
  const classes = Array.isArray(cn) ? cn : typeof cn === 'string' ? cn.split(' ') : [];
  return classes.some(c => /^language-diff$/i.test(String(c)));
};

export function rehypeHexHighlight() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index == null) return;
      if (parent.type === 'element' && (parent as Element).tagName === 'style') return;
      if (parentIsDiffCode(parent as Parent)) return;

      const value = node.value;
      HEX_RE.lastIndex = 0;
      if (!value || !HEX_RE.test(value)) {
        HEX_RE.lastIndex = 0;
        return;
      }
      HEX_RE.lastIndex = 0;

      const out: ElementContent[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = HEX_RE.exec(value))) {
        if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
        out.push(makeChip(m[0]));
        last = m.index + m[0].length;
      }
      if (last < value.length) out.push({ type: 'text', value: value.slice(last) });

      (parent as Element).children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}
