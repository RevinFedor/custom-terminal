'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { RUN_AFTER_LOOP_PROMPT_ID } = require('../shared/prompt-loop.cjs');

const FIELDS = ['name', 'content', 'model', 'thinkingLevel', 'color', 'showInContextMenu', 'position', 'filePaths'];
const USES = {
  research: ['research'], compact: ['compact'], description: ['description'], adopt: ['adopt-summary'],
  'tab-title': ['tab-title'], 'run-after-title': ['run-after-title'], 'prompt-summary': ['prompt-summary'],
  'timeline-grouping': ['timeline-grouping'], 'git-commit': ['git-commit'],
  'task-theme': ['task-theme'],
  [RUN_AFTER_LOOP_PROMPT_ID]: ['run-after-loop'],
};
function error(code, message, statusCode = 400, extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...extra });
}
const revision = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function assertRevision(expected, current) {
  if (typeof expected !== 'string' || !expected) throw error('system_prompt_revision_required', 'revision is required');
  if (expected !== current.revision) throw error('system_prompt_stale', 'System prompt changed; read it again before editing', 409, { current });
}
function validate(prompt) {
  for (const key of ['name', 'model']) {
    if (typeof prompt[key] !== 'string' || !prompt[key].trim() || prompt[key].length > 200) throw error('system_prompt_invalid', key + ' must be a non-empty string up to 200 characters');
  }
  if (typeof prompt.content !== 'string' || Buffer.byteLength(prompt.content) > 1024 * 1024) throw error('system_prompt_invalid', 'content must be text up to 1 MiB');
  if (!['NONE', 'LOW', 'MEDIUM', 'HIGH'].includes(prompt.thinkingLevel)) throw error('system_prompt_invalid', 'thinkingLevel must be NONE, LOW, MEDIUM or HIGH');
  if (!/^#[a-f0-9]{6}$/i.test(prompt.color)) throw error('system_prompt_invalid', 'color must be #RRGGBB');
  if (typeof prompt.showInContextMenu !== 'boolean') throw error('system_prompt_invalid', 'showInContextMenu must be boolean');
  if (!Number.isSafeInteger(prompt.position) || prompt.position < 0) throw error('system_prompt_invalid', 'position must be a non-negative integer');
  if (!Array.isArray(prompt.filePaths) || prompt.filePaths.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0'))) throw error('system_prompt_invalid', 'filePaths must contain absolute paths');
}
function record(prompt) {
  return Object.fromEntries(['id', ...FIELDS, 'isBuiltIn'].map(key => [key, key === 'filePaths' ? [...(prompt[key] || [])] : prompt[key]]));
}

function createSystemPromptService({ projectManager, onChanged = () => {} }) {
  const db = projectManager.db;
  const raw = id => {
    const prompt = projectManager.getAIPrompts().find(p => p.id === id);
    if (!prompt) throw error('system_prompt_not_found', 'System prompt not found: ' + id, 404);
    return record(prompt);
  };
  const getSettings = () => {
    const data = { rewindPromptId: db.getAppState('rewindPromptId') || 'rewind' };
    return { ...data, revision: revision(data) };
  };
  const publish = prompt => {
    const usage = [...(USES[prompt.id] || [])];
    if (getSettings().rewindPromptId === prompt.id) usage.push('rewind');
    if (prompt.showInContextMenu) usage.push('context-menu');
    const editableFields = prompt.id === RUN_AFTER_LOOP_PROMPT_ID
      ? ['name', 'content', 'color', 'position'] : FIELDS;
    return { ...prompt, revision: revision(prompt), usage, editableFields,
      execution: prompt.id === RUN_AFTER_LOOP_PROMPT_ID ? 'tab-agent' : 'configured-model' };
  };
  const get = id => publish(raw(id));
  const emit = (promptIds = [], removedIds = []) => {
    onChanged({ prompts: promptIds.map(get), removedIds, settings: getSettings() });
  };
  const transact = fn => db.db.transaction(fn)();
  function create(input) {
    const id = input.id || 'prompt-' + crypto.randomUUID();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw error('system_prompt_invalid', 'id must contain letters, digits, _ or -');
    if (Object.keys(input).some(k => !['id', ...FIELDS].includes(k))) throw error('system_prompt_invalid', 'unknown or read-only field');
    const result = transact(() => {
      const all = projectManager.getAIPrompts();
      if (all.some(p => p.id === id) || id in USES || id === 'rewind' || id === 'settings') throw error('system_prompt_id_conflict', 'System prompt id is already reserved', 409);
      const prompt = { id, name: input.name, content: '', model: 'gemini-3.8-flash', thinkingLevel: 'NONE',
        color: '#6366f1', showInContextMenu: true, position: Math.max(-1, ...all.map(p => p.position)) + 1, filePaths: [],
        ...input, isBuiltIn: false };
      validate(prompt); projectManager.saveAIPrompt(prompt); return get(id);
    });
    emit([id]); return result;
  }
  function update(id, input, { emitChanged = true } = {}) {
    if (Object.keys(input).some(k => !['revision', ...FIELDS].includes(k))) throw error('system_prompt_invalid', 'unknown or read-only field');
    const result = transact(() => {
      const current = get(id); assertRevision(input.revision, current);
      const patch = Object.fromEntries(FIELDS.filter(k => input[k] !== undefined).map(k => [k, input[k]]));
      for (const key of Object.keys(patch)) {
        if (!current.editableFields.includes(key) && !same(patch[key], current[key])) throw error('system_prompt_field_unavailable', key + ' is not used by this prompt');
      }
      const next = { ...record(current), ...patch };
      validate(next); projectManager.saveAIPrompt(next); return get(id);
    });
    if (emitChanged) emit([id]); return result;
  }
  function remove(id, expectedRevision) {
    transact(() => {
      const current = get(id); assertRevision(expectedRevision, current);
      if (current.isBuiltIn) throw error('system_prompt_builtin', 'Built-in system prompts cannot be deleted', 409);
      if (getSettings().rewindPromptId === id) throw error('system_prompt_in_use', 'Select another Rewind prompt before deleting this one', 409);
      projectManager.deleteAIPrompt(id);
    });
    emit([], [id]); return { deleted: true, id };
  }
  function updateSettings(input) {
    if (Object.keys(input).some(k => !['revision', 'rewindPromptId'].includes(k))) throw error('system_prompt_invalid', 'unknown system prompt setting');
    const result = transact(() => {
      assertRevision(input.revision, getSettings());
      if (input.rewindPromptId !== undefined) {
        const prompt = get(input.rewindPromptId);
        if (prompt.id === RUN_AFTER_LOOP_PROMPT_ID) throw error('system_prompt_field_unavailable', 'Loop cannot be assigned to Rewind');
        db.setAppState('rewindPromptId', prompt.id);
      }
      return getSettings();
    });
    emit(projectManager.getAIPrompts().map(p => p.id)); return result;
  }
  return {
    get, create, update, remove, getSettings, updateSettings,
    list({ query = '', includeContent = false } = {}) {
      return projectManager.getAIPrompts().map(publish).filter(p =>
        `${p.id} ${p.name} ${p.usage.join(' ')}`.toLowerCase().includes(String(query).toLowerCase())
      ).map(p => {
        if (includeContent) return p;
        const { content, ...metadata } = p; return { ...metadata, contentChars: content.length };
      });
    },
    saveFromSettings(prompt) {
      const fields = Object.fromEntries(FIELDS.filter(k => prompt[k] !== undefined).map(k => [k, prompt[k]]));
      if (!projectManager.getAIPrompts().some(p => p.id === prompt.id)) {
        if (prompt.revision || prompt.editBase) throw error('system_prompt_not_found', 'System prompt was deleted; the editor draft was not recreated', 404);
        return create({ id: prompt.id, ...fields });
      }
      if (prompt.editBase?.id === prompt.id) {
        const current = get(prompt.id);
        const patch = Object.fromEntries(Object.entries(fields).filter(([key, value]) => !same(value, prompt.editBase[key])));
        for (const [key, value] of Object.entries(patch)) {
          if (!same(current[key], prompt.editBase[key]) && !same(current[key], value)) {
            throw error('system_prompt_stale', 'System prompt field changed in another editor: ' + key, 409, { current });
          }
        }
        return Object.keys(patch).length ? update(prompt.id, { ...patch, revision: current.revision }) : current;
      }
      return update(prompt.id, { ...fields, revision: prompt.revision || get(prompt.id).revision });
    },
    saveContent(id, content, options) { return update(id, { content, revision: get(id).revision }, options); },
    // Paired callers may include this write in their own SQLite transaction;
    // publish only after that outer transaction committed successfully.
    publishChanges: emit,
  };
}
module.exports = { createSystemPromptService };
