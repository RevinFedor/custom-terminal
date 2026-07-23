import { visit } from 'unist-util-visit';
import type { Root, ElementContent, Element, Text } from 'hast';

// #FFF | #FFFFFF | rgb(250, 204, 21) | rgba(250, 204, 21, 0.198).
// Boundaries avoid tails like #ABCDEFG. Prose and inline code are transformed;
// fenced code blocks stay literal.
const COLOR_RE = /(?<![\w#])#([0-9a-f]{6}|[0-9a-f]{3})\b|\brgba?\(\s*(25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(25[0-5]|2[0-4]\d|1?\d?\d)(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+))?\s*\)/gi;

const expandShort = (h: string) => h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);

type Rgb = { r: number; g: number; b: number; a?: number };

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function parseColor(raw: string): { css: string; rgb: Rgb } | null {
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(raw);
  if (hex) {
    const hex6 = expandShort(hex[1]);
    return {
      css: '#' + hex6,
      rgb: {
        r: parseInt(hex6.slice(0, 2), 16),
        g: parseInt(hex6.slice(2, 4), 16),
        b: parseInt(hex6.slice(4, 6), 16),
        a: 1,
      },
    };
  }

  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+))?\s*\)$/i.exec(raw);
  if (!rgb) return null;
  return {
    css: raw,
    rgb: {
      r: clamp255(Number(rgb[1])),
      g: clamp255(Number(rgb[2])),
      b: clamp255(Number(rgb[3])),
      a: rgb[4] == null ? 1 : Math.max(0, Math.min(1, Number(rgb[4]))),
    },
  };
}

// YIQ contrast — стандартная формула для выбора чёрного/белого текста по фону.
// For rgba, estimate the visible color over the chat's dark prose background.
const pickFg = ({ r, g, b, a = 1 }: Rgb) => {
  if (a < 1) {
    const base = { r: 22, g: 22, b: 25 };
    r = Math.round(r * a + base.r * (1 - a));
    g = Math.round(g * a + base.g * (1 - a));
    b = Math.round(b * a + base.b * (1 - a));
  }
  return (r * 299 + g * 587 + b * 114) / 1000 >= 140 ? '#000' : '#fff';
};

const makeChip = (raw: string): Element => {
  const parsed = parseColor(raw);
  if (!parsed) return { type: 'element', tagName: 'span', properties: {}, children: [{ type: 'text', value: raw }] };
  const fg = pickFg(parsed.rgb);
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      style: `background-color:${parsed.css};color:${fg};padding:0 4px;border-radius:3px;font-family:inherit;`,
      'data-hex-chip': '',
    },
    children: [{ type: 'text', value: raw }],
  };
};

export function rehypeHexHighlight() {
  return (tree: Root) => {
    const fencedCodeNodes = new WeakSet<Element>();
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'pre') return;
      for (const child of node.children) {
        if (child.type === 'element' && child.tagName === 'code') fencedCodeNodes.add(child);
      }
    });

    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index == null) return;
      const parentTag = parent.type === 'element' ? (parent as Element).tagName : '';
      const className = parent.type === 'element' ? (parent as Element).properties?.className : undefined;
      const classes = Array.isArray(className) ? className : typeof className === 'string' ? className.split(/\s+/) : [];
      const isFencedCode = parentTag === 'pre' || (parentTag === 'code' && (fencedCodeNodes.has(parent as Element) || classes.some(c => /^language-/i.test(String(c)))));
      if (parentTag === 'style' || parentTag === 'script' || isFencedCode) return;

      const value = node.value;
      COLOR_RE.lastIndex = 0;
      if (!value || !COLOR_RE.test(value)) {
        COLOR_RE.lastIndex = 0;
        return;
      }
      COLOR_RE.lastIndex = 0;

      const out: ElementContent[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = COLOR_RE.exec(value))) {
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
