export async function getGeminiApiKey(ipc = window.require('electron').ipcRenderer) {
  const value = await ipc.invoke('settings:get-gemini-api-key');
  return typeof value === 'string' ? value : '';
}
