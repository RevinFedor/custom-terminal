import { create } from 'zustand';
const fixture = (window as any).processFixture;
export const useWorkspaceStore = create<any>(() => ({
  view: 'dashboard', activeProjectId: 'fixture-project',
  openProjects: new Map([['fixture-project', { projectPath: '/synthetic', tabs: new Map([
    ['bound-tab', { id: 'bound-tab', name: 'Owned Codex tab', commandType: 'codex', tabType: 'terminal' }],
  ]) }]]),
  spaces: [], activeSpaceId: null, splitPanes: [], centerStrips: {}, activeSpaceTab: null,
  placeTab: (...args: unknown[]) => fixture.navigation.push(args),
}));
export const useProjectsStore = create<any>(() => ({ projects: { 'fixture-project': { name: 'Fixture directory', path: '/synthetic' } } }));
fixture.workspaceStore = useWorkspaceStore;
export function useDiskCapacity() {
  return { status: 'ready', measuredAt: Date.now(), expiresAt: Date.now() + 60000,
    freeBytes: Math.round(62.78 * 1024 ** 3), cacheBytes: 20 * 1024 ** 3, budgetBytes: 20 * 1024 ** 3,
    reserveBytes: 6 * 1024 ** 3, remainingGrowthBytes: 0, projectedFreeBytes: Math.round(62.78 * 1024 ** 3), warning: false,
    ram: {status:'ready', approxBytes:Math.round(1.61 * 1024 ** 3),budgetBytes:2 * 1024 ** 3} };
}
