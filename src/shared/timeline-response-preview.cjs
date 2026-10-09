// Display metadata only. A caller must prove the final record; this helper
// never chooses one from a completion clock or invents a source identity.
const TIMELINE_RESPONSE_PREVIEW_LIMIT = 2048;
const { createHash } = require('node:crypto');

function timelineResponsePreview(entry) {
  if (!entry || typeof entry.uuid !== 'string' || !entry.uuid
    || typeof entry.content !== 'string' || !entry.content.trim()) return undefined;
  let content = entry.content.slice(0, TIMELINE_RESPONSE_PREVIEW_LIMIT);
  if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
  const timestamp = typeof entry.timestamp === 'string'
    && /(?:Z|[+-]\d{2}:\d{2})$/i.test(entry.timestamp)
    && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : undefined;
  return {
    version: 1,
    uuid: entry.uuid,
    ...(entry.sourceIdentity ? { sourceIdentity: entry.sourceIdentity } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(timestamp ? { timestamp } : {}),
    content,
    contentLength: entry.content.length,
    contentHash: createHash('sha256').update(entry.content, 'utf8').digest('hex'),
    truncated: content.length < entry.content.length,
  };
}

module.exports = { TIMELINE_RESPONSE_PREVIEW_LIMIT, timelineResponsePreview };
