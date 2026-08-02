export const COMPOSER_DRAFT_STATE_LIMIT = 100;
export const COMPOSER_DRAFT_STATE_CHAR_BUDGET = 3_000_000;

function normalizeImageRef(value) {
  if (!value || typeof value !== 'object') return null;
  const id = Number(value.id);
  const path = typeof value.path === 'string' ? value.path.trim() : '';
  if (!Number.isFinite(id) || id < 1 || !path) return null;
  const result = { id: Math.floor(id), path };
  if (typeof value.assetId === 'string' && value.assetId) result.assetId = value.assetId;
  if (typeof value.mediaType === 'string' || value.mediaType === null) result.mediaType = value.mediaType;
  if (Number.isFinite(Number(value.size)) && Number(value.size) >= 0) result.size = Number(value.size);
  if (value.availability === 'available' || value.availability === 'missing') {
    result.availability = value.availability;
  }
  if (typeof value.error === 'string' && value.error) result.error = value.error;
  return result;
}

function normalizeChip(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const kind = value.kind === 'prompt' || value.kind === 'paste' ? value.kind : null;
  if (!id || !kind || typeof value.text !== 'string') return null;
  const result = { id, kind, text: value.text };
  if (typeof value.label === 'string') result.label = value.label;
  if (typeof value.sourceKey === 'string' && value.sourceKey) result.sourceKey = value.sourceKey;
  if (Number.isFinite(Number(value.createdAt)) && Number(value.createdAt) > 0) {
    result.createdAt = Number(value.createdAt);
  }
  return result;
}

function recordWeight(record) {
  return record.text.length
    + record.images.reduce((total, ref) => total + ref.path.length + 128, 0)
    + record.chips.reduce((total, chip) => total + chip.text.length + 128, 0);
}

export function readComposerDraftMemory(value) {
  if (!value || typeof value !== 'object') return {};
  const candidates = [];
  for (const [tabId, raw] of Object.entries(value)) {
    if (!tabId || !raw || typeof raw !== 'object') continue;
    const text = typeof raw.text === 'string' ? raw.text : '';
    const images = Array.isArray(raw.images) ? raw.images.map(normalizeImageRef).filter(Boolean) : [];
    const chips = Array.isArray(raw.chips) ? raw.chips.map(normalizeChip).filter(Boolean) : [];
    if (!text && images.length === 0 && chips.length === 0) continue;
    const updatedAt = Number(raw.updatedAt);
    candidates.push([tabId, {
      text,
      images,
      chips,
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    }]);
  }

  candidates.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
  const retained = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (retained.length >= COMPOSER_DRAFT_STATE_LIMIT) break;
    const weight = recordWeight(candidate[1]);
    // The newest draft is never truncated or dropped. Later records observe a
    // bounded cache budget so one old workspace cannot exhaust localStorage.
    if (retained.length > 0 && chars + weight > COMPOSER_DRAFT_STATE_CHAR_BUDGET) continue;
    retained.push(candidate);
    chars += weight;
  }
  return Object.fromEntries(retained.reverse());
}

export function buildComposerDraftMemory({ drafts, images, chips, updatedAtByTab }) {
  const tabIds = new Set([
    ...Object.keys(drafts || {}),
    ...Object.keys(images || {}),
    ...Object.keys(chips || {}),
  ]);
  const memory = {};
  for (const tabId of tabIds) {
    memory[tabId] = {
      text: typeof drafts?.[tabId] === 'string' ? drafts[tabId] : '',
      images: Array.isArray(images?.[tabId]) ? images[tabId] : [],
      chips: Array.isArray(chips?.[tabId]) ? chips[tabId] : [],
      updatedAt: Number(updatedAtByTab?.[tabId]) || 0,
    };
  }
  return readComposerDraftMemory(memory);
}

export function splitComposerDraftMemory(value) {
  const memory = readComposerDraftMemory(value);
  const drafts = {};
  const images = {};
  const chips = {};
  const updatedAtByTab = {};
  for (const [tabId, record] of Object.entries(memory)) {
    if (record.text) drafts[tabId] = record.text;
    if (record.images.length > 0) images[tabId] = record.images;
    if (record.chips.length > 0) chips[tabId] = record.chips;
    updatedAtByTab[tabId] = record.updatedAt;
  }
  return { drafts, images, chips, updatedAtByTab };
}
