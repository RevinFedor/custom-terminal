export const INBOX_PROJECT_ID = '__noted_inbox__';
export const INBOX_PROJECT_NAME = 'Inbox';
export const INBOX_PROJECT_DESCRIPTION = 'System workspace for API-created and unassigned agent tabs.';

export function getInboxProjectPath(): string {
  return process.env.NOTED_INBOX_CWD || process.env.HOME || '~';
}

export function isInboxProjectId(projectId?: string | null): boolean {
  return projectId === INBOX_PROJECT_ID;
}
