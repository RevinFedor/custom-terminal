/**
 * Bridge for Sidebar.jsx — maps window.electronAPI calls to ipcRenderer.invoke()
 * Custom-terminal uses nodeIntegration:true, so we create the bridge directly.
 */
const { ipcRenderer, clipboard, shell } = window.require('electron');

if (!window.electronAPI) {
  window.electronAPI = {
    // File operations
    readDirectory: (dirPath: string) => ipcRenderer.invoke('file:read-directory', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath).then((r: any) => r?.content ?? ''),
    renameFile: (oldPath: string, newPath: string) => ipcRenderer.invoke('file:rename', oldPath, newPath),
    createFile: (filePath: string) => ipcRenderer.invoke('file:create', filePath),
    createFolder: (folderPath: string) => ipcRenderer.invoke('file:create-folder', folderPath),
    deletePath: (targetPath: string) => ipcRenderer.invoke('file:delete', targetPath),
    moveItem: (srcPath: string, destDir: string) => ipcRenderer.invoke('file:move-item', srcPath, destDir),
    readFileForUndo: (targetPath: string) => ipcRenderer.invoke('file:read-for-undo', targetPath),
    restoreFromUndo: (data: any) => ipcRenderer.invoke('file:restore-from-undo', data),

    // File watching
    watchFolder: (folderPath: string) => ipcRenderer.invoke('file:watch-folder', folderPath),
    unwatchFolder: () => ipcRenderer.invoke('file:unwatch-folder'),
    onFsChange: (callback: (change: any) => void) => {
      ipcRenderer.on('fs:change', (_event: any, change: any) => callback(change));
    },
    removeFsChangeListener: () => {
      ipcRenderer.removeAllListeners('fs:change');
    },

    // Clipboard
    copyPath: (p: string) => clipboard.writeText(p),

    // Shell
    openExternal: (url: string) => shell.openExternal(url),
  };
}
