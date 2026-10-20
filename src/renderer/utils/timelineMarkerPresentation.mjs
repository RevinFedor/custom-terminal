import { getAutomaticContinuationKind, getTerminalMcpTag, isSystemPromptEntry } from '../../shared/prompt-origin.mjs';
import { projectNativeQuestionReply } from '../../shared/native-question-reply.mjs';

const isScResearchTag = tag => tag?.kind === 'orchestration' && tag.runKind === 'external-research'
  && typeof tag.runId === 'string' && !!tag.runId.trim();

export function timelineMarkerKind(entry, fingerprint) {
  if (entry?.questionReplyProof && projectNativeQuestionReply(entry, fingerprint)) return 'question-reply';
  const tag = getTerminalMcpTag(entry);
  if (isScResearchTag(tag)) return 'sc-desktop';
  if (tag) return 'terminal-mcp';
  const continuation = getAutomaticContinuationKind(entry);
  if (continuation) return continuation;
  return isSystemPromptEntry(entry) ? 'system' : 'ordinary';
}

/** SC Desktop owns a standalone source point, even next to other SC results.
 * It also breaks a run of MCP entries: grouping must not bridge across it. */
export function timelineAutomaticGroupKind(entry) {
  const tag = getTerminalMcpTag(entry);
  if (tag) return isScResearchTag(tag) ? null : 'orchestration';
  return entry?.isSubAgent || entry?.isSubAgentTimeout ? 'subagent' : null;
}

export function collectTimelineDocs(entries) {
  const edited = new Set();
  const searched = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const file of Array.isArray(entry?.docsEdited) ? entry.docsEdited : []) {
      if (typeof file === 'string' && file.trim()) edited.add(file);
    }
    for (const query of Array.isArray(entry?.docsSearchQueries) ? entry.docsSearchQueries : []) {
      if (typeof query === 'string' && query.trim()) searched.add(query);
    }
    if (entry?.type === 'docs_edit' && typeof entry.content === 'string' && entry.content.trim()) {
      edited.add(entry.content);
    }
    if (entry?.type === 'docs_search' && typeof entry.content === 'string' && entry.content.trim()) {
      searched.add(entry.content);
    }
  }

  return { edited: [...edited], searched: [...searched] };
}

export function collectTimelinePromptLabels(entries) {
  const labels = new Set();
  let hasPromptChip = false;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.hasPromptChip === true) hasPromptChip = true;
    for (const label of Array.isArray(entry?.promptChipLabels) ? entry.promptChipLabels : []) {
      if (typeof label === 'string' && label.trim()) {
        hasPromptChip = true;
        labels.add(label.trim());
      }
    }
    for (const chip of Array.isArray(entry?.promptChips) ? entry.promptChips : []) {
      if (chip?.kind !== 'prompt') continue;
      hasPromptChip = true;
      const label = typeof chip.label === 'string' ? chip.label.trim() : '';
      if (label) labels.add(label);
    }
  }

  return labels.size > 0 ? [...labels] : hasPromptChip ? ['PROMPT'] : [];
}

export function isTimelineGroupExpanded(_isExpandedLayout, requestedExpanded) {
  // Opening a vertical group does not choose the rail's horizontal layout.
  return requestedExpanded === true;
}

const markerGeometryCache = new Map();

export function timelineMarkerGeometry({
  isOrchestration,
  isSystem = false,
  displaysAsCompact,
  showAsChild,
  isHovered,
  isInViewport,
}) {
  const cacheKey = [
    isOrchestration || isSystem,
    displaysAsCompact,
    showAsChild,
    isHovered,
    isInViewport,
  ].map(Boolean).map(Number).join('');
  const cached = markerGeometryCache.get(cacheKey);
  if (cached) return cached;

  if (isOrchestration || isSystem) {
    const side = isHovered ? 10 : showAsChild ? 7 : isInViewport ? 8 : 6;
    const geometry = { width: `${side}px`, height: `${side}px`, radius: '2px' };
    markerGeometryCache.set(cacheKey, geometry);
    return geometry;
  }

  const geometry = {
    width: displaysAsCompact
      ? (isHovered ? '10px' : '7px')
      : showAsChild
        ? (isHovered ? '8px' : (isInViewport ? '8px' : '4px'))
        : (isHovered ? '10px' : (isInViewport ? '10px' : '5px')),
    height: displaysAsCompact
      ? (isHovered ? '10px' : '7px')
      : showAsChild
        ? (isHovered ? '8px' : (isInViewport ? '3px' : '4px'))
        : (isHovered ? '10px' : (isInViewport ? '3px' : '5px')),
    radius: displaysAsCompact ? '50%' : (isInViewport && !isHovered ? '1px' : '50%'),
  };
  markerGeometryCache.set(cacheKey, geometry);
  return geometry;
}

const cornerBadgeCache = new Map();

export function buildTimelineCornerBadges({
  isLoop = false,
  hasPromptChip = false,
  docsEditedCount = 0,
  docsSearchCount = 0,
  subagentCount = 0,
  collapsedGroupSize = 0,
  compactClusterSize = 0,
} = {}) {
  const compactCount = compactClusterSize > 1 ? String(compactClusterSize) : null;
  const groupCount = collapsedGroupSize > 1 ? String(collapsedGroupSize) : null;
  const count = compactCount || groupCount;
  const countTone = compactCount ? 'compact' : count ? 'group' : null;
  const cacheKey = `${isLoop ? 1 : 0}${hasPromptChip ? 1 : 0}${docsEditedCount > 0 ? 1 : 0}${docsSearchCount > 0 ? 1 : 0}:a${Math.max(0, Number(subagentCount) || 0)}:${countTone || ''}:${count || ''}`;
  const cached = cornerBadgeCache.get(cacheKey);
  if (cached) return cached;

  const rightIcons = [];
  if (isLoop) rightIcons.push('loop');
  if (docsEditedCount > 0) rightIcons.push('docs-edit');
  if (docsSearchCount > 0) rightIcons.push('docs-search');
  if (subagentCount > 0) rightIcons.push('agents');
  const icons = hasPromptChip ? ['prompt', ...rightIcons] : rightIcons;

  const ordered = rightIcons.map(kind => ({
    kind,
    ...(kind === 'agents' ? { text: String(subagentCount) } : {}),
  }));
  if (count) {
    const countItem = { kind: 'count', text: count, tone: countTone };
    if (countTone === 'compact' && ordered.length > 0) ordered.splice(1, 0, countItem);
    else ordered.push(countItem);
  }

  const slots = ordered.length === 1 && countTone === 'group'
    ? ['bottom-right']
    : ordered.length === 1
      ? ['top-right']
      : ordered.length === 2
        ? ['top-right', 'bottom-right']
        : ['top-right', 'middle-right', 'bottom-right', 'middle-inner'];
  const rightItems = ordered.slice(0, slots.length).map((item, index) => ({
    ...item,
    slot: slots[index],
  }));
  // A saved prompt is provenance for the whole iteration, not another item in
  // the crowded right-side activity stack. Keep one stable glyph in the free
  // upper-left corner regardless of how many prompt chips were attached.
  const items = hasPromptChip
    ? [{ kind: 'prompt', slot: 'top-left' }, ...rightItems]
    : rightItems;

  const result = {
    icons,
    count,
    countTone,
    items,
  };
  cornerBadgeCache.set(cacheKey, result);
  return result;
}
