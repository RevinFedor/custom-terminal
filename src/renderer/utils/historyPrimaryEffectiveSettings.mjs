import { createDocumentUtf16Digest } from './documentUtf16Digest.mjs';
import { deriveCodexEffectiveSettingsFromHistory } from './codexEffectiveSettings.mjs';

const fail = code => Object.assign(new Error(code), { code });
const current = (reader, signal, owns) => {
  if (signal?.aborted || !owns()) throw fail('HISTORY_READ_CANCELLED');
  reader.assertOpen();
};

// One selected slash field is an explicit native-string consumer. This does
// not decode historical rows, but it does not bound one enormous model name.
// The source document stays independent of the parent and the next field.
async function readSlashField(reader, descriptor, { signal, owns }) {
  current(reader, signal, owns);
  const document = await reader.forkText(descriptor, { signal });
  let primary;
  try {
    current(reader, signal, owns);
    const digest = await createDocumentUtf16Digest();
    current(reader, signal, owns);
    let offset = 0, value = '';
    while (offset < document.length) {
      const part = await document.read(offset, Math.min(1024, document.length - offset), { signal });
      current(reader, signal, owns);
      if (!part.text.length || part.nextOffset !== offset + part.text.length
        || part.nextOffset > document.length) throw fail('HISTORY_PRIMARY_SETTINGS_TEXT_PROGRESS');
      digest.update(part.text);
      value += part.text;
      offset = part.nextOffset;
    }
    if (digest.digest() !== document.digest) throw fail('HISTORY_PRIMARY_DOCUMENT_DIGEST');
    return value;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await document.close();
      if (!primary) current(reader, signal, owns);
    } catch (error) {
      if (!primary) throw error;
      console.warn('[HistoryPrimary] settings-document-release-failed code=' + String(error?.code || 'UNKNOWN'));
    }
  }
}

// Called for a provisional immutable root before adoption. A pure-view hit
// reuses this value with its existing exact metadata identity, without RPC.
export async function readHistoryPrimaryEffectiveSettings(reader, header, {
  signal, owns = () => true, invoke,
} = {}) {
  current(reader, signal, owns);
  const selected = await reader.primaryEffectiveSettings(header.durableMetadata, { header, invoke });
  current(reader, signal, owns);
  const fields = [];
  for (const key of ['model', 'effort']) {
    if (selected[key] === null) continue;
    const content = await readSlashField(reader, selected[key], { signal, owns });
    current(reader, signal, owns);
    const row = { role: 'slash', content };
    const parsed = deriveCodexEffectiveSettingsFromHistory([row]);
    const other = key === 'model' ? 'effort' : 'model';
    if (!parsed?.[key] || parsed[other] !== undefined) throw fail('HISTORY_PRIMARY_SETTINGS_FIELD_PROOF');
    fields.push(row);
  }
  current(reader, signal, owns);
  const effective = deriveCodexEffectiveSettingsFromHistory(fields);
  if (!effective) {
    if (selected.proof !== null || selected.proofAt !== 0) throw fail('HISTORY_PRIMARY_SETTINGS_FIELD_PROOF');
    return null;
  }
  if (selected.proof !== 'rollout-turn-context' || !Number.isSafeInteger(selected.proofAt)
    || selected.proofAt < 0) throw fail('HISTORY_PRIMARY_SETTINGS_FIELD_PROOF');
  return Object.freeze({ ...effective, proofAt: selected.proofAt });
}
