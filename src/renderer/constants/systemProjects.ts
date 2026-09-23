export const INBOX_PROJECT_ID = '__noted_inbox__';
export const INBOX_PROJECT_NAME = 'Inbox';
export const INBOX_PROJECT_DESCRIPTION = 'System workspace for API-created and unassigned agent tabs.';

export function resolveWorkspaceCwd(cwd?: string): string {
  return resolveWorkingDirectory(cwd, window.require('os').homedir(), window.require('path'));
}

export function getInboxProjectPath(): string {
  // Vite replaces process.env in renderer code. Read the native environment
  // through Electron, just as the terminal's main-process owner does.
  const nativeEnv = window.require('process').env;
  return resolveWorkspaceCwd(nativeEnv.NOTED_INBOX_CWD || nativeEnv.HOME);
}

export function isInboxProjectId(projectId?: string | null): boolean {
  return projectId === INBOX_PROJECT_ID;
}
import { resolveWorkingDirectory } from '../../shared/working-directory.cjs';
