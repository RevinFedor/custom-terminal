import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { timelinePromptPreview } from './timelineEntryPreview.mjs';
import { researchResultPresentation } from './researchResultPresentation.mjs';
import { projectTimelineLiveUserMessage, projectTimelineSentHandoff } from './timelineTranscriptRefresh.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
export function researchEntry(body, overrides = {}) {
  const envelope = '[exact saved completion]\n';
  const content = envelope + body;
  return { uuid: 'research-user', role: 'user', type: 'user', content,
    semanticTags: [{ kind: 'orchestration', runId: 'exact-run', runKind: 'external-research',
      phase: 'completion', envelopeStart: 0, envelopeText: envelope, bodyStart: envelope.length,
      bodyEnd: content.length, bodyProjectionHash: hash(content) }], ...overrides };
}

test('saved SC JSON has a compact shared preview, not a literal JSX/ID prefix', () => {
  const entry = researchEntry('<CodeBlock language="json" editable={false}>{\n  "items": []\n}</CodeBlock>');
  const original = JSON.stringify(entry);
  const preview = timelinePromptPreview(entry, hash);
  assert.equal(preview.text, '{ "items": [] }');
  assert.equal(preview.research?.language, 'json');
  assert.match(preview.research?.displayText, /^```json\n/);
  assert.equal(JSON.stringify(entry), original, 'raw Copy/hash/identity stay untouched');
});

test('plain JSON, fenced JSON, JSONL and ordinary Markdown keep their real values', () => {
  for (const text of ['{\n "id": "keep",\n "reason": "не удалять"\n}', '```json\n{"items":[]}\n```',
    '<CodeBlock language="json" editable={false}>{"items":[]}</CodeBlock>']) {
    const view = researchResultPresentation(text);
    assert.equal(view.language, 'json'); assert.ok(view.summary.startsWith('JSON ·'));
    assert.ok(view.needsDisclosure); assert.match(view.displayText, /items|не удалять/);
  }
  const jsonl = researchResultPresentation('{"id":1}\n{"id":2}\n');
  assert.equal(jsonl.language, 'jsonl'); assert.equal(jsonl.summary, 'JSONL · 2 строки');
  const short = researchResultPresentation('**Короткий ответ**.');
  assert.equal(short.needsDisclosure, false); assert.equal(short.displayText, '**Короткий ответ**.');
  const mixed = '## Итог\n\nРезультат.\n\n```json\n{"id":1}\n```\n\n```python\nprint(1)\n```';
  const view = researchResultPresentation(mixed);
  assert.equal(view.displayText, mixed); assert.equal(view.needsDisclosure, true);
  assert.equal(view.previewText, '## Итог\n\nРезультат.');
});

test('quoted, incomplete and executable-looking wrappers are never evaluated or stripped', () => {
  for (const text of ['Example: <CodeBlock language="json" editable={false}>{}</CodeBlock>',
    '<CodeBlock language="json" editable={true}>{}</CodeBlock>',
    '<CodeBlock language="json" editable={false}>{}',
    '<CodeBlock language="json" editable={false} onClick={run()}>{}</CodeBlock>',
    '<script>window.BAD=true</script>',
    '<CodeBlock language="json" editable={false}>{}</CodeBlock><CodeBlock language="json" editable={false}>{}</CodeBlock>']) {
    const view = researchResultPresentation(text);
    assert.equal(view.language, null); assert.equal(view.displayText, text);
  }
});

test('whole escape-wrapped JSON is readable code; quoted, incomplete and non-JSON escape text stays literal', () => {
  const code = '{\n  "items": [{"reason":"Keep <escape> in values"}]\n}';
  const view = researchResultPresentation('<escape>' + code + '</escape>');
  assert.equal(view.summary, 'JSON · 3 строки');
  assert.equal(view.displayText, '```json\n' + code + '\n```');
  for (const text of ['Example: <escape>{}</escape>', '<escape>{}', '<escape>ordinary text</escape>',
    '<escape onclick="run()">{}</escape>', '<escape>{broken}</escape>']) {
    assert.equal(researchResultPresentation(text).displayText, text);
    assert.equal(researchResultPresentation(text).summary, null);
  }
});

test('unknown/provenance gaps stay literal, with question replies and MCP untouched', () => {
  const wire = '<CodeBlock language="json" editable={false}>{"id":1}</CodeBlock>';
  const signed = researchEntry(wire);
  for (const entry of [{ type: 'user', role: 'user', content: wire },
    { ...signed, content: signed.content + 'stale' },
    researchEntry(wire, { semanticTags: [{ ...signed.semanticTags[0], runKind: 'agent' }] }),
    researchEntry(wire, { semanticTags: [{ ...signed.semanticTags[0], phase: 'request' }] })]) {
    assert.equal(timelinePromptPreview(entry, hash).research, null);
  }
});

test('JSON excerpts use a literal textual field, never turn a model verdict into operation failure', () => {
  const raw = JSON.stringify({ items: [{ id: 'not the headline', verdict: 'reject', reason: 'These meanings overlap.' }] });
  const entry = researchEntry(raw);
  const view = timelinePromptPreview(entry, hash).research;
  assert.equal(view.previewText, 'These meanings overlap.');
  assert.equal(view.code, raw);
  assert.equal(view.failed, false);
  const failed = { ...entry, semanticTags: [{ ...entry.semanticTags[0], phase: 'failure' }] };
  assert.equal(timelinePromptPreview(failed, hash).research.failed, true);
  assert.equal(researchResultPresentation('{"reason":"first"}\n{"reason":"second"}').previewText, 'first');
  assert.equal(researchResultPresentation('```json\n{"summary":"Existing summary"}\n```').previewText, 'Existing summary');
  assert.match(researchResultPresentation('{"opaque":[1,2]}').previewText, /opaque/);
});

test('reserved-looking JSON strings remain literal code, while leading context chips survive', () => {
  const body = JSON.stringify({ literal: '<saved_prompt name="not a chip">text</saved_prompt>',
    paste: '<pasted_content>not a paste</pasted_content>' });
  const entry = researchEntry(body);
  const view = timelinePromptPreview(entry, hash);
  assert.equal(view.parts.length, 1); assert.equal(view.parts[0].kind, 'text');
  assert.ok(view.research.displayText.includes('not a chip'));
  const prefix = '<saved_prompt name="real context">update</saved_prompt>\n';
  const content = prefix + entry.content;
  const withContext = { ...entry, content, semanticTags: [{ ...entry.semanticTags[0],
    envelopeStart: prefix.length, bodyStart: prefix.length + entry.semanticTags[0].bodyStart,
    bodyEnd: content.length, bodyProjectionHash: hash(content) }] };
  const contextual = timelinePromptPreview(withContext, hash);
  assert.ok(contextual.parts.some(part => part.kind === 'prompt'));
  assert.equal(contextual.research.displayText, view.research.displayText);
});

test('language/count display is bounded and a fence inside code cannot escape the code block', () => {
  const view = researchResultPresentation('<CodeBlock language="text" editable={false}>```\nliteral\n```</CodeBlock>');
  assert.match(view.displayText, /^````text\n/);
  const huge = researchResultPresentation('{' + ' '.repeat(250001) + '}');
  assert.equal(huge.language, null); assert.ok(huge.previewText.length <= 801);
});
test('live + SENT Timeline keep only a proved SC full wire before the ordinary 2048 budget', () => {
  const entry = researchEntry('<CodeBlock language="json" editable={false}>'+JSON.stringify({reason:'word '.repeat(1000)})+'</CodeBlock>');
  const owner = { toolType: 'codex', sessionId: 'sid', fingerprint: hash };
  const message = { ...entry, type: 'user', message: { role: 'user', content: [{ type: 'text', text: entry.content }] } };
  const detail = {toolType:'codex',sessionId:'sid',timestamp:'2026-10-10T08:58:57.927Z',message};
  const live = projectTimelineLiveUserMessage(detail, owner);
  assert.equal(live.content,entry.content); assert.deepEqual(live.semanticTags, entry.semanticTags);
  assert.ok(timelinePromptPreview(live,hash).research);
  const sent = projectTimelineSentHandoff({toolType:'codex',queueStatus:'sent',text:entry.content,
    semanticTags:entry.semanticTags,auditProof:{sessionId:'sid',entryUuid:entry.uuid}},owner);
  assert.equal(sent.content,entry.content); assert.ok(timelinePromptPreview(sent,hash).research);
  const stale = projectTimelineLiveUserMessage({...detail,message:{...message,message:{content:[{type:'text',text:entry.content+'changed'}]}}},owner);
  assert.ok(stale.content.length<=2050); assert.equal(stale.semanticTags,undefined);
  const literal = projectTimelineLiveUserMessage({...detail,message:{...message,semanticTags:[]}},owner);
  assert.ok(literal.content.length<=2050);
});
