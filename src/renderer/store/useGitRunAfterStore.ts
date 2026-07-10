import { create } from 'zustand';

export type GitRunAfterAction = 'generate' | 'generate-commit';
export type GitRunAfterPhase = 'waiting' | 'running' | 'success';

export type GitRunAfterResult = {
  summary: string;
  description: string;
  meta?: unknown;
};

export type GitRunAfterTask = {
  id: string;
  projectKey: string;
  projectId?: string | null;
  projectName?: string;
  repoPath: string;
  selectedPaths: string[];
  docsOnlyWhenPresent: boolean;
  contextTabId?: string | null;
  contextTabName?: string | null;
  triggerTabId: string;
  action: GitRunAfterAction;
  phase: GitRunAfterPhase;
  createdAt: number;
  result?: GitRunAfterResult;
};

type ArmGitRunAfterTask = Omit<GitRunAfterTask, 'id' | 'phase' | 'createdAt' | 'result'>;

type GitRunAfterState = {
  tasks: Map<string, GitRunAfterTask>;
  armTask: (task: ArmGitRunAfterTask) => GitRunAfterTask;
  startTask: (projectKey: string, taskId: string) => boolean;
  completeTask: (projectKey: string, taskId: string, result: GitRunAfterResult) => boolean;
  clearTask: (projectKey: string, taskId?: string) => boolean;
};

function makeTaskId(projectKey: string): string {
  const suffix = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${projectKey}:${suffix}`;
}

export function gitRunAfterProjectKey(projectId?: string | null, projectPath?: string | null): string {
  return String(projectId || projectPath || '').trim();
}

export const useGitRunAfterStore = create<GitRunAfterState>((set) => ({
  tasks: new Map(),

  armTask: (input) => {
    const task: GitRunAfterTask = {
      ...input,
      id: makeTaskId(input.projectKey),
      phase: 'waiting',
      createdAt: Date.now(),
    };
    set((state) => {
      const tasks = new Map(state.tasks);
      tasks.set(input.projectKey, task);
      return { tasks };
    });
    return task;
  },

  startTask: (projectKey, taskId) => {
    let started = false;
    set((state) => {
      const current = state.tasks.get(projectKey);
      if (!current || current.id !== taskId || current.phase !== 'waiting') return state;
      const tasks = new Map(state.tasks);
      tasks.set(projectKey, { ...current, phase: 'running' });
      started = true;
      return { tasks };
    });
    return started;
  },

  completeTask: (projectKey, taskId, result) => {
    let completed = false;
    set((state) => {
      const current = state.tasks.get(projectKey);
      if (!current || current.id !== taskId || current.phase !== 'running') return state;
      const tasks = new Map(state.tasks);
      tasks.set(projectKey, { ...current, phase: 'success', result });
      completed = true;
      return { tasks };
    });
    return completed;
  },

  clearTask: (projectKey, taskId) => {
    let cleared = false;
    set((state) => {
      const current = state.tasks.get(projectKey);
      if (!current || (taskId && current.id !== taskId)) return state;
      const tasks = new Map(state.tasks);
      tasks.delete(projectKey);
      cleared = true;
      return { tasks };
    });
    return cleared;
  },
}));
