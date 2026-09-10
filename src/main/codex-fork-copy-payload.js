'use strict';

// The same ResponseItem wire type occurs at the top level and in both compact
// checkpoints. Normalize known serializer defaults by TYPE, not arbitrary
// recursive key names: text, images, opaque capsules and unknown fields remain
// exact. rust-v0.153.0: protocol/src/models.rs (ResponseItem::Reasoning),
// history/src/{rollout_payload,guardian_history}.rs.
function responseItemPayload(item) {
  return item?.type === 'reasoning' && item.content == null
    ? { ...item, content: null }
    : item;
}

function codexForkCopyPayload(record) {
  const payload = record?.payload;
  if (record?.type === 'response_item') return responseItemPayload(payload);
  if (record?.type !== 'compacted' || !payload) return payload;
  const normalized = {
    ...payload,
    compaction_response_id: payload.compaction_response_id ?? null,
    latest_token_usage_record: payload.latest_token_usage_record ?? null,
  };
  for (const key of ['replacement_history', 'guardian_history']) {
    if (Array.isArray(payload[key])) normalized[key] = payload[key].map(responseItemPayload);
  }
  return normalized;
}

module.exports = { codexForkCopyPayload };
