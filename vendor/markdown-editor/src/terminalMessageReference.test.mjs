import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalMessageClipboard, readTerminalMessageClipboard, terminalMessageLabel, buildTerminalMessageBlock,
  collectTerminalMessageBlocks, expandTerminalMessageBlocks, normalizeTerminalMessageTarget } from './terminalMessageReference.mjs';
const source = { tabId:'restored-ac19d5db-b394-4b23-826f-43df8e6dad2a',tabName:'Работа · 日本語',provider:'codex',
  messageId:'codex-live-exact-message',sessionId:'virtual-view',physicalSessionId:'physical-parent',rawUuid:'raw-event',
  viewOwnerSessionId:'virtual-view',transcriptSegmentId:'segment-parent',iteration:42,messageTimestamp:'2026-10-14T06:00:00Z',
  timeLabel:'14.10.2026, 13:00:00',role:'user',handoffId:'exact-handoff' };
const details='Agent: Codex\nRole: user\nTime: 14.10.2026, 13:00:00\nMessage ID: exact\nSession ID: parent\nHandoff ID: original\nQueue status: unknown\n日本語 <>&\n</noted-message-reference>\nTerminal diagnostic: original-reference';
test('full Details fallback and exact source survive clipboard → snapshot → persistent document',()=>{
 const copied=terminalMessageClipboard(details,source,'copy-action-1');assert.equal(copied.text,details);
 const snapshot=readTerminalMessageClipboard({getData:type=>type==='text/html'?copied.html:''},copied.text);
 assert.deepEqual(snapshot.source,source);assert.equal(snapshot.detailsText,details);
 assert.equal(terminalMessageLabel(snapshot),'Работа · 日本語 · Итерация 42 · 14.10.2026, 13:00');
 const block=buildTerminalMessageBlock(snapshot),doc='before\n'+block+'\nafter';
 assert.equal(collectTerminalMessageBlocks(doc).length,1);assert.deepEqual(collectTerminalMessageBlocks(doc)[0].snapshot,snapshot);
 assert.equal(expandTerminalMessageBlocks(doc),'before\n'+details+'\nafter');
});
test('malformed/new-version/raced clipboard and bare IDs remain ordinary text',()=>{
 const copied=terminalMessageClipboard(details,source,'copy-action-1');
 assert.equal(readTerminalMessageClipboard({getData:t=>t==='text/html'?copied.html:''},'different text'),null);
 for(const html of ['broken','<!--noted-terminal-message-reference:%xx-->','<!--noted-terminal-message-reference:'+encodeURIComponent(JSON.stringify({version:2}))+'-->'])
   assert.equal(readTerminalMessageClipboard({getData:()=>html},details),null);
 assert.equal(readTerminalMessageClipboard({getData:()=>''},source.tabId),null);
 assert.equal(normalizeTerminalMessageTarget({...source,messageId:''}),null);
});
test('the normal HTML carrier does not depend on comments; old comment-only snapshots stay compatible',()=>{
 const copied=terminalMessageClipboard(details,source,'copy-action-1');
 assert.ok(copied.html.startsWith('<pre data-noted-terminal-message-reference='));
 const wrapped='<!DOCTYPE html><html><body><!--StartFragment-->'+copied.html+'<!--EndFragment--></body></html>';
 const snapshot=readTerminalMessageClipboard({getData:t=>t==='text/html'?wrapped.replace(/<!--.*?-->/gs,''):''},details);
 assert.equal(snapshot.source.messageId,source.messageId);
 const old='<!--noted-terminal-message-reference:'+encodeURIComponent(JSON.stringify(snapshot))+'--><pre>Details</pre>';
 assert.equal(readTerminalMessageClipboard({getData:t=>t==='text/html'?old:''},details).referenceId,snapshot.referenceId);
});
test('no invented iteration, no changed-source binding and partial document is never decoded',()=>{
 assert.equal(terminalMessageLabel({...source,iteration:null}),'Работа · 日本語 · 14.10.2026, 13:00');
 const copied=terminalMessageClipboard(details,source,'copy-action-1');const snapshot=readTerminalMessageClipboard({getData:t=>t==='text/html'?copied.html:''},details);
 const block=buildTerminalMessageBlock(snapshot);assert.equal(collectTerminalMessageBlocks(block.slice(0,-1)).length,0);
 assert.equal(expandTerminalMessageBlocks(block+block),details+details);
});
