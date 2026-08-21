import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const timeline = fs.readFileSync(
  path.resolve(here, '../components/Workspace/Timeline.tsx'),
  'utf8',
);
const history = fs.readFileSync(
  path.resolve(here, '../components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

test('Timeline captures exact SENT handoffs without bypassing the busy transcript defer', () => {
  assert.match(timeline, /subscribeHistoryPromptHandoffs\(tabId/);
  assert.match(timeline, /projectTimelineSentHandoffs\(snapshot, \{ toolType, sessionId \}\)/);
  assert.match(timeline, /mergeTimelineEntriesWithSentHandoffs\(durableEntries, sentHandoffEntries\)/);
  assert.match(timeline, /planTimelineTranscriptRefresh\(\{[\s\S]{0,220}isTurnBusy: busy/);
});

test('the light point keeps canonical actions but never starts truncated AI derivatives', () => {
  assert.match(timeline, /startUuid: entry\.uuid,[\s\S]{0,80}endUuid: entry\.uuid/);
  assert.match(timeline, /requestRewindRef\.current\(target/);
  const outline = timeline.slice(
    timeline.indexOf('const outlineEligibleUuids'),
    timeline.indexOf('const semanticGroups'),
  );
  assert.match(outline, /!entry\.isSentHandoffProjection/);
  assert.match(timeline, /eligibleEntries = entries\.filter\(\(entry\) => entry\.uuid && !entry\.isSentHandoffProjection/);
});

test('History publishes canonical UUID to the handoff before presentation ACK consumes it', () => {
  const consume = history.slice(
    history.indexOf('const consumeMaterializedPromptHandoffs'),
    history.indexOf('// Load full history'),
  );
  const adoptIndex = consume.indexOf('adoptHistoryPromptHandoffCanonicalEntry(');
  const acknowledgeIndex = consume.indexOf('acknowledgeMaterializedHistoryReceipt(');
  const consumeIndex = consume.indexOf('consumeHistoryPromptHandoff(', acknowledgeIndex);
  assert.ok(adoptIndex >= 0 && adoptIndex < acknowledgeIndex && acknowledgeIndex < consumeIndex);
});

test('точка «отправлено» уходит из ленты, когда разговор её обогнал', () => {
  // Иначе она остаётся навсегда и указывает на запись, которой в этом
  // разговоре больше нет: Copy/Select/Edit молча не находят цель по UUID.
  const refresh = fs.readFileSync(
    fileURLToPath(new URL('./timelineTranscriptRefresh.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(refresh, /export function retireDetachedTimelineSentHandoffs\(/);
  // Порог именованный, а не голая цифра в условии.
  assert.match(refresh, /const TIMELINE_SENT_HANDOFF_ABANDON_PROMPTS = 2;/);
  // Правило стоит в общем пути удержания — значит действует и на merge в ленту.
  const retain = refresh.slice(
    refresh.indexOf('export function retainUnmaterializedTimelineSentHandoffs'),
    refresh.indexOf('export function mergeTimelineEntriesWithSentHandoffs'),
  );
  assert.match(retain, /retireDetachedTimelineSentHandoffs\(canonical, alive\)/);
});

test('отказ копирования диапазона называет причину, а не молчит', () => {
  // Пустая ветка отказа оставляла в буфере СТАРЫЙ текст: следующая вставка
  // отдавала не то, и это читалось не как сбой, а как «скопировалось не то».
  const copySlice = timeline.slice(
    timeline.indexOf('      setCopyingRange(null);\n\n      if (result.success) {'),
    timeline.indexOf('  // Удаление диапазона без вставки compact-entry'),
  );
  assert.ok(copySlice.length > 0, 'ветка копирования диапазона найдена');
  assert.match(copySlice, /\} else \{[\s\S]{0,600}showToast\(/);
  assert.match(copySlice, /result\.error/);
  // И у перехвата исключения тоже есть голос.
  assert.match(copySlice, /catch \(error\)[\s\S]{0,300}showToast\(/);

  // Бэкенд называет, КАКОЙ конец диапазона не найден.
  const claudeData = fs.readFileSync(
    fileURLToPath(new URL('../../main/ipc/claude-data.js', import.meta.url)),
    'utf8',
  );
  assert.match(claudeData, /missingLabel = startIndex === -1 && endIndex === -1/);
  assert.match(claudeData, /осталась на старой ветке истории/);
  // Именно в copy-range, а не во всём файле: у соседнего счётчика записей своя
  // ветка с тем же текстом, и она к этой правке отношения не имеет.
  const copyRange = claudeData.slice(
    claudeData.indexOf("ipcMain.handle('claude:copy-range'"),
    claudeData.indexOf('const minIdx = Math.min(startIndex, endIndex);'),
  );
  assert.ok(copyRange.length > 0, 'обработчик copy-range найден');
  assert.ok(
    !/Selected range not found in active history/.test(copyRange),
    'обезличенная формулировка убрана из copy-range',
  );
});
