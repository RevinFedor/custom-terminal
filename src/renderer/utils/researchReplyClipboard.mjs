import { buildHistoryMessageComposerSnapshot } from './composerClipboard.mjs';

/** Called ONLY after the existing full service-body proof selected the SC
 * completion. Real deferred context before the envelope keeps its attachments;
 * the generated envelope+answer is opaque text, even when JSON values quote
 * reserved prompt/paste/image markers. Never normalize the raw clipboard text. */
export function buildResearchReplyClipboardPayload(entry, service) {
  const text = entry.content;
  const prefix = text.slice(0, service.envelopeStart);
  const snapshot = buildHistoryMessageComposerSnapshot({ text: prefix,
    chips: entry.promptChips, imagePaths: entry.imagePaths });
  return { text, snapshot: { ...snapshot, text: snapshot.text + text.slice(service.envelopeStart) } };
}
