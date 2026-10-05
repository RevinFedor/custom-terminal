const crypto = require('crypto');

const TASK_PLAN_VERSION = 1;
const TASK_PLAN_HISTORY_LIMIT = 60;
const TASK_PLAN_TITLE_LIMIT = 500;
const TASK_PLAN_MAX_ROOTS = 200;
const TASK_PLAN_MAX_CHILDREN = 200;

function makeTaskPlanId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function cleanTitle(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TASK_PLAN_TITLE_LIMIT);
}

function cleanId(value, prefix, used) {
  const candidate = typeof value === 'string'
    ? value.trim().replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 160)
    : '';
  let id = candidate || makeTaskPlanId(prefix);
  while (used.has(id)) id = makeTaskPlanId(prefix);
  used.add(id);
  return id;
}

function normalizeSubtasks(raw, used) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  for (const value of raw.slice(0, TASK_PLAN_MAX_CHILDREN)) {
    const title = cleanTitle(value?.title);
    if (!title) continue;
    result.push({
      id: cleanId(value?.id, 'subtask', used),
      title,
    });
  }
  return result;
}

function normalizeRootTask(value, used) {
  const title = cleanTitle(value?.title);
  if (!title) return null;
  const task = {
    id: cleanId(value?.id, 'task', used),
    title,
    subtasks: normalizeSubtasks(value?.subtasks, used),
  };
  if (typeof value?.statusId === 'string' && value.statusId.trim()) {
    task.statusId = value.statusId.trim().slice(0, 160);
  }
  return task;
}

function normalizeItems(raw, used = new Set()) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  for (const value of raw.slice(0, TASK_PLAN_MAX_ROOTS)) {
    const task = normalizeRootTask(value, used);
    if (task) result.push(task);
  }
  return result;
}

function normalizeArchivedItems(raw, used = new Set()) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  for (const value of raw.slice(-TASK_PLAN_MAX_ROOTS)) {
    const task = normalizeRootTask(value, used);
    if (!task) continue;
    result.push({
      ...task,
      archivedAt: Number.isFinite(value?.archivedAt)
        ? Math.max(0, Math.floor(value.archivedAt))
        : 0,
    });
  }
  return result;
}

function normalizePlanLists(rawItems, rawArchivedItems) {
  const used = new Set();
  const items = normalizeItems(rawItems, used);
  const archivedItems = normalizeArchivedItems(rawArchivedItems, used);
  return { items, archivedItems };
}

function normalizeHistoryEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-TASK_PLAN_HISTORY_LIMIT).map((entry) => {
    const lists = normalizePlanLists(entry?.items, entry?.archivedItems);
    return {
      ...lists,
      at: Number.isFinite(entry?.at) ? Math.max(0, Math.floor(entry.at)) : Date.now(),
      source: typeof entry?.source === 'string' && entry.source.trim()
        ? entry.source.trim().slice(0, 80)
        : 'unknown',
    };
  });
}

function emptyTaskPlan() {
  return {
    version: TASK_PLAN_VERSION,
    revision: 0,
    items: [],
    archivedItems: [],
    history: { past: [], future: [] },
    updatedAt: null,
    updatedBy: null,
  };
}

function normalizeTaskPlan(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); }
    catch { return emptyTaskPlan(); }
  }
  if (!value || typeof value !== 'object') return emptyTaskPlan();
  const lists = normalizePlanLists(value.items, value.archivedItems);
  return {
    version: TASK_PLAN_VERSION,
    revision: Number.isFinite(value.revision) ? Math.max(0, Math.floor(value.revision)) : 0,
    ...lists,
    history: {
      past: normalizeHistoryEntries(value.history?.past),
      future: normalizeHistoryEntries(value.history?.future),
    },
    updatedAt: Number.isFinite(value.updatedAt) ? Math.max(0, Math.floor(value.updatedAt)) : null,
    updatedBy: typeof value.updatedBy === 'string' && value.updatedBy.trim()
      ? value.updatedBy.trim().slice(0, 80)
      : null,
  };
}

function taskPlanStateEqual(itemsA, archivedA, itemsB, archivedB) {
  return JSON.stringify([itemsA, archivedA]) === JSON.stringify([itemsB, archivedB]);
}

function snapshotOf(document) {
  return {
    items: document.items,
    archivedItems: document.archivedItems,
    at: document.updatedAt || Date.now(),
    source: document.updatedBy || 'unknown',
  };
}

function commitTaskPlanState(rawDocument, rawItems, rawArchivedItems, source = 'unknown') {
  const document = normalizeTaskPlan(rawDocument);
  const { items, archivedItems } = normalizePlanLists(rawItems, rawArchivedItems);
  if (taskPlanStateEqual(document.items, document.archivedItems, items, archivedItems)) {
    return { changed: false, document };
  }
  const now = Date.now();
  return {
    changed: true,
    document: {
      version: TASK_PLAN_VERSION,
      revision: document.revision + 1,
      items,
      archivedItems,
      history: {
        past: [...document.history.past, snapshotOf(document)].slice(-TASK_PLAN_HISTORY_LIMIT),
        future: [],
      },
      updatedAt: now,
      updatedBy: String(source || 'unknown').slice(0, 80),
    },
  };
}

function commitTaskPlanItems(rawDocument, rawItems, source = 'unknown') {
  const document = normalizeTaskPlan(rawDocument);
  return commitTaskPlanState(document, rawItems, document.archivedItems, source);
}

function getTask(items, taskId) {
  const task = items.find((item) => item.id === taskId);
  if (!task) throw new Error(`task_not_found:${taskId}`);
  return task;
}

function applyTaskPlanOperations(rawDocument, rawOperations, source = 'unknown') {
  const document = normalizeTaskPlan(rawDocument);
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new Error('operations_required');
  }
  let { items, archivedItems } = normalizePlanLists(document.items, document.archivedItems);

  for (const operation of rawOperations.slice(0, 500)) {
    const type = operation?.type;
    if (type === 'replace_plan') {
      const used = new Set(archivedItems.flatMap((item) => [item.id, ...item.subtasks.map((subtask) => subtask.id)]));
      items = normalizeItems(operation.tasks, used);
      continue;
    }

    if (type === 'add_task') {
      const title = cleanTitle(operation.title);
      if (!title) throw new Error('task_title_required');
      const used = new Set([
        ...items.flatMap((item) => [item.id, ...item.subtasks.map((subtask) => subtask.id)]),
        ...archivedItems.flatMap((item) => [item.id, ...item.subtasks.map((subtask) => subtask.id)]),
      ]);
      const next = normalizeItems([{
        id: operation.id,
        title,
        statusId: operation.statusId,
        subtasks: operation.subtasks,
      }], used)[0];
      if (!next) throw new Error('task_title_required');
      const afterIndex = typeof operation.afterTaskId === 'string'
        ? items.findIndex((item) => item.id === operation.afterTaskId)
        : -1;
      if (afterIndex >= 0) items.splice(afterIndex + 1, 0, next);
      else items.push(next);
      continue;
    }

    if (type === 'update_task') {
      const task = getTask(items, operation.taskId);
      if (Object.prototype.hasOwnProperty.call(operation, 'title')) {
        const title = cleanTitle(operation.title);
        if (!title) throw new Error('task_title_required');
        task.title = title;
      }
      if (Object.prototype.hasOwnProperty.call(operation, 'statusId')) {
        if (typeof operation.statusId === 'string' && operation.statusId.trim()) {
          task.statusId = operation.statusId.trim().slice(0, 160);
        } else {
          delete task.statusId;
        }
      }
      continue;
    }

    if (type === 'remove_task') {
      const before = items.length;
      items = items.filter((item) => item.id !== operation.taskId);
      if (items.length === before) throw new Error(`task_not_found:${operation.taskId}`);
      continue;
    }

    if (type === 'archive_task') {
      const index = items.findIndex((item) => item.id === operation.taskId);
      if (index < 0) throw new Error(`task_not_found:${operation.taskId}`);
      const [task] = items.splice(index, 1);
      archivedItems.push({ ...task, archivedAt: Date.now() });
      continue;
    }

    if (type === 'restore_task') {
      const index = archivedItems.findIndex((item) => item.id === operation.taskId);
      if (index < 0) throw new Error(`archived_task_not_found:${operation.taskId}`);
      const [archivedTask] = archivedItems.splice(index, 1);
      const { archivedAt: _archivedAt, ...task } = archivedTask;
      items.push(task);
      continue;
    }

    if (type === 'add_subtask') {
      const task = getTask(items, operation.taskId);
      const title = cleanTitle(operation.title);
      if (!title) throw new Error('subtask_title_required');
      const used = new Set([
        ...items.flatMap((item) => [item.id, ...item.subtasks.map((subtask) => subtask.id)]),
        ...archivedItems.flatMap((item) => [item.id, ...item.subtasks.map((subtask) => subtask.id)]),
      ]);
      const subtask = {
        id: cleanId(operation.id, 'subtask', used),
        title,
      };
      const afterIndex = typeof operation.afterSubtaskId === 'string'
        ? task.subtasks.findIndex((item) => item.id === operation.afterSubtaskId)
        : -1;
      if (afterIndex >= 0) task.subtasks.splice(afterIndex + 1, 0, subtask);
      else task.subtasks.push(subtask);
      continue;
    }

    if (type === 'update_subtask') {
      const task = getTask(items, operation.taskId);
      const subtask = task.subtasks.find((item) => item.id === operation.subtaskId);
      if (!subtask) throw new Error(`subtask_not_found:${operation.subtaskId}`);
      const title = cleanTitle(operation.title);
      if (!title) throw new Error('subtask_title_required');
      subtask.title = title;
      continue;
    }

    if (type === 'remove_subtask') {
      const task = getTask(items, operation.taskId);
      const before = task.subtasks.length;
      task.subtasks = task.subtasks.filter((item) => item.id !== operation.subtaskId);
      if (task.subtasks.length === before) throw new Error(`subtask_not_found:${operation.subtaskId}`);
      continue;
    }

    throw new Error(`unsupported_operation:${String(type || '')}`);
  }

  return commitTaskPlanState(document, items, archivedItems, source);
}

function undoTaskPlan(rawDocument, source = 'user') {
  const document = normalizeTaskPlan(rawDocument);
  if (document.history.past.length === 0) return { changed: false, document };
  const previous = document.history.past[document.history.past.length - 1];
  return {
    changed: true,
    document: {
      version: TASK_PLAN_VERSION,
      revision: document.revision + 1,
      items: previous.items,
      archivedItems: previous.archivedItems,
      history: {
        past: document.history.past.slice(0, -1),
        future: [snapshotOf(document), ...document.history.future].slice(0, TASK_PLAN_HISTORY_LIMIT),
      },
      updatedAt: Date.now(),
      updatedBy: String(source || 'user').slice(0, 80),
    },
  };
}

function redoTaskPlan(rawDocument, source = 'user') {
  const document = normalizeTaskPlan(rawDocument);
  if (document.history.future.length === 0) return { changed: false, document };
  const next = document.history.future[0];
  return {
    changed: true,
    document: {
      version: TASK_PLAN_VERSION,
      revision: document.revision + 1,
      items: next.items,
      archivedItems: next.archivedItems,
      history: {
        past: [...document.history.past, snapshotOf(document)].slice(-TASK_PLAN_HISTORY_LIMIT),
        future: document.history.future.slice(1),
      },
      updatedAt: Date.now(),
      updatedBy: String(source || 'user').slice(0, 80),
    },
  };
}

function chooseNewestTaskPlan(incoming, persisted) {
  const next = normalizeTaskPlan(incoming);
  const current = normalizeTaskPlan(persisted);
  if (current.revision > next.revision) return current;
  if (next.revision > current.revision) return next;
  return (current.updatedAt || 0) > (next.updatedAt || 0) ? current : next;
}

module.exports = {
  TASK_PLAN_VERSION,
  TASK_PLAN_HISTORY_LIMIT,
  TASK_PLAN_MAX_ROOTS,
  emptyTaskPlan,
  normalizeTaskPlan,
  normalizeItems,
  normalizeArchivedItems,
  commitTaskPlanItems,
  applyTaskPlanOperations,
  undoTaskPlan,
  redoTaskPlan,
  chooseNewestTaskPlan,
};
