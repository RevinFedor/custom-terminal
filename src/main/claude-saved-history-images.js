'use strict';

// Reuse the existing managed asset writer. Only payloads of the EXACT selected
// durable user record may be materialized before destructive saved Rewind.
async function materializeClaudeSavedHistoryImages(record, existingRefs, assets) {
  const blocks = Array.isArray(record?.message?.content) ? record.message.content : [];
  const images = blocks.filter(block => block?.type === 'image');
  if (!images.length) return Array.isArray(existingRefs) ? existingRefs : [];
  const refs = [];
  for (const [index, image] of images.entries()) {
    const source = image.source;
    if (source?.type !== 'base64' || typeof source.data !== 'string'
      || !/^image\/(png|jpeg|gif|webp)$/i.test(source.media_type || '')
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data) || source.data.length > 32 * 1024 * 1024) {
      throw new Error('claude_history_image_payload_unavailable');
    }
    const bytes = Buffer.from(source.data, 'base64');
    if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== source.data.replace(/=+$/, '')) {
      throw new Error('claude_history_image_payload_invalid');
    }
    const ref = await assets.materializeBuffer(bytes, { id: index + 1, mediaType: source.media_type, size: bytes.length });
    if (ref?.availability !== 'available') throw new Error('claude_history_image_materialization_failed');
    refs.push(ref);
  }
  return refs;
}
module.exports = { materializeClaudeSavedHistoryImages };
