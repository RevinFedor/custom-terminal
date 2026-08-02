// Shared visual language of a tab card. Extracted from TabBar.tsx so that
// every surface rendering a "tab" (TabBar vertical list, Ctrl+Tab switcher,
// split-pane attach row) resolves colors through ONE table instead of
// re-declaring rgba literals. This is the first step of the planned unified
// tab-card component: chrome (bg tint + border) lives here, geometry stays
// with each surface.
//
// IMPORTANT: values are canonical. Claude saffron #DA7756 / Gemini #4E86F8 /
// Codex #10A37F are the same brand tints used in ActionsPanel, InfoPanel and
// ApiSettingsModal — do not fork per-surface variants.

export interface TabChromeColorEntry {
  color: string;
  bgColor: string;
  borderColor: string;
  label: string;
}

export const TAB_COLORS: TabChromeColorEntry[] = [
  { color: 'default', bgColor: 'transparent', borderColor: '#666', label: '⚪ Default' },
  { color: 'red', bgColor: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgb(239, 68, 68)', label: '🔴 Red' },
  { color: 'yellow', bgColor: 'rgba(234, 179, 8, 0.2)', borderColor: 'rgb(234, 179, 8)', label: '🟡 Yellow' },
  { color: 'green', bgColor: 'rgba(34, 197, 94, 0.2)', borderColor: 'rgb(34, 197, 94)', label: '🟢 Green' },
  { color: 'blue', bgColor: 'rgba(59, 130, 246, 0.2)', borderColor: 'rgb(59, 130, 246)', label: '🔵 Blue' },
  { color: 'purple', bgColor: 'rgba(168, 85, 247, 0.2)', borderColor: 'rgb(168, 85, 247)', label: '🟣 Purple' },
  { color: 'claude', bgColor: 'rgba(218, 119, 86, 0.2)', borderColor: '#DA7756', label: '🟠 Claude' },
  { color: 'gemini', bgColor: 'rgba(78, 134, 248, 0.2)', borderColor: '#4E86F8', label: '💎 Gemini' },
  { color: 'codex', bgColor: 'rgba(16, 163, 127, 0.18)', borderColor: '#10A37F', label: 'Codex' },
];

// Increase/decrease alpha of an rgba() string. Vertical tab list encodes
// activity through background saturation (inactive=base, hover=+0.08,
// active=+0.25) — see fact-tabs.md::Активность через bg-saturation.
export const adjustRgbaAlpha = (rgba: string, delta: number): string => {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
  if (!m) return rgba;
  const [, r, g, b, a = '0.2'] = m;
  const newAlpha = Math.max(0, Math.min(1, parseFloat(a) + delta));
  return `rgba(${r}, ${g}, ${b}, ${newAlpha})`;
};

export const TABBAR_PANEL_RGB = { r: 37, g: 37, b: 38 };
export const TABBAR_PANEL_BG = `rgb(${TABBAR_PANEL_RGB.r}, ${TABBAR_PANEL_RGB.g}, ${TABBAR_PANEL_RGB.b})`;

// Composite a translucent tab tint onto the tabbar panel background so drag
// previews / overlays don't double-blend with whatever sits beneath them.
export const flattenRgbaOnTabbarPanel = (color: string): string => {
  if (color === 'transparent') return TABBAR_PANEL_BG;
  const m = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,?\s*([\d.]+))?\s*\)/);
  if (!m) return color;
  const [, rText, gText, bText, aText] = m;
  const alpha = aText === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(aText)));
  const r = Number(rText);
  const g = Number(gText);
  const b = Number(bText);
  if (alpha >= 1) return `rgb(${r}, ${g}, ${b})`;
  const blend = (fg: number, bg: number) => Math.round((fg * alpha) + (bg * (1 - alpha)));
  return `rgb(${blend(r, TABBAR_PANEL_RGB.r)}, ${blend(g, TABBAR_PANEL_RGB.g)}, ${blend(b, TABBAR_PANEL_RGB.b)})`;
};

// SDK claude tabs share `color: 'claude'` with PTY claude tabs but get a
// distinct terracotta hue at the chrome layer; linked file tabs get the
// purple file surface. Same override rules as TabBar.
export const getTabChromeColorConfig = (
  tab: { color?: string; tabType?: string },
): TabChromeColorEntry => {
  const base = TAB_COLORS.find(c => c.color === tab.color) || TAB_COLORS[0];
  return tab.tabType === 'claude-sdk' && tab.color === 'claude'
    ? { ...base, bgColor: 'rgba(210, 140, 90, 0.30)', borderColor: '#D28C5A' }
    : tab.tabType === 'file'
      ? { ...base, bgColor: '#181725', borderColor: '#8b5cf6' }
      : base;
};
