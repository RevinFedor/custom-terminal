import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'OrchestrationStatusChip.tsx'), 'utf8');

test('manual recovery shows a static yellow timer and warning together', () => {
  const presentationStart = source.indexOf('function runPresentation');
  const presentationEnd = source.indexOf('function StatusIcon', presentationStart);
  const presentation = source.slice(presentationStart, presentationEnd);
  const iconStart = presentationEnd;
  const iconEnd = source.indexOf('function runTime', iconStart);
  const statusIcon = source.slice(iconStart, iconEnd);

  assert.match(presentation, /run\.status === 'waiting_recovery'/);
  assert.match(presentation, /icon: 'recovery'/);
  assert.match(presentation, /run\.outcome === 'interrupted' \? 'Остановлено вручную'/);
  assert.match(statusIcon, /presentation\.icon === 'recovery'/);
  assert.match(statusIcon, /presentation\.icon === 'recovery'[\s\S]*?<Timer size=\{13\}/);
  assert.match(statusIcon, /<CircleAlert size=\{10\}/);
  assert.match(statusIcon, /width: 26, height: 14/);
});

test('yellow delivery and queued states use a static timer instead of a frozen loader', () => {
  const presentationStart = source.indexOf('function runPresentation');
  const presentationEnd = source.indexOf('function StatusIcon', presentationStart);
  const presentation = source.slice(presentationStart, presentationEnd);

  assert.match(presentation, /run\.status === 'sent' && run\.deliveryAuditPendingAt && !run\.targetPromptProofAt/);
  assert.match(presentation, /label: 'Проверка доставки'/);
  assert.match(presentation, /color: '#fbbf24'[\s\S]*?icon: 'waiting'[\s\S]*?spinning: false/);
  assert.match(presentation, /run\.status === 'queued' \|\| run\.status === 'sent'/);
  assert.match(source, /else if \(presentation\.icon === 'waiting'\) icon = <Timer/);
  assert.match(source, /queued: 'Ожидает отправки'/);
});

test('authoritative completion changes the active spinner to a distinct result-proof icon', () => {
  const presentationStart = source.indexOf('function runPresentation');
  const presentationEnd = source.indexOf('function StatusIcon', presentationStart);
  const presentation = source.slice(presentationStart, presentationEnd);
  assert.match(presentation, /isOrchestrationResultProofPending\(run\)[\s\S]*?icon: 'proof'/);
  assert.match(presentation, /label: 'Проверка результата'/);
  assert.match(presentation, /icon: 'proof'[\s\S]*?spinning: false/);
  assert.match(source, /presentation\.icon === 'proof'\) icon = <Search/);
});

test('manual recovery exposes automatic continuation, timer hold, report, and detach actions', () => {
  assert.match(source, /Следующее сообщение в этой вкладке/);
  assert.match(source, /run\.outcome === 'interrupted' \? 'Восстановить связь вручную'/);
  assert.match(source, /actionButton\(run, 'wait', 'Продолжить ожидание без таймера'/);
  assert.match(source, /actionButton\(run, 'report', 'Передать ошибку родителю'/);
  assert.match(source, /actionButton\(run, paused \? 'detach' : 'dismiss', paused \? 'Отвязать запрос' : 'Закрыть без сообщения'/);
});

test('incomplete result proof can be detached from the tooltip and compact status row', () => {
  assert.match(source, /const canDetachResultProof = isOrchestrationResultProofPending\(run\)/);
  assert.match(source, /canCancelActiveRun \|\| canCancelHandoff \|\| canDetachResultProof/);
  assert.match(source, /canDismissAttention \|\| canDismissRecovery \|\| canDetachResultProof/);
  assert.match(source, /canDetachResultProof \|\| paused\s*\? 'detach'/);
});

test('active orchestration runs stack vertically and open top-aligned details on the left', () => {
  assert.match(source, /data-orchestration-active-list[\s\S]*?flexDirection: 'column'/);
  assert.match(source, /data-orchestration-active-list[\s\S]*?overflowY: 'auto'/);
  assert.match(source, /data-orchestration-active-run=\{run\.runId\}[\s\S]*?borderBottom:/);
  assert.match(source, /<Tooltip[\s\S]*?side="left"[\s\S]*?align="start"/);
});
