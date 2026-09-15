'use strict';

// Presentation grammar only. The caller must supply the current committed
// screen and prove its process/input owner before performing any action.
function inspectCodexUsagePrompt(value) {
  const text = String(value || '').replace(/\u00a0/g, ' ');
  const compact = text.replace(/\s+/g, ' ').trim();
  const footer = /Press enter to confirm or esc to continue working\s*$/i.test(compact);
  const fallback = /(?:^|\n)\s*(?:[›❯»>]\s*)?\d+\.\s*Continue\s+with\s+Luna\s+Reserve\b/i.test(text);
  if (!footer || !fallback) return { visible: false, interactive: false, options: [] };
  const candidates = [...text.matchAll(/(?:^|\n)\s*(?:([›❯»>])\s*)?(\d+)\.\s*([^\n]*)/g)];
  const start = candidates.findLastIndex(match => /Add\s+Credits\b/i.test(match[3]));
  if (start < 0) return { visible: false, interactive: false, options: [] };
  const menu = candidates.slice(start).map((match, index, rows) => {
    const end = rows[index + 1]?.index ?? text.toLowerCase().lastIndexOf('press enter to confirm');
    const label = text.slice(match.index + match[0].length - match[3].length, end)
      .replace(/\s+/g, ' ').trim();
    return { index: Number(match[2]), selected: !!match[1], label };
  });
  const selected = menu.filter(option => option.selected);
  const target = menu.find(option => /^Continue with Luna Reserve$/i.test(option.label));
  const valid = menu.length >= 2 && menu.length <= 3 && !!target
    && menu.every((option, index) => option.index === index + 1
      && /^(Add Credits|Reset usage|Continue with Luna Reserve)$/i.test(option.label));
  const noticeAt = text.lastIndexOf('You’re now using');
  const asciiNoticeAt = text.lastIndexOf("You're now using");
  const headerAt = Math.max(noticeAt, asciiNoticeAt);
  return { visible: true, interactive: valid && selected.length === 1,
    selectedIndex: selected.length === 1 ? selected[0].index : null,
    targetIndex: target?.index ?? null, options: menu,
    // A menu-only narrow screen is allowed; full grammar, not the prose, owns it.
    startIndex: headerAt >= 0 && headerAt < candidates[start].index ? headerAt : candidates[start].index,
    reason: valid ? selected.length === 1 ? null : 'selection-unproven' : 'usage-options-unproven' };
}

function inspectCodexModelSwitchNotice(value) {
  const text = String(value || '').replace(/\s+/g, ' ');
  const matches = [...text.matchAll(/Automatically switched back to ([a-z0-9][a-z0-9_.-]*) (none|minimal|low|medium|high|xhigh|max|ultra) because ordinary usage is available again\./gi)];
  const match = matches.at(-1);
  return match ? { model: match[1], effort: match[2].toLowerCase(), reason: 'ordinary-usage-restored' } : null;
}

module.exports = { inspectCodexUsagePrompt, inspectCodexModelSwitchNotice };
