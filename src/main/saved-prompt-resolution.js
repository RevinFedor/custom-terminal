function promptId(prompt) {
  return String(prompt?.id ?? prompt?.stable_id ?? '').trim();
}

function sameGroup(left, right) {
  return (left?.group_id ?? null) === (right?.group_id ?? null);
}

// Mirrors the valid parent relation used by promptOutlineModel: a missing,
// cross-group, or cyclic parent is not inherited by the selected prompt.
function resolveSavedPromptInheritanceChain(prompt, prompts = [], { outline } = {}) {
  if (!prompt) return [];
  if (outline) {
    const { promptOutlineSelection } = require('../shared/prompt-outline.cjs');
    return promptOutlineSelection(outline, prompt.id).map(node => node.rawPrompt);
  }
  const byId = new Map((Array.isArray(prompts) ? prompts : []).map((item) => [promptId(item), item]));
  const leafId = promptId(prompt);
  if (leafId) byId.set(leafId, prompt);
  const leaf = leafId ? byId.get(leafId) : prompt;
  const chain = [leaf];
  const seen = new Set([promptId(leaf)]);
  let cursor = leaf;
  while (cursor?.visual_parent_id != null && String(cursor.visual_parent_id).trim()) {
    const parent = byId.get(String(cursor.visual_parent_id).trim());
    if (!parent || !sameGroup(parent, cursor)) break;
    const parentId = promptId(parent);
    if (!parentId || seen.has(parentId)) return [leaf];
    seen.add(parentId);
    chain.unshift(parent);
    cursor = parent;
  }
  return chain;
}

async function resolveSavedPromptComposition(prompt, prompts, resolvePart, options) {
  const chain = resolveSavedPromptInheritanceChain(prompt, prompts, options);
  const parts = [];
  const steps = [];
  for (const item of chain) {
    const resolved = await resolvePart(item);
    const values = Array.isArray(resolved?.parts) ? resolved.parts : resolved;
    const itemParts = (Array.isArray(values) ? values : [values])
      .map((part) => typeof part === 'string' ? part.trim() : '')
      .filter(Boolean);
    if (itemParts.length === 0) {
      const error = new Error('saved prompt inheritance contains an empty step: ' + (item?.title || promptId(item) || 'untitled'));
      error.statusCode = 409;
      error.code = 'saved_prompt_empty';
      error.promptId = promptId(item) || null;
      error.promptTitle = item?.title || null;
      throw error;
    }
    parts.push(...itemParts);
    steps.push({ prompt: item, parts: itemParts, files: Array.isArray(resolved?.files) ? resolved.files : [] });
  }
  return { chain, parts, steps };
}

module.exports = { resolveSavedPromptInheritanceChain, resolveSavedPromptComposition };
