'use strict';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalized(value) {
  return clean(value).toLocaleLowerCase();
}

function normalizeSavedPromptRefs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    const error = new Error('prompts must be an array');
    error.statusCode = 400;
    error.code = 'invalid_prompt_refs';
    throw error;
  }
  const seen = new Set();
  return value.flatMap((item) => {
    const ref = typeof item === 'string'
      ? { value: clean(item) }
      : {
        promptId: clean(item?.promptId || item?.id),
        title: clean(item?.title || item?.name),
      };
    if (!ref.value && !ref.promptId && !ref.title) {
      const error = new Error('each prompt reference needs an exact title or promptId');
      error.statusCode = 400;
      error.code = 'invalid_prompt_ref';
      throw error;
    }
    const key = ref.promptId
      ? `id:${ref.promptId}`
      : `title:${normalized(ref.title || ref.value)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [ref];
  });
}

function promptId(prompt) {
  return clean(prompt?.id ?? prompt?.stable_id ?? prompt?.stableId);
}

function promptTitle(prompt) {
  return clean(prompt?.title ?? prompt?.name);
}

function selectSavedPrompt(prompts, ref) {
  const rows = Array.isArray(prompts) ? prompts : [];
  const requestedId = clean(ref?.promptId);
  const requestedTitle = clean(ref?.title);
  const shorthand = clean(ref?.value);

  if (requestedId) {
    const match = rows.find((row) => promptId(row) === requestedId);
    if (!match) {
      const error = new Error('saved prompt not found: ' + requestedId);
      error.statusCode = 404;
      error.code = 'saved_prompt_not_found';
      throw error;
    }
    if (requestedTitle && normalized(promptTitle(match)) !== normalized(requestedTitle)) {
      const error = new Error('promptId and title identify different saved prompts');
      error.statusCode = 409;
      error.code = 'saved_prompt_identity_conflict';
      throw error;
    }
    return match;
  }

  if (shorthand) {
    const idMatch = rows.find((row) => promptId(row) === shorthand);
    if (idMatch) return idMatch;
  }
  const title = requestedTitle || shorthand;
  const matches = rows.filter((row) => normalized(promptTitle(row)) === normalized(title));
  if (matches.length === 0) {
    const error = new Error('saved prompt not found with exact title: ' + title);
    error.statusCode = 404;
    error.code = 'saved_prompt_not_found';
    throw error;
  }
  if (matches.length > 1) {
    const error = new Error('several saved prompts have this title; use promptId: '
      + matches.map((row) => `${promptTitle(row)} (${promptId(row)})`).join(', '));
    error.statusCode = 409;
    error.code = 'saved_prompt_title_ambiguous';
    throw error;
  }
  return matches[0];
}

function escapeLabel(label) {
  return String(label || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function buildSavedPromptWrapper(chip) {
  const label = escapeLabel(chip?.label || 'PROMPT');
  const body = String(chip?.text || '').split('</saved_prompt>').join('<\\/saved_prompt>');
  return `<saved_prompt name="${label}">\n${body}\n</saved_prompt>`;
}

async function resolveSavedPromptRefs({ refs, prompts, resolveText }) {
  const normalizedRefs = normalizeSavedPromptRefs(refs);
  const chips = [];
  for (const [index, ref] of normalizedRefs.entries()) {
    const prompt = selectSavedPrompt(prompts, ref);
    const id = promptId(prompt);
    const title = promptTitle(prompt) || 'PROMPT';
    const text = clean(await resolveText(prompt));
    if (!text) {
      const error = new Error('saved prompt resolved to empty text: ' + title);
      error.statusCode = 409;
      error.code = 'saved_prompt_empty';
      throw error;
    }
    chips.push({
      id: `saved-prompt-${id || index}`,
      kind: 'prompt',
      label: title,
      text,
      sourceKey: id ? `prompt:${id}` : `prompt-title:${normalized(title)}`,
      promptId: id || null,
    });
  }
  return chips;
}

function prependSavedPromptChips(prompt, chips) {
  const task = String(prompt || '');
  const wrappers = (Array.isArray(chips) ? chips : []).map(buildSavedPromptWrapper);
  return [...wrappers, ...(task ? [task] : [])].join('\n\n');
}

module.exports = {
  buildSavedPromptWrapper,
  normalizeSavedPromptRefs,
  prependSavedPromptChips,
  resolveSavedPromptRefs,
  selectSavedPrompt,
};
