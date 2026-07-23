const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TASK_PLAN_HISTORY_LIMIT,
  emptyTaskPlan,
  normalizeTaskPlan,
  applyTaskPlanOperations,
  undoTaskPlan,
  redoTaskPlan,
  chooseNewestTaskPlan,
} = require('./tab-task-plan');

test('normalization keeps exactly two levels and root-only statuses', () => {
  const document = normalizeTaskPlan({
    items: [{
      id: 'root-1',
      title: '  Настройки\nприложений  ',
      statusId: 'task-active',
      subtasks: [{
        id: 'child-1',
        title: '  Добавить Chat / Work  ',
        statusId: 'must-not-survive',
        subtasks: [{ id: 'third-level', title: 'Третий уровень' }],
      }],
    }],
  });

  assert.deepEqual(document.items, [{
    id: 'root-1',
    title: 'Настройки приложений',
    statusId: 'task-active',
    subtasks: [{ id: 'child-1', title: 'Добавить Chat / Work' }],
  }]);
  assert.deepEqual(document.archivedItems, []);
});

test('archiving preserves the task, status, subtasks, and participates in undo/redo', () => {
  const active = applyTaskPlanOperations(emptyTaskPlan(), [{
    type: 'add_task',
    id: 'settings',
    title: 'Унифицировать настройки',
    statusId: 'task-active',
    subtasks: [{ id: 'mode', title: 'Добавить Chat / Work' }],
  }], 'user').document;

  const archived = applyTaskPlanOperations(active, [
    { type: 'archive_task', taskId: 'settings' },
  ], 'user').document;

  assert.deepEqual(archived.items, []);
  assert.equal(archived.archivedItems.length, 1);
  assert.equal(archived.archivedItems[0].id, 'settings');
  assert.equal(archived.archivedItems[0].statusId, 'task-active');
  assert.deepEqual(archived.archivedItems[0].subtasks, [{ id: 'mode', title: 'Добавить Chat / Work' }]);
  assert.equal(Number.isFinite(archived.archivedItems[0].archivedAt), true);

  const undone = undoTaskPlan(archived, 'user').document;
  assert.equal(undone.items[0].id, 'settings');
  assert.deepEqual(undone.archivedItems, []);

  const redone = redoTaskPlan(undone, 'user').document;
  assert.deepEqual(redone.items, []);
  assert.equal(redone.archivedItems[0].id, 'settings');
});

test('an archived task can be restored without losing its content', () => {
  const active = applyTaskPlanOperations(emptyTaskPlan(), [{
    type: 'add_task', id: 'work', title: 'Разобраться с Work', statusId: 'task-dev',
  }], 'user').document;
  const archived = applyTaskPlanOperations(active, [{ type: 'archive_task', taskId: 'work' }], 'user').document;
  const restored = applyTaskPlanOperations(archived, [{ type: 'restore_task', taskId: 'work' }], 'user').document;

  assert.deepEqual(restored.archivedItems, []);
  assert.deepEqual(restored.items, [{
    id: 'work', title: 'Разобраться с Work', statusId: 'task-dev', subtasks: [],
  }]);
});

test('replacing the active plan does not erase archived tasks', () => {
  const first = applyTaskPlanOperations(emptyTaskPlan(), [
    { type: 'add_task', id: 'done', title: 'Завершённая область' },
    { type: 'archive_task', taskId: 'done' },
  ], 'user').document;
  const replaced = applyTaskPlanOperations(first, [{
    type: 'replace_plan', tasks: [{ id: 'active', title: 'Новая активная область' }],
  }], 'terminal-mcp').document;

  assert.equal(replaced.items[0].id, 'active');
  assert.equal(replaced.archivedItems[0].id, 'done');
});

test('an operation batch is one revision and one undo step', () => {
  const result = applyTaskPlanOperations(emptyTaskPlan(), [
    { type: 'add_task', id: 'work', title: 'Разобраться с режимом Work' },
    { type: 'add_subtask', taskId: 'work', id: 'export', title: 'Проверить экспорт диалога' },
    { type: 'update_task', taskId: 'work', statusId: 'task-active' },
  ], 'terminal-mcp');

  assert.equal(result.changed, true);
  assert.equal(result.document.revision, 1);
  assert.equal(result.document.history.past.length, 1);
  assert.equal(result.document.history.future.length, 0);
  assert.deepEqual(result.document.items, [{
    id: 'work',
    title: 'Разобраться с режимом Work',
    statusId: 'task-active',
    subtasks: [{ id: 'export', title: 'Проверить экспорт диалога' }],
  }]);
});

test('delta update preserves unrelated tasks and ordering', () => {
  const initial = applyTaskPlanOperations(emptyTaskPlan(), [{
    type: 'replace_plan',
    tasks: [
      { id: 'work', title: 'Разобраться с Work', subtasks: [] },
      { id: 'settings', title: 'Унифицировать настройки', subtasks: [] },
      { id: 'library', title: 'Пересобрать Library', subtasks: [] },
    ],
  }], 'user').document;

  const updated = applyTaskPlanOperations(initial, [{
    type: 'add_subtask',
    taskId: 'settings',
    id: 'mode',
    title: 'Добавить выбор Chat / Work',
  }], 'terminal-mcp').document;

  assert.deepEqual(updated.items.map((item) => item.id), ['work', 'settings', 'library']);
  assert.deepEqual(updated.items[0], initial.items[0]);
  assert.deepEqual(updated.items[2], initial.items[2]);
  assert.deepEqual(updated.items[1].subtasks, [{ id: 'mode', title: 'Добавить выбор Chat / Work' }]);
});

test('user and MCP changes share undo and redo history', () => {
  const userChange = applyTaskPlanOperations(emptyTaskPlan(), [
    { type: 'add_task', id: 'root', title: 'Реализовать план' },
  ], 'user').document;
  const mcpChange = applyTaskPlanOperations(userChange, [
    { type: 'update_task', taskId: 'root', title: 'Реализовать план вкладки' },
  ], 'terminal-mcp').document;

  const undone = undoTaskPlan(mcpChange, 'user').document;
  assert.equal(undone.items[0].title, 'Реализовать план');
  assert.equal(undone.history.future.length, 1);

  const redone = redoTaskPlan(undone, 'user').document;
  assert.equal(redone.items[0].title, 'Реализовать план вкладки');
  assert.equal(redone.history.future.length, 0);
});

test('newer persisted revision wins over a stale renderer save', () => {
  const incoming = { ...emptyTaskPlan(), revision: 2, updatedAt: 200, items: [{ id: 'old', title: 'Старый план', subtasks: [] }] };
  const persisted = { ...emptyTaskPlan(), revision: 3, updatedAt: 100, items: [{ id: 'new', title: 'Новый план', subtasks: [] }] };
  assert.equal(chooseNewestTaskPlan(incoming, persisted).items[0].id, 'new');

  const equalRevisionIncoming = { ...incoming, revision: 3, updatedAt: 300 };
  assert.equal(chooseNewestTaskPlan(equalRevisionIncoming, persisted).items[0].id, 'old');
});

test('invalid targets fail without producing a partial document', () => {
  const initial = applyTaskPlanOperations(emptyTaskPlan(), [
    { type: 'add_task', id: 'root', title: 'Исходная задача' },
  ], 'user').document;

  assert.throws(() => applyTaskPlanOperations(initial, [
    { type: 'update_task', taskId: 'root', title: 'Промежуточное изменение' },
    { type: 'remove_subtask', taskId: 'root', subtaskId: 'missing' },
  ], 'terminal-mcp'), /subtask_not_found/);
  assert.equal(initial.items[0].title, 'Исходная задача');
  assert.equal(initial.revision, 1);
});

test('history is capped', () => {
  let document = emptyTaskPlan();
  document = applyTaskPlanOperations(document, [{ type: 'add_task', id: 'root', title: 'Версия 0' }], 'user').document;
  for (let index = 1; index <= TASK_PLAN_HISTORY_LIMIT + 5; index += 1) {
    document = applyTaskPlanOperations(document, [{ type: 'update_task', taskId: 'root', title: `Версия ${index}` }], 'user').document;
  }
  assert.equal(document.history.past.length, TASK_PLAN_HISTORY_LIMIT);
});
