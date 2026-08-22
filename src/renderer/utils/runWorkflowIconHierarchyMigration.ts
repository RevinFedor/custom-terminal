import { useProjectsStore } from '../store/useProjectsStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { buildSessionSnapshot } from './sessionSnapshot.mjs';
import {
  WORKFLOW_ICON_HIERARCHY_MIGRATION_KEY,
  WORKFLOW_ICON_HIERARCHY_MIGRATION_VERSION,
  planWorkflowIconHierarchyMigration,
} from './workflowIconHierarchy.mjs';
import { WORKFLOW_ICON_PRESETS } from './workflowIconCatalog';

const { ipcRenderer } = window.require('electron');
const SESSION_KEY = 'workspace-session';

const sameStringList = (left: unknown, right: string[]) => (
  Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
);

/**
 * Production-only one-shot migration requested for the existing workspace.
 *
 * It deliberately goes through both live stores. Writing the app-state JSON
 * from an external script while the renderer is alive would lose a race to the
 * next normal 300 ms session save (or shutdown save) and overwrite the entire
 * layout. Here metadata is merged into live state first, then the canonical
 * snapshot builder performs the one whole-record write.
 */
export async function runWorkflowIconHierarchyMigration() {
  if (!import.meta.env.PROD) return { skipped: 'development' as const };

  const marker = await ipcRenderer.invoke('app:getState', WORKFLOW_ICON_HIERARCHY_MIGRATION_KEY);
  if (Number(marker?.version) >= WORKFLOW_ICON_HIERARCHY_MIGRATION_VERSION) {
    return { skipped: 'already-complete' as const };
  }

  const projectsStore = useProjectsStore.getState();
  const workspaceStore = useWorkspaceStore.getState();
  const projects = Object.values(projectsStore.projects);
  const plan = planWorkflowIconHierarchyMigration({
    spaces: workspaceStore.spaces,
    projects,
    presets: WORKFLOW_ICON_PRESETS,
  });
  console.warn(
    '[WorkflowIconMigration] plan' +
    ` updates=${plan.spaceUpdates.map((item) => item.id).join(',') || '-'}` +
    ` creates=${plan.spaceCreates.map((item) => item.presetKey).join(',') || '-'}` +
    ` projects=${plan.projectUpdates.map((item) => item.presetKey).join(',') || '-'}`
  );

  for (const update of plan.spaceUpdates) {
    useWorkspaceStore.getState().updateWorkspaceSpaceMetadata(update.id, {
      icon: update.icon,
      projectIds: update.projectIds,
    });
  }

  const createdSpaces: Array<{ id: string; icon: string | null; projectIds: string[] }> = [];
  for (const create of plan.spaceCreates) {
    const id = useWorkspaceStore.getState().addWorkspaceSpace({
      activate: false,
      name: create.name,
    });
    if (!id) throw new Error(`workflow_icon_space_create_failed:${create.presetKey}`);
    const updated = useWorkspaceStore.getState().updateWorkspaceSpaceMetadata(id, {
      icon: create.icon,
      projectIds: create.projectIds,
    });
    if (!updated) throw new Error(`workflow_icon_space_metadata_failed:${create.presetKey}`);
    createdSpaces.push({ id, icon: create.icon, projectIds: create.projectIds });
  }

  for (const update of plan.projectUpdates) {
    await useProjectsStore.getState().updateProject(update.id, { icon: update.icon });
    const persistedProject = await ipcRenderer.invoke('project:getById', update.id);
    if (!persistedProject || persistedProject.icon !== update.icon) {
      throw new Error(`workflow_icon_project_verify_failed:${update.id}`);
    }
  }

  // One canonical durability boundary after all live metadata changes.
  const snapshot = buildSessionSnapshot(useWorkspaceStore.getState());
  const saveResult = await ipcRenderer.invoke('app:setState', { key: SESSION_KEY, value: snapshot });
  if (!saveResult?.success) throw new Error('workflow_icon_session_save_failed');

  const persistedSession = await ipcRenderer.invoke('app:getState', SESSION_KEY);
  for (const expected of [...plan.spaceUpdates, ...createdSpaces]) {
    const actual = persistedSession?.spaces?.find((space: any) => space?.id === expected.id);
    if (!actual || actual.icon !== expected.icon || !sameStringList(actual.projectIds, expected.projectIds)) {
      throw new Error(
        `workflow_icon_space_verify_failed:${expected.id}` +
        `:found=${actual ? 1 : 0}` +
        `:iconMatch=${actual?.icon === expected.icon ? 1 : 0}` +
        `:actualProjects=${JSON.stringify(actual?.projectIds ?? null)}` +
        `:expectedProjects=${JSON.stringify(expected.projectIds)}`
      );
    }
  }

  const completedAt = Date.now();
  const markerResult = await ipcRenderer.invoke('app:setState', {
    key: WORKFLOW_ICON_HIERARCHY_MIGRATION_KEY,
    value: {
      version: WORKFLOW_ICON_HIERARCHY_MIGRATION_VERSION,
      completedAt,
      workflowsUpdated: plan.spaceUpdates.length,
      workflowsCreated: createdSpaces.length,
      projectsUpdated: plan.projectUpdates.length,
    },
  });
  if (!markerResult?.success) throw new Error('workflow_icon_marker_save_failed');

  console.warn(
    '[WorkflowIconMigration] complete' +
    ` workflows=${plan.spaceUpdates.length}` +
    ` created=${createdSpaces.length}` +
    ` projects=${plan.projectUpdates.length}`
  );
  return {
    completedAt,
    workflowsUpdated: plan.spaceUpdates.length,
    workflowsCreated: createdSpaces.length,
    projectsUpdated: plan.projectUpdates.length,
  };
}
