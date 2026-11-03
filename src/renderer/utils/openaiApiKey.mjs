// Ключ читается из runtime Electron main через локальный IPC и никогда не
// встраивается в сборку renderer — тот же порядок, что у `geminiApiKey.mjs`.
export async function getOpenAIApiKey(ipc = window.require('electron').ipcRenderer) {
  const value = await ipc.invoke('settings:get-openai-api-key');
  return typeof value === 'string' ? value : '';
}
