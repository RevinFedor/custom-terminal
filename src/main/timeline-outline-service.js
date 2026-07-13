const crypto = require('node:crypto');

const TIMELINE_GROUPING_PROMPT_ID = 'timeline-grouping';
const OUTLINE_SCHEMA_VERSION = 2;
const DEFAULT_TOTAL_EXCERPT_CHARS = 120_000;
const DEFAULT_MAX_EXCERPT_CHARS = 2_400;
const MAX_INPUT_TOKENS = 180_000;
const TRUNCATION_MARKER = '\n\u2026[middle omitted]\u2026\n';
const MEMBER_ROLES = Object.freeze([
  'implementation',
  'clarification',
  'verification',
  'fix',
  'documentation',
  'meta',
  'other',
]);

const registeredChannels = new Set();
const generationInflight = new Map();

class TimelineOutlineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TimelineOutlineError';
    this.code = code;
  }
}

function normalizePrefixText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^[\s\uFEFF]+/, '');
}

function normalizePromptContent(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^[\s\uFEFF]+/, '')
    .trim();
}

function createMetaPromptMarker(preset) {
  return {
    kind: 'meta_prompt',
    presetId: String(preset?.id || preset?.stable_id || ''),
    title: String(preset?.title || preset?.name || 'Meta prompt').trim() || 'Meta prompt',
  };
}

function findPresetPrefixMatch(message, presets = []) {
  const normalizedMessage = normalizePrefixText(message);
  if (!normalizedMessage) return null;

  const candidates = [];
  for (const preset of Array.isArray(presets) ? presets : []) {
    const normalizedPreset = normalizePrefixText(preset?.content);
    if (!normalizedPreset || !normalizedMessage.startsWith(normalizedPreset)) continue;
    const marker = createMetaPromptMarker(preset);
    if (!marker.presetId) continue;
    candidates.push({ marker, matchedChars: normalizedPreset.length });
  }

  candidates.sort((left, right) => (
    right.matchedChars - left.matchedChars ||
    left.marker.presetId.localeCompare(right.marker.presetId)
  ));
  return candidates[0] || null;
}

function headTailExcerpt(value, limit, headRatio = 0.6) {
  const text = normalizePromptContent(value);
  const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (text.length <= boundedLimit) return text;
  if (boundedLimit === 0) return '';
  if (boundedLimit <= TRUNCATION_MARKER.length) {
    return text.slice(0, boundedLimit);
  }

  const payloadChars = boundedLimit - TRUNCATION_MARKER.length;
  const ratio = Number.isFinite(headRatio)
    ? Math.min(0.8, Math.max(0.2, headRatio))
    : 0.6;
  const headChars = Math.ceil(payloadChars * ratio);
  const tailChars = payloadChars - headChars;
  return text.slice(0, headChars) + TRUNCATION_MARKER + (tailChars > 0 ? text.slice(-tailChars) : '');
}

function allocateExcerptLimits(texts, totalCharBudget, maxPerEntry) {
  const lengths = texts.map((text) => normalizePromptContent(text).length);
  const limits = new Array(lengths.length).fill(0);
  let remaining = Math.max(0, Math.floor(Number(totalCharBudget) || 0));
  const perEntryMax = Math.max(1, Math.floor(Number(maxPerEntry) || DEFAULT_MAX_EXCERPT_CHARS));
  let pending = lengths.map((_, index) => index);

  while (pending.length > 0 && remaining > 0) {
    const share = Math.min(perEntryMax, Math.floor(remaining / pending.length));
    if (share <= 0) break;
    const completed = pending.filter((index) => lengths[index] <= share);
    if (completed.length === 0) {
      for (const index of pending) limits[index] = share;
      remaining -= share * pending.length;
      break;
    }
    const completedSet = new Set(completed);
    for (const index of completed) {
      limits[index] = lengths[index];
      remaining -= lengths[index];
    }
    pending = pending.filter((index) => !completedSet.has(index));
  }

  return limits;
}

function buildBoundedPromptExcerpts(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const totalCharBudget = options.totalCharBudget ?? DEFAULT_TOTAL_EXCERPT_CHARS;
  const maxPerEntry = options.maxPerEntry ?? DEFAULT_MAX_EXCERPT_CHARS;
  const ordinary = list.filter((entry) => entry?.kind === 'prompt');
  const limits = allocateExcerptLimits(
    ordinary.map((entry) => entry.text),
    totalCharBudget,
    maxPerEntry
  );
  let ordinaryIndex = 0;

  return list.map((entry) => {
    if (entry?.kind !== 'prompt') return { ...entry };
    const text = headTailExcerpt(entry.text, limits[ordinaryIndex++], options.headRatio);
    return { ...entry, text };
  });
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'undefined') return undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Cannot hash a cyclic value');
    seen.add(value);
    const serialized = '[' + value.map((item) => canonicalJson(item, seen) ?? 'null').join(',') + ']';
    seen.delete(value);
    return serialized;
  }
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) throw new TypeError('Cannot hash a cyclic value');
  seen.add(value);
  const serialized = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const child = canonicalJson(value[key], seen);
      return child === undefined ? [] : [JSON.stringify(key) + ':' + child];
    })
    .join(',');
  seen.delete(value);
  return '{' + serialized + '}';
}

function sourceSha256(value) {
  const serialized = typeof value === 'string' ? value : canonicalJson(value);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function entryType(entry) {
  return String(entry?.type || entry?.kind || '').toLowerCase();
}

function entryContent(entry) {
  if (typeof entry?.content === 'string') return entry.content;
  if (typeof entry?.full === 'string') return entry.full;
  if (typeof entry?.preview === 'string') return entry.preview;
  return '';
}

function isRealCompactEntry(entry) {
  return entryType(entry) === 'compact' && !entry?.isCompactSummary;
}

function isEligibleUserEntry(entry) {
  const type = entryType(entry);
  if (type !== 'user') return false;
  if (entry?.isCompactSummary || entry?.isSubAgent || entry?.isSubAgentTimeout) return false;
  const content = normalizePromptContent(entryContent(entry));
  if (!content || content === '/compact') return false;
  return true;
}

function prepareGroupingInput(timelineEntries, presets = [], options = {}) {
  const rawEntries = Array.isArray(timelineEntries) ? timelineEntries : [];
  const boundaryBeforeUuids = options.boundaryBeforeUuids instanceof Set
    ? options.boundaryBeforeUuids
    : new Set(options.boundaryBeforeUuids || []);
  const boundaryAfterUuids = options.boundaryAfterUuids instanceof Set
    ? options.boundaryAfterUuids
    : new Set(options.boundaryAfterUuids || []);
  const candidates = [];
  const hashEntries = [];
  const seenUuids = new Set();
  let compactCount = 0;
  let pendingBoundaryBefore = false;
  let previousEligibleSessionId = null;

  for (const entry of rawEntries) {
    if (isRealCompactEntry(entry)) {
      compactCount += 1;
      continue;
    }
    if (!isEligibleUserEntry(entry)) {
      if (entryType(entry) === 'continued' || entry?.isSubAgent || entry?.isSubAgentTimeout) {
        pendingBoundaryBefore = candidates.length > 0;
      }
      continue;
    }

    const uuid = String(entry.uuid || '').trim();
    if (!uuid) {
      throw new TimelineOutlineError('invalid_input', 'An eligible Timeline prompt has no UUID');
    }
    if (seenUuids.has(uuid)) {
      throw new TimelineOutlineError('duplicate_input_uuid', 'Duplicate Timeline prompt UUID: ' + uuid);
    }
    seenUuids.add(uuid);

    const content = normalizePromptContent(entryContent(entry));
    const presetMatch = findPresetPrefixMatch(content, presets);
    const currentSessionId = entry?.sessionId ? String(entry.sessionId) : null;
    const sessionBoundary = !!(
      previousEligibleSessionId && currentSessionId && previousEligibleSessionId !== currentSessionId
    );
    const boundaryBefore = candidates.length > 0 && (
      pendingBoundaryBefore ||
      sessionBoundary ||
      !!entry.isPlan ||
      boundaryBeforeUuids.has(uuid)
    );
    const common = {
      uuid,
      order: candidates.length,
      timestamp: entry.timestamp || entry.ts || null,
      ...(boundaryBefore ? { boundaryBefore: true } : {}),
    };
    if (presetMatch) {
      const marker = presetMatch.marker;
      candidates.push({ ...common, ...marker });
      hashEntries.push({ uuid, ...marker });
    } else {
      candidates.push({
        ...common,
        kind: 'prompt',
        text: content,
        ...(entry.isPlan ? { hints: { isPlan: true } } : {}),
      });
      hashEntries.push({ uuid, kind: 'prompt', text: content, isPlan: !!entry.isPlan });
    }
    if (boundaryBefore) hashEntries[hashEntries.length - 1].boundaryBefore = true;
    pendingBoundaryBefore = boundaryAfterUuids.has(uuid);
    previousEligibleSessionId = currentSessionId || previousEligibleSessionId;
  }

  const entries = buildBoundedPromptExcerpts(candidates, options);
  const eligibleUuids = entries.map((entry) => entry.uuid);
  const sourceHash = sourceSha256({
    schemaVersion: OUTLINE_SCHEMA_VERSION,
    compactCount,
    entries: hashEntries,
  });

  return {
    schemaVersion: OUTLINE_SCHEMA_VERSION,
    entries,
    eligibleUuids,
    sourceHash,
    compactCount,
    sourceEntryCount: eligibleUuids.length,
    sourceLastUuid: eligibleUuids.at(-1) || null,
  };
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TimelineOutlineError('invalid_outline', path + ' must be an object');
  }
}

function assertOnlyKeys(value, allowedKeys, path) {
  const extras = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (extras.length > 0) {
    throw new TimelineOutlineError(
      'invalid_outline',
      path + ' contains unsupported field' + (extras.length > 1 ? 's' : '') + ': ' + extras.join(', ')
    );
  }
}

function boundedRequiredString(value, path, maxLength) {
  if (typeof value !== 'string') {
    throw new TimelineOutlineError('invalid_outline', path + ' must be a string');
  }
  const normalized = value.trim();
  if (!normalized) throw new TimelineOutlineError('invalid_outline', path + ' must not be empty');
  if (normalized.length > maxLength) {
    throw new TimelineOutlineError('invalid_outline', path + ' exceeds ' + maxLength + ' characters');
  }
  return normalized;
}

function normalizeEligibleUuids(eligibleEntries) {
  const values = Array.isArray(eligibleEntries) ? eligibleEntries : [];
  const uuids = values.map((item) => String(typeof item === 'string' ? item : item?.uuid || '').trim());
  if (uuids.some((uuid) => !uuid)) {
    throw new TimelineOutlineError('invalid_input', 'Every eligible Timeline prompt must have a UUID');
  }
  if (new Set(uuids).size !== uuids.length) {
    throw new TimelineOutlineError('duplicate_input_uuid', 'Eligible Timeline UUIDs must be unique');
  }
  return uuids;
}

function validateOutline(rawOutline, eligibleEntries) {
  const eligibleUuids = normalizeEligibleUuids(eligibleEntries);
  const eligibleIndex = new Map(eligibleUuids.map((uuid, index) => [uuid, index]));
  const boundaryBeforeUuids = new Set(
    (Array.isArray(eligibleEntries) ? eligibleEntries : [])
      .filter((item) => typeof item === 'object' && item?.boundaryBefore)
      .map((item) => String(item.uuid || ''))
      .filter(Boolean)
  );
  assertPlainObject(rawOutline, 'outline');
  assertOnlyKeys(rawOutline, ['groups'], 'outline');
  if (!Array.isArray(rawOutline.groups) || rawOutline.groups.length === 0) {
    throw new TimelineOutlineError('invalid_outline', 'outline.groups must be a non-empty array');
  }

  const seen = new Set();
  const groups = [];
  let expectedSourceIndex = 0;

  rawOutline.groups.forEach((rawGroup, groupIndex) => {
    const groupPath = 'outline.groups[' + groupIndex + ']';
    assertPlainObject(rawGroup, groupPath);
    assertOnlyKeys(rawGroup, ['title', 'description', 'members'], groupPath);
    const title = boundedRequiredString(rawGroup.title, groupPath + '.title', 80);
    const description = boundedRequiredString(rawGroup.description, groupPath + '.description', 360);
    if (!Array.isArray(rawGroup.members) || rawGroup.members.length === 0) {
      throw new TimelineOutlineError('invalid_outline', groupPath + '.members must be a non-empty array');
    }

    const members = rawGroup.members.map((rawMember, memberIndex) => {
      const memberPath = groupPath + '.members[' + memberIndex + ']';
      assertPlainObject(rawMember, memberPath);
      assertOnlyKeys(rawMember, ['uuid', 'description', 'role'], memberPath);
      const uuid = boundedRequiredString(rawMember.uuid, memberPath + '.uuid', 200);
      const memberDescription = boundedRequiredString(
        rawMember.description,
        memberPath + '.description',
        200
      );
      const role = boundedRequiredString(rawMember.role, memberPath + '.role', 32);
      if (!MEMBER_ROLES.includes(role)) {
        throw new TimelineOutlineError(
          'invalid_outline',
          memberPath + '.role must be one of: ' + MEMBER_ROLES.join(', ')
        );
      }
      if (!eligibleIndex.has(uuid)) {
        throw new TimelineOutlineError('unknown_outline_uuid', 'Unknown Timeline prompt UUID: ' + uuid);
      }
      if (seen.has(uuid)) {
        throw new TimelineOutlineError('duplicate_outline_uuid', 'Duplicate Timeline prompt UUID: ' + uuid);
      }
      const sourceIndex = eligibleIndex.get(uuid);
      if (sourceIndex !== expectedSourceIndex) {
        throw new TimelineOutlineError(
          'non_contiguous_outline',
          'Timeline groups must follow the source order without gaps or overlaps; expected ' +
            (eligibleUuids[expectedSourceIndex] || 'end of input') + ' but received ' + uuid
        );
      }
      if (memberIndex > 0 && boundaryBeforeUuids.has(uuid)) {
        throw new TimelineOutlineError(
          'outline_crosses_boundary',
          'Timeline group crosses a structural boundary before UUID: ' + uuid
        );
      }
      seen.add(uuid);
      expectedSourceIndex += 1;
      return { uuid, description: memberDescription, role };
    });

    const startUuid = members[0].uuid;
    const endUuid = members.at(-1).uuid;
    groups.push({
      id: 'timeline-group-' + sourceSha256({ startUuid, endUuid, title }).slice(0, 16),
      title,
      description,
      startUuid,
      endUuid,
      memberUuids: members.map((member) => member.uuid),
      members,
    });
  });

  if (seen.size !== eligibleUuids.length) {
    const missing = eligibleUuids.filter((uuid) => !seen.has(uuid));
    throw new TimelineOutlineError(
      'missing_outline_uuid',
      'Timeline outline is missing prompt UUID' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ')
    );
  }

  return { groups };
}

function buildOutlineResponseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['groups'],
    propertyOrdering: ['groups'],
    properties: {
      groups: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'description', 'members'],
          propertyOrdering: ['title', 'description', 'members'],
          properties: {
            title: { type: 'string', description: 'Short semantic group title, without Markdown.' },
            description: { type: 'string', description: 'What was accomplished or investigated in this group.' },
            members: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['uuid', 'description', 'role'],
                propertyOrdering: ['uuid', 'description', 'role'],
                properties: {
                  uuid: { type: 'string' },
                  description: {
                    type: 'string',
                    description: 'Standalone action label for what the user wants to do, learn, verify, cancel, report, or continue in this turn.',
                  },
                  role: { type: 'string', enum: MEMBER_ROLES },
                },
              },
            },
          },
        },
      },
    },
  };
}

function buildProtocolInstruction() {
  return [
    'Return a semantic outline for the ordered Timeline prompts in the supplied JSON.',
    'The JSON response must match the provided response schema exactly.',
    'Every input prompt reference from the uuid field must occur exactly once. Never invent, omit, or duplicate a reference.',
    'Groups are flat, ordered, contiguous slices of the input. Do not nest groups or reorder prompts.',
    'A one-prompt group is allowed when that prompt does not belong to a neighboring topic.',
    'Use the language of the prompts for titles and descriptions. Do not use Markdown.',
    'A meta_prompt is an intentionally content-free procedural template; classify it from its title only.',
    'Use a compact group title of two to five words. It must name the work phase rather than repeat a member action.',
    'Each member description is the visible Timeline action label. In two to twelve words, state what the user wants to do, learn, check, change, cancel, report, or continue.',
    'Write a concrete standalone action plus its object. Resolve references such as continue, do it, this, and the plan above from neighboring turns.',
    'Preserve distinctive product, project, feature, protocol, file, and technology names from the source whenever they disambiguate the object, such as WebODM, Potree, SSH, Timeline, or History. Never replace a named entity with only a generic category such as frontend, tool, or feature.',
    'Labels such as Continue work, Do it, Check functionality, Продолжить работу, Сделать это, Проверить функционал, or Уточнить вопрос are generic and forbidden. For a short continuation prompt, borrow the concrete unfinished action and object from the immediately preceding turn, for example Продолжить исправление 7 пунктов.',
    'Prefer direct wording such as Проверить конфликт инструментов с WebODM or Что такое мультиселектор. Avoid boilerplate such as запрос на, вопрос про, диалог о, or просьба сделать.',
    'Never return a generic standalone label such as implementation, continuation, execution, testing, clarification, planning, UI fix, Реализация, Продолжение, Выполнение, Тестирование, Уточнение, Планирование, or Исправление UI.',
    'Describe the user intent, not an assumed agent result. Claim completion only when the source turn itself explicitly reports completion.',
    'Do not repeat the member role in the member description. Do not end titles or member descriptions with a period.',
    'Keep group titles under 80 characters, group descriptions under 360 characters, and member descriptions under 200 characters.',
  ].join('\n');
}

function buildAiPromptReferences(entries) {
  const refToUuid = new Map();
  const prompts = (Array.isArray(entries) ? entries : []).map((entry, index) => {
    const ref = 'p' + String(index + 1).padStart(4, '0');
    refToUuid.set(ref, String(entry.uuid));
    return { ...entry, uuid: ref };
  });
  return { prompts, refToUuid };
}

function remapOutlinePromptReferences(rawOutline, refToUuid) {
  if (!rawOutline || typeof rawOutline !== 'object' || !Array.isArray(rawOutline.groups)) {
    return rawOutline;
  }
  return {
    ...rawOutline,
    groups: rawOutline.groups.map((group) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.members)) return group;
      return {
        ...group,
        members: group.members.map((member) => {
          if (!member || typeof member !== 'object' || Array.isArray(member)) return member;
          const ref = String(member.uuid || '');
          const uuid = refToUuid.get(ref);
          if (!uuid) {
            throw new TimelineOutlineError(
              'unknown_outline_ref',
              'Unknown Timeline prompt reference: ' + ref
            );
          }
          return { ...member, uuid };
        }),
      };
    }),
  };
}

function buildCountTokensRequest(model, systemInstruction, requestText) {
  // Gemini Developer API does not accept systemInstruction in countTokens,
  // even though generateContent supports it. Count the exact combined text as
  // ordinary user content so the safety ceiling still includes both parts.
  return {
    model: String(model),
    contents: [{
      role: 'user',
      parts: [{ text: String(systemInstruction) + '\n\n' + String(requestText) }],
    }],
  };
}

function cleanErrorMessage(error) {
  const raw = String(error?.message || error || 'Unknown Timeline grouping error');
  return raw.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]').slice(0, 700);
}

function assertDependencyMethod(object, method, code, label) {
  if (!object || typeof object[method] !== 'function') {
    throw new TimelineOutlineError(code, label + ' is unavailable');
  }
}

function normalizedToolType(value) {
  return value === 'codex' ? 'codex' : value === 'gemini' ? 'gemini' : 'claude';
}

function usageFields(usage = {}) {
  return {
    promptTokens: Number(usage.promptTokenCount || 0),
    candidateTokens: Number(usage.candidatesTokenCount || 0),
    thoughtTokens: Number(usage.thoughtsTokenCount || 0),
    totalTokens: Number(usage.totalTokenCount || 0),
  };
}

async function logPromptCall(projectManager, payload, status, usage, sourceChars, outputChars, error) {
  if (typeof projectManager?.logAIPromptCall !== 'function') return;
  try {
    await Promise.resolve(projectManager.logAIPromptCall({
      promptId: TIMELINE_GROUPING_PROMPT_ID,
      taskType: 'timeline-grouping',
      model: payload.model || null,
      thinkingLevel: payload.thinkingLevel || null,
      ...usageFields(usage),
      status,
      error: error ? cleanErrorMessage(error) : null,
      sourceChars,
      outputChars,
      projectId: payload.projectId || null,
      projectName: payload.projectName || null,
      projectPath: payload.projectPath || payload.cwd || null,
      tabId: payload.tabId || null,
      tabName: payload.tabName || null,
      toolType: payload.toolType || null,
      sessionId: payload.sessionId || null,
    }));
  } catch (logError) {
    console.warn('[TimelineOutline] Failed to log AI usage:', cleanErrorMessage(logError));
  }
}

async function generateTimelineOutline(payload, { projectManager, transcriptService }) {
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) throw new TimelineOutlineError('session_required', 'sessionId is required');
  const toolType = normalizedToolType(payload?.toolType);
  if (toolType === 'gemini') {
    throw new TimelineOutlineError('unsupported_tool', 'Timeline grouping is not available for Gemini sessions');
  }
  assertDependencyMethod(transcriptService, 'getTimeline', 'transcript_unavailable', 'Canonical Timeline reader');
  assertDependencyMethod(projectManager, 'getAIPromptById', 'config_unavailable', 'Timeline grouping AI prompt');
  assertDependencyMethod(projectManager, 'getPrompts', 'prompts_unavailable', 'Saved prompt list');
  assertDependencyMethod(projectManager, 'saveTimelineOutline', 'storage_unavailable', 'Timeline outline storage');

  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new TimelineOutlineError('api_key_missing', 'GEMINI_API_KEY is not configured');

  const [timelineResult, promptConfig, presets, barriers] = await Promise.all([
    transcriptService.getTimeline({ toolType, sessionId, cwd: payload?.cwd }),
    Promise.resolve(projectManager.getAIPromptById(TIMELINE_GROUPING_PROMPT_ID)),
    Promise.resolve(projectManager.getPrompts()),
    typeof projectManager.getTimelineGroupingBarriers === 'function'
      ? Promise.resolve(projectManager.getTimelineGroupingBarriers(sessionId))
      : Promise.resolve(null),
  ]);
  if (!timelineResult?.success) {
    throw new TimelineOutlineError(
      'timeline_read_failed',
      timelineResult?.error || 'Failed to read the canonical Timeline'
    );
  }
  if (!promptConfig || typeof promptConfig.content !== 'string' || !promptConfig.content.trim()) {
    throw new TimelineOutlineError(
      'config_unavailable',
      'The Timeline Grouping AI prompt is missing or empty'
    );
  }
  if (!promptConfig.model) {
    throw new TimelineOutlineError('config_unavailable', 'The Timeline Grouping model is not configured');
  }

  const boundaryBeforeUuids = new Set();
  const boundaryAfterUuids = new Set();
  for (const note of barriers?.notes || []) {
    const uuid = String(note?.entry_uuid || '');
    if (!uuid) continue;
    if (note.position === 'after') boundaryAfterUuids.add(uuid);
    else boundaryBeforeUuids.add(uuid);
  }
  for (const marker of barriers?.rewindMarkers || []) {
    if (marker?.entry_uuid) boundaryBeforeUuids.add(String(marker.entry_uuid));
  }
  for (const marker of barriers?.forkMarkers || []) {
    const uuids = Array.isArray(marker?.entry_uuids) ? marker.entry_uuids : [];
    if (uuids.length > 0) boundaryAfterUuids.add(String(uuids[uuids.length - 1]));
  }

  const prepared = prepareGroupingInput(timelineResult.entries, presets, {
    totalCharBudget: payload?.totalCharBudget ?? DEFAULT_TOTAL_EXCERPT_CHARS,
    maxPerEntry: payload?.maxPerEntry ?? DEFAULT_MAX_EXCERPT_CHARS,
    boundaryBeforeUuids,
    boundaryAfterUuids,
  });
  if (prepared.sourceEntryCount === 0) {
    throw new TimelineOutlineError('no_eligible_prompts', 'This Timeline has no user prompts to group');
  }

  const model = String(promptConfig.model);
  const thinkingLevel = String(promptConfig.thinkingLevel || 'NONE').toUpperCase();
  const systemInstruction = promptConfig.content.trim() + '\n\n' + buildProtocolInstruction();
  const aiPromptReferences = buildAiPromptReferences(prepared.entries);
  const requestDocument = {
    schemaVersion: OUTLINE_SCHEMA_VERSION,
    session: { toolType, sessionId },
    compactCount: prepared.compactCount,
    prompts: aiPromptReferences.prompts,
  };
  const requestText = JSON.stringify(requestDocument);
  const aiPayload = { ...payload, toolType, sessionId, model, thinkingLevel };
  let response;
  let responseText = '';
  let apiInvoked = false;

  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const contents = [{ role: 'user', parts: [{ text: requestText }] }];
    const count = await ai.models.countTokens(
      buildCountTokensRequest(model, systemInstruction, requestText)
    );
    const countedInputTokens = Number(count?.totalTokens || 0);
    if (countedInputTokens > MAX_INPUT_TOKENS) {
      throw new TimelineOutlineError(
        'input_too_large',
        'Timeline grouping input is ' + countedInputTokens + ' tokens; the safe limit is ' + MAX_INPUT_TOKENS
      );
    }

    const config = {
      systemInstruction,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseJsonSchema: buildOutlineResponseSchema(prepared.sourceEntryCount),
    };
    if (model.includes('gemini-3') && thinkingLevel !== 'NONE') {
      config.thinkingConfig = { thinkingLevel };
    }
    apiInvoked = true;
    response = await ai.models.generateContent({ model, contents, config });
    responseText = String(response?.text || '').trim();
    if (!responseText) {
      throw new TimelineOutlineError('empty_response', 'Timeline grouping returned an empty response');
    }
    let rawOutline;
    try {
      rawOutline = JSON.parse(responseText);
    } catch {
      throw new TimelineOutlineError('invalid_json', 'Timeline grouping returned invalid JSON');
    }
    const remappedOutline = remapOutlinePromptReferences(rawOutline, aiPromptReferences.refToUuid);
    const validated = validateOutline(remappedOutline, prepared.entries);
    const usage = response?.usageMetadata || {};
    const multiTurnGroups = validated.groups.filter((group) => group.memberUuids.length >= 2);
    const turns = validated.groups.flatMap((group) => group.members);
    const ungrouped = validated.groups
      .filter((group) => group.memberUuids.length === 1)
      .map((group) => group.memberUuids[0]);
    const metaPrompts = prepared.entries
      .filter((entry) => entry.kind === 'meta_prompt')
      .map(({ uuid, presetId, title }) => ({ uuid, presetId, title }));
    const usageFieldsValue = usageFields(usage);
    const record = {
      schemaVersion: OUTLINE_SCHEMA_VERSION,
      toolType,
      sessionId,
      sourceHash: prepared.sourceHash,
      sourceUuids: prepared.eligibleUuids,
      sourceEntryCount: prepared.sourceEntryCount,
      sourceLastUuid: prepared.sourceLastUuid,
      outline: {
        schemaVersion: OUTLINE_SCHEMA_VERSION,
        compactCount: prepared.compactCount,
        metaPrompts,
        groups: multiTurnGroups,
        turns,
        ungrouped,
      },
      model,
      promptId: TIMELINE_GROUPING_PROMPT_ID,
      thinkingLevel,
      countedInputTokens,
      ...usageFieldsValue,
      sourceChars: requestText.length + systemInstruction.length,
      generatedAt: Date.now(),
    };

    const saved = await Promise.resolve(projectManager.saveTimelineOutline(record));
    if (saved === false) {
      throw new TimelineOutlineError('storage_failed', 'Timeline outline storage rejected the generated outline');
    }
    await logPromptCall(
      projectManager,
      aiPayload,
      'success',
      usage,
      requestText.length + systemInstruction.length,
      responseText.length,
      null
    );
    return { success: true, data: record };
  } catch (error) {
    if (apiInvoked) {
      await logPromptCall(
        projectManager,
        aiPayload,
        'error',
        response?.usageMetadata || {},
        requestText.length + systemInstruction.length,
        responseText.length,
        error
      );
    }
    throw error;
  }
}

function errorResult(error) {
  return {
    success: false,
    code: error?.code || 'timeline_outline_failed',
    error: cleanErrorMessage(error),
  };
}

function register({ projectManager, transcriptService }) {
  const { ipcMain } = require('electron');
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TimelineOutlineError('ipc_unavailable', 'Electron IPC is unavailable');
  }

  if (!registeredChannels.has('timeline-outline:get')) {
    ipcMain.handle('timeline-outline:get', async (_event, payload = {}) => {
      try {
        const toolType = normalizedToolType(payload.toolType);
        const sessionId = String(payload.sessionId || '').trim();
        if (!sessionId) throw new TimelineOutlineError('session_required', 'sessionId is required');
        assertDependencyMethod(
          projectManager,
          'getTimelineOutline',
          'storage_unavailable',
          'Timeline outline storage'
        );
        const data = await Promise.resolve(projectManager.getTimelineOutline(toolType, sessionId));
        return { success: true, data: data || null };
      } catch (error) {
        return errorResult(error);
      }
    });
    registeredChannels.add('timeline-outline:get');
  }

  if (!registeredChannels.has('timeline-outline:generate')) {
    ipcMain.handle('timeline-outline:generate', async (_event, payload = {}) => {
      const key = JSON.stringify({
        toolType: normalizedToolType(payload.toolType),
        sessionId: payload.sessionId || '',
        cwd: payload.cwd || '',
      });
      if (generationInflight.has(key)) return generationInflight.get(key);

      const promise = generateTimelineOutline(payload, { projectManager, transcriptService })
        .catch(errorResult)
        .finally(() => generationInflight.delete(key));
      generationInflight.set(key, promise);
      return promise;
    });
    registeredChannels.add('timeline-outline:generate');
  }

  return {
    channels: ['timeline-outline:get', 'timeline-outline:generate'],
  };
}

module.exports = {
  TIMELINE_GROUPING_PROMPT_ID,
  OUTLINE_SCHEMA_VERSION,
  DEFAULT_TOTAL_EXCERPT_CHARS,
  DEFAULT_MAX_EXCERPT_CHARS,
  MAX_INPUT_TOKENS,
  MEMBER_ROLES,
  TimelineOutlineError,
  normalizePrefixText,
  createMetaPromptMarker,
  findPresetPrefixMatch,
  headTailExcerpt,
  buildBoundedPromptExcerpts,
  sourceSha256,
  prepareGroupingInput,
  validateOutline,
  buildOutlineResponseSchema,
  buildProtocolInstruction,
  buildAiPromptReferences,
  remapOutlinePromptReferences,
  buildCountTokensRequest,
  generateTimelineOutline,
  register,
};
