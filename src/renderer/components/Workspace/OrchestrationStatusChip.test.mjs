import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'OrchestrationStatusChip.tsx'), 'utf8');

test('manual recovery shows a stable yellow loader and warning together', () => {
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
  assert.match(statusIcon, /<LoaderCircle className="animate-spin"/);
  assert.match(statusIcon, /<CircleAlert size=\{10\}/);
  assert.match(statusIcon, /width: 26, height: 14/);
});

test('manual recovery exposes automatic continuation, timer hold, report, and detach actions', () => {
  assert.match(source, /Следующее сообщение в этой вкладке/);
  assert.match(source, /run\.outcome === 'interrupted' \? 'Восстановить связь вручную'/);
  assert.match(source, /actionButton\(run, 'wait', 'Продолжить ожидание без таймера'/);
  assert.match(source, /actionButton\(run, 'report', 'Передать ошибку родителю'/);
  assert.match(source, /actionButton\(run, 'dismiss', 'Закрыть без сообщения'/);
});

test('incomplete result proof can be detached from the tooltip and compact status row', () => {
  assert.match(source, /const canDetachResultProof = isOrchestrationResultProofPending\(run\)/);
  assert.match(source, /canCancelActiveRun \|\| canCancelHandoff \|\| canDetachResultProof/);
  assert.match(source, /canDismissAttention \|\| canDismissRecovery \|\| canDetachResultProof/);
  assert.match(source, /canDetachResultProof\s*\? 'detach'/);
});
