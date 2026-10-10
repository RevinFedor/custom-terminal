import React from 'react';
import { createRoot } from 'react-dom/client';
import TabTaskPlanPanel from '../../src/renderer/components/Workspace/TabTaskPlanPanel';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { applyTaskPlanOperations, emptyTaskPlan, undoTaskPlan, redoTaskPlan } from '../../src/main/tab-task-plan.js';

const f = (window as any).taskFixture;
const plan = applyTaskPlanOperations(emptyTaskPlan(), ['Отступы', 'Astra', 'Docs', 'Аудит', 'Input', 'Файлы', 'Длинное название задачи с полным текстом для просмотра'].map((title, i) => ({
  type: 'add_task', id: 'task-' + i, title, statusId: 'dev', subtasks: i === 0 ? [{ id: 'subtask', title: 'Проверить точный переход' }] : [],
})), 'fixture').document;
const tabs = new Map(['owner', 'other'].map(id => [id, { id, name: id, commandType: 'codex', taskPlan: plan }]));
useWorkspaceStore.setState({ openProjects: new Map([['fixture', { projectId: 'fixture', projectPath: '/fixture', tabs }]]) } as any);
useUIStore.setState({ taskStatuses: [{ id: 'dev', label: 'Разработка', color: '#d9b350' }], taskStatusMarker: { sizePx: 8, shape: 'square', showTitles: true } } as any);
f.operation = (channel: string, payload: any) => {
  if (f.failNext) { f.failNext = false; return { success: false, error: 'private save failure' }; }
  const current = useWorkspaceStore.getState().openProjects.get('fixture')!.tabs.get(payload.tabId)!.taskPlan;
  const next = channel.endsWith('apply') ? applyTaskPlanOperations(current, payload.operations, 'user')
    : channel.endsWith('undo') ? undoTaskPlan(current, 'user') : redoTaskPlan(current, 'user');
  return { success: true, document: next.document };
};
f.state = (id = 'owner') => useWorkspaceStore.getState().openProjects.get('fixture')!.tabs.get(id)!.taskPlan;
f.titles = (showTitles: boolean) => useUIStore.getState().setTaskStatusMarker({ showTitles });
f.renameOutside = (title: string) => useWorkspaceStore.getState().applyTabTaskPlanOperations('owner', [{ type: 'update_task', taskId: 'task-0', title }]);
function Fixture() {
  return <>
    <div data-owner-fixture style={{ position: 'absolute', left: 35, top: 80, width: 390, height: 450, border: '1px solid #444' }}>
      <TabTaskPlanPanel tabId="owner" projectPath="/fixture" inputSurface="history" commandType="codex" />
      <div data-history style={{ paddingTop: 70 }}>Текущая работа чата</div>
    </div>
    <div data-other-fixture style={{ position: 'absolute', left: 715, top: 80, width: 300, height: 450, border: '1px solid #444' }}>
      <TabTaskPlanPanel tabId="other" projectPath="/fixture" inputSurface="history" commandType="codex" />
    </div>
    <button data-underlay style={{ position: 'absolute', left: 25, top: 600 }} onClick={() => f.underlayClicks++}>Underlying action</button>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
