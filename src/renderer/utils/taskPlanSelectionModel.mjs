function cloneSubtask(subtask) {
  return {
    id: String(subtask.id),
    title: String(subtask.title),
  };
}

function cloneTask(task, subtasks = task.subtasks || []) {
  const next = {
    id: String(task.id),
    title: String(task.title),
    subtasks: subtasks.map(cloneSubtask),
  };
  if (typeof task.statusId === 'string' && task.statusId) next.statusId = task.statusId;
  if (typeof task.shortTitle === 'string') next.shortTitle = task.shortTitle;
  if (typeof task.body === 'string') next.body = task.body;
  return next;
}

export function taskPlanStateFingerprint(items, archivedItems = []) {
  return JSON.stringify([items || [], archivedItems || []]);
}

export function collectTaskTreeIds(task) {
  return [
    String(task.id),
    ...(Array.isArray(task.subtasks) ? task.subtasks.map((subtask) => String(subtask.id)) : []),
  ];
}

export function buildTaskPlanSelectionExtraction(items, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const nextItems = [];
  const transferItems = [];
  let movedNodeCount = 0;

  for (const task of Array.isArray(items) ? items : []) {
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    const rootSelected = selected.has(task.id);
    const selectedSubtasks = subtasks.filter((subtask) => selected.has(subtask.id));
    const remainingSubtasks = subtasks.filter((subtask) => !selected.has(subtask.id));

    if (rootSelected) {
      transferItems.push(cloneTask(task, selectedSubtasks));
      movedNodeCount += 1 + selectedSubtasks.length;

      // A child cannot remain on the second level after its parent leaves the
      // plan. Promote every explicitly unselected child to a root task while
      // preserving the parent's workflow status.
      for (const subtask of remainingSubtasks) {
        nextItems.push(cloneTask({
          id: subtask.id,
          title: subtask.title,
          statusId: task.statusId,
          subtasks: [],
        }));
      }
      continue;
    }

    nextItems.push(cloneTask(task, remainingSubtasks));
    for (const subtask of selectedSubtasks) {
      transferItems.push(cloneTask({
        id: subtask.id,
        title: subtask.title,
        subtasks: [],
      }));
      movedNodeCount += 1;
    }
  }

  return { nextItems, transferItems, movedNodeCount };
}

export function formatTaskPlanTransfer(items) {
  return (Array.isArray(items) ? items : [])
    .flatMap((task) => [
      `- ${String(task.title || '').trim()}`,
      ...(task.body ? [task.body] : []),
      ...(Array.isArray(task.subtasks)
        ? task.subtasks.map((subtask) => `  - ${String(subtask.title || '').trim()}`)
        : []),
    ])
    .filter((line) => line.trim() !== '-')
    .join('\n');
}

export function appendTaskPlanTransfer(currentText, insertion) {
  const current = String(currentText || '');
  const added = String(insertion || '').trim();
  if (!added) return current;
  if (!current) return added;
  if (current.endsWith('\n\n')) return current + added;
  if (current.endsWith('\n')) return current + '\n' + added;
  return current + '\n\n' + added;
}
