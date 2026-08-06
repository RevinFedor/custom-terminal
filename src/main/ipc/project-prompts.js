const { BrowserWindow, ipcMain } = require('electron');

function errorPayload(error) {
  return {
    success: false,
    error: error?.message || String(error),
    code: error?.code || 'project_prompts_error',
    paths: Array.isArray(error?.paths) ? error.paths : undefined,
  };
}

function register({ service }) {
  if (!service) throw new Error('project-prompts IPC requires service');

  ipcMain.handle('project-prompts:get-sources', (_event, projectId) => {
    try {
      return { success: true, data: service.getSources(projectId) };
    } catch (error) {
      return errorPayload(error);
    }
  });

  ipcMain.handle('project-prompts:set-sources', (_event, { projectId, roots } = {}) => {
    try {
      const data = service.setSources(projectId, roots);
      return { success: true, data };
    } catch (error) {
      return errorPayload(error);
    }
  });

  ipcMain.handle('project-prompts:list', (_event, projectId) => {
    try {
      return { success: true, data: service.listProject(projectId) };
    } catch (error) {
      return errorPayload(error);
    }
  });

  ipcMain.handle('project-prompts:usage-for-root', (_event, rootPath) => {
    try {
      return { success: true, data: service.usageForRoot(rootPath) };
    } catch (error) {
      return errorPayload(error);
    }
  });

  return () => {
    for (const channel of [
      'project-prompts:get-sources',
      'project-prompts:set-sources',
      'project-prompts:list',
      'project-prompts:usage-for-root',
    ]) {
      try { ipcMain.removeHandler(channel); } catch {}
    }
  };
}

function broadcastProjectPromptsChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed() || win.webContents?.isDestroyed()) continue;
    try { win.webContents.send('project-prompts:changed', payload); } catch {}
  }
}

module.exports = { register, broadcastProjectPromptsChanged };
