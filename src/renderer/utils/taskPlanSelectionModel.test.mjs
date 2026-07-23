import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTaskPlanTransfer,
  buildTaskPlanSelectionExtraction,
  collectTaskTreeIds,
  formatTaskPlanTransfer,
} from './taskPlanSelectionModel.mjs';

const source = [
  {
    id: 'root-a',
    title: 'Настройки приложений',
    statusId: 'active',
    subtasks: [
      { id: 'child-a1', title: 'Добавить Chat и Work' },
      { id: 'child-a2', title: 'Унифицировать навигацию' },
    ],
  },
  {
    id: 'root-b',
    title: 'Навигация Library',
    subtasks: [{ id: 'child-b1', title: 'Показать скрытые приложения' }],
  },
];

test('selecting a root selects a stable two-level transfer payload', () => {
  const selected = new Set(collectTaskTreeIds(source[0]));
  const result = buildTaskPlanSelectionExtraction(source, selected);

  assert.deepEqual(result.transferItems, [source[0]]);
  assert.equal(result.movedNodeCount, 3);
  assert.deepEqual(result.nextItems, [source[1]]);
});

test('unselected children are promoted when their selected parent leaves', () => {
  const result = buildTaskPlanSelectionExtraction(source, new Set(['root-a', 'child-a1']));

  assert.deepEqual(result.transferItems[0].subtasks, [source[0].subtasks[0]]);
  assert.deepEqual(result.nextItems[0], {
    id: 'child-a2',
    title: 'Унифицировать навигацию',
    statusId: 'active',
    subtasks: [],
  });
  assert.equal(result.nextItems[1].id, 'root-b');
});

test('a selected child becomes a top-level transfer item while its parent remains', () => {
  const result = buildTaskPlanSelectionExtraction(source, new Set(['child-b1']));

  assert.deepEqual(result.nextItems[1].subtasks, []);
  assert.deepEqual(result.transferItems, [{
    id: 'child-b1',
    title: 'Показать скрытые приложения',
    subtasks: [],
  }]);
});

test('transfer text preserves hierarchy and appends after an existing draft', () => {
  const text = formatTaskPlanTransfer([source[0], {
    id: 'child-b1',
    title: 'Показать скрытые приложения',
    subtasks: [],
  }]);

  assert.equal(
    text,
    '- Настройки приложений\n'
      + '  - Добавить Chat и Work\n'
      + '  - Унифицировать навигацию\n'
      + '- Показать скрытые приложения',
  );
  assert.equal(appendTaskPlanTransfer('Уже написано', text), 'Уже написано\n\n' + text);
});
