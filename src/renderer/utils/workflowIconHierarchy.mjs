import { inferSpaceProjectIds } from './workspaceSpacesModel.mjs';

export const WORKFLOW_ICON_HIERARCHY_MIGRATION_KEY = 'workflow-icon-hierarchy-v1';
export const WORKFLOW_ICON_HIERARCHY_MIGRATION_VERSION = 1;

const normalized = (value) => String(value || '').trim().toLocaleLowerCase();
const sameList = (left, right) => (
  left.length === right.length && left.every((value, index) => value === right[index])
);

export function matchWorkflowIconPreset(project, presets) {
  if (!project) return null;
  const path = String(project.path || '');
  const name = normalized(project.name);
  return (Array.isArray(presets) ? presets : []).find((preset) => (
    (preset.projectPaths || []).includes(path)
      || (preset.projectNames || []).some((candidate) => normalized(candidate) === name)
  )) || null;
}

/**
 * One-shot migration plan. Pure: no Zustand, IPC or filesystem writes.
 *
 * Workflow aliases reserve their known project before layout inference runs.
 * This matters for cross-project panes: `main` may contain a UAV chip, but that
 * must not steal AgroField from the explicit `uav repo` workflow. Remaining
 * layout projects are preserved in order, while one project can have only one
 * workflow parent.
 */
export function planWorkflowIconHierarchyMigration({ spaces, projects, presets }) {
  const sourceSpaces = Array.isArray(spaces) ? spaces : [];
  const sourceProjects = Array.isArray(projects) ? projects : [];
  const projectById = new Map(sourceProjects.map((project) => [project.id, project]));
  const presetByProjectId = new Map();
  sourceProjects.forEach((project) => {
    const preset = matchWorkflowIconPreset(project, presets);
    if (preset) presetByProjectId.set(project.id, preset);
  });

  const forcedProjectBySpaceId = new Map();
  sourceSpaces.forEach((space) => {
    const workflowName = normalized(space?.name);
    const preset = (Array.isArray(presets) ? presets : []).find((candidate) => (
      (candidate.workflowNames || []).some((name) => normalized(name) === workflowName)
    ));
    if (!preset) return;
    const project = sourceProjects.find((candidate) => presetByProjectId.get(candidate.id) === preset);
    if (project) forcedProjectBySpaceId.set(space.id, project.id);
  });
  const reservedProjectIds = new Set(forcedProjectBySpaceId.values());

  const claimedProjectIds = new Set();
  const spaceUpdates = [];
  sourceSpaces.forEach((space) => {
    const forcedProjectId = forcedProjectBySpaceId.get(space.id) || null;
    const candidates = [];
    const seenCandidates = new Set();
    const addCandidate = (projectId) => {
      if (!projectId || seenCandidates.has(projectId) || !projectById.has(projectId)) return;
      seenCandidates.add(projectId);
      candidates.push(projectId);
    };
    (Array.isArray(space.projectIds) ? space.projectIds : []).forEach(addCandidate);
    inferSpaceProjectIds(space.layout).forEach(addCandidate);

    const projectIds = [];
    if (forcedProjectId && !claimedProjectIds.has(forcedProjectId)) {
      projectIds.push(forcedProjectId);
      claimedProjectIds.add(forcedProjectId);
    }
    candidates.forEach((projectId) => {
      if (claimedProjectIds.has(projectId)) return;
      if (reservedProjectIds.has(projectId) && projectId !== forcedProjectId) return;
      claimedProjectIds.add(projectId);
      projectIds.push(projectId);
    });

    let icon = space.icon;
    if (icon === undefined) {
      const primaryProject = projectById.get(projectIds[0]);
      const preset = primaryProject ? presetByProjectId.get(primaryProject.id) : null;
      icon = preset?.workflowIcon || primaryProject?.icon || null;
    }

    const previousProjectIds = Array.isArray(space.projectIds) ? space.projectIds : [];
    if (!sameList(previousProjectIds, projectIds) || icon !== space.icon) {
      spaceUpdates.push({ id: space.id, icon, projectIds });
    }
  });

  const projectUpdates = sourceProjects.flatMap((project) => {
    const preset = presetByProjectId.get(project.id);
    if (!preset || !preset.projectIcon || project.icon === preset.projectIcon) return [];
    return [{ id: project.id, icon: preset.projectIcon, presetKey: preset.key }];
  });

  return { spaceUpdates, projectUpdates };
}

