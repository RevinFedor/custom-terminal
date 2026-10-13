const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyTaskPlan, applyTaskPlanOperations: apply, normalizeTaskPlan, undoTaskPlan, redoTaskPlan } = require('./tab-task-plan');
const content = { title: 'Подогнать положение элементов без запроса к AI', shortTitle: 'Отступы', body: '  исходный текст\r\n\t**не сокращать**\n\n' + 'λ🧩'.repeat(8000) };
const create = () => apply(emptyTaskPlan(), [{ type: 'add_task', id: 'topic', ...content }]).document;
test('topic metadata is separate and the full Unicode Markdown body survives normalization/history/archive', () => {
  let doc = create();
  assert.deepEqual(normalizeTaskPlan(JSON.stringify(doc)).items[0], { id: 'topic', ...content, subtasks: [] });
  const archived = apply(doc, [{ type: 'archive_task', taskId: 'topic' }]).document;
  assert.equal(archived.archivedItems[0].body, content.body);
  doc = redoTaskPlan(undoTaskPlan(archived).document).document;
  assert.equal(doc.archivedItems[0].shortTitle, content.shortTitle);
  assert.equal(apply(doc, [{ type: 'restore_task', taskId: 'topic' }]).document.items[0].body, content.body);
});
test('legacy replacement/update preserves omitted metadata; an explicit empty body can clear it', () => {
  let doc = apply(create(), [{ type: 'replace_plan', tasks: [{ id: 'topic', title: 'Изменённый заголовок', subtasks: [] }] }]).document;
  assert.equal(doc.items[0].body, content.body); assert.equal(doc.items[0].shortTitle, content.shortTitle);
  doc = apply(doc, [{ type: 'update_task', taskId: 'topic', statusId: 'dev' }]).document;
  assert.equal(doc.items[0].body, content.body);
  assert.equal(apply(doc, [{ type: 'update_task', taskId: 'topic', body: '' }]).document.items[0].body, '');
});
test('AI compare-and-set rejects renamed/replaced/deleted targets atomically', () => {
  const doc = create();
  const renamed = apply(doc, [{ type: 'update_task', taskId: 'topic', title: 'Ручной заголовок' }]).document;
  assert.throws(() => apply(renamed, [{ type: 'update_task', taskId: 'topic', title: 'Поздний AI', ifMatches: content }]), /task_content_changed/);
  const deleted = apply(doc, [{ type: 'remove_task', taskId: 'topic' }]).document;
  assert.throws(() => apply(deleted, [{ type: 'update_task', taskId: 'topic', title: 'Поздний AI', ifMatches: content }]), /task_not_found/);
  const next = apply(doc, [{ type: 'update_task', taskId: 'topic', title: 'Ответ AI', shortTitle: 'Настройка', ifMatches: content }]).document;
  assert.equal(next.items[0].body, content.body);
});
