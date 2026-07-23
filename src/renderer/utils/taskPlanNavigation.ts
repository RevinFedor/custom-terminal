export type TaskPlanNavigationTarget = {
  tabId: string;
  taskId?: string;
  view: 'active' | 'archive';
};

const TASK_PLAN_NAVIGATION_EVENT = 'noted-terminal:task-plan-navigation';
let pendingTarget: TaskPlanNavigationTarget | null = null;

export function requestTaskPlanNavigation(target: TaskPlanNavigationTarget): void {
  pendingTarget = target;
  window.dispatchEvent(new CustomEvent<TaskPlanNavigationTarget>(TASK_PLAN_NAVIGATION_EVENT, {
    detail: target,
  }));
}

export function consumeTaskPlanNavigation(tabId: string): TaskPlanNavigationTarget | null {
  if (!pendingTarget || pendingTarget.tabId !== tabId) return null;
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}

export function subscribeTaskPlanNavigation(
  tabId: string,
  listener: (target: TaskPlanNavigationTarget) => void,
): () => void {
  const handle = (event: Event) => {
    const target = (event as CustomEvent<TaskPlanNavigationTarget>).detail;
    if (!target?.tabId || target.tabId !== tabId) return;
    if (pendingTarget?.tabId === target.tabId && pendingTarget?.taskId === target.taskId) {
      pendingTarget = null;
    }
    listener(target);
  };
  window.addEventListener(TASK_PLAN_NAVIGATION_EVENT, handle);
  return () => window.removeEventListener(TASK_PLAN_NAVIGATION_EVENT, handle);
}
