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
