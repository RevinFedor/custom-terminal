import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchReplyClipboardPayload } from './researchReplyClipboard.mjs';
import { buildHistoryMessageClipboardPayload, normalizeHistoryMessageComposerSnapshot } from './composerClipboard.mjs';
import { serializeComposerDraft } from './composerChips.mjs';

test('SC Copy keeps JSON marker-like values in both raw text and the snapshot, without fake attachments',()=>{
  const content='[saved generated header]\n<CodeBlock language="json" editable={false}>\n'
    +JSON.stringify({paste:'<pasted_content>literal</pasted_content>',prompt:'<saved_prompt name="quoted">literal</saved_prompt>',image:'[Image #1]'})+'\n</CodeBlock>';
  const entry={content},service={envelopeStart:0};
  const copied=buildResearchReplyClipboardPayload(entry,service);
  assert.equal(copied.text,content);assert.equal(copied.snapshot.text,content);
  assert.equal(copied.snapshot.chips.length,0);assert.equal(copied.snapshot.imagePaths.length,0);
  assert.equal(normalizeHistoryMessageComposerSnapshot(copied.snapshot).text,content);
});
test('real leading saved context keeps its metadata, while the answer suffix stays opaque',()=>{
  const chip={id:'actual-context',kind:'prompt',label:'Working context',text:'real context',contextUpdateId:'update-1'};
  const prefix=serializeComposerDraft({text:'',chips:[chip]})+'\n';
  const suffix='[generated header]\n{"value":"<pasted_content>literal</pasted_content>"}';
  const copied=buildResearchReplyClipboardPayload({content:prefix+suffix,promptChips:[chip]}, {envelopeStart:prefix.length});
  assert.equal(copied.text,prefix+suffix);assert.ok(copied.snapshot.text.endsWith(suffix));
  assert.equal(copied.snapshot.chips.length,1);assert.equal(copied.snapshot.chips[0].contextUpdateId,'update-1');
});
test('the ordinary prompt Copy builder still interprets actual pasted content',()=>{
  const ordinary=buildHistoryMessageClipboardPayload({text:'<pasted_content>real paste</pasted_content>'});
  assert.equal(ordinary.snapshot.chips.length,1);assert.equal(ordinary.snapshot.chips[0].kind,'paste');
});
