export const UNPLACED_WORKFLOW_ID = '__workflow_unplaced__';
export const UNPLACED_WORKFLOW_NAME = 'Не размещены';

export const WORKFLOW_FALLBACK_COLORS = [
  '#7c3aed',
  '#2563eb',
  '#0891b2',
  '#059669',
  '#ca8a04',
  '#ea580c',
  '#db2777',
];

export function workflowFallbackColor(id) {
  const value = String(id || 'workflow');
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return WORKFLOW_FALLBACK_COLORS[Math.abs(hash) % WORKFLOW_FALLBACK_COLORS.length];
}

export function workflowInitial(name) {
  return String(name || 'W').trim().slice(0, 1).toUpperCase() || 'W';
}

/**
 * Legacy workflows had no own icon field; their first project's old colored
 * icon was the workflow icon. `undefined` keeps that migration fallback,
 * while explicit `null` means the user cleared it and wants the color tile.
 */
export function resolveWorkflowIcon(space, projectIconById = () => null) {
  if (space && Object.prototype.hasOwnProperty.call(space, 'icon') && space.icon !== undefined) {
    return typeof space.icon === 'string' && space.icon ? space.icon : null;
  }
  const defaultProjectId = Array.isArray(space?.projectIds) ? space.projectIds[0] : null;
  return defaultProjectId ? (projectIconById(defaultProjectId) || null) : null;
}
