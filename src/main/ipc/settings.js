const { ipcMain } = require('electron');

function register({ projectManager }) {
  // ── Research Conversations ──

  ipcMain.handle('research:save-conversation', async (event, { dirPath, conversation }) => {
    try {
      projectManager.db.saveResearchConversation(dirPath, conversation);
      return { success: true };
    } catch (error) {
      console.error('[main] Error saving research conversation:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('research:get-conversations', async (event, dirPath) => {
    try {
      const conversations = projectManager.db.getResearchConversations(dirPath);
      return { success: true, data: conversations };
    } catch (error) {
      console.error('[main] Error getting research conversations:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('research:delete-conversation', async (event, { dirPath, conversationId }) => {
    try {
      projectManager.db.deleteResearchConversation(dirPath, conversationId);
      return { success: true };
    } catch (error) {
      console.error('[main] Error deleting research conversation:', error);
      return { success: false, error: error.message };
    }
  });

  // ── Global Commands ──

  ipcMain.handle('commands:get-global', async () => {
    try {
      const commands = projectManager.getGlobalCommands();
      return { success: true, data: commands };
    } catch (error) {
      console.error('[main] Error getting global commands:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('commands:save-global', async (event, commands) => {
    try {
      projectManager.saveGlobalCommands(commands);
      return { success: true };
    } catch (error) {
      console.error('[main] Error saving global commands:', error);
      return { success: false, error: error.message };
    }
  });

  // ── Prompts ──

  ipcMain.handle('prompts:get', async () => {
    try {
      const prompts = projectManager.getPrompts();
      return { success: true, data: prompts };
    } catch (error) {
      console.error('[main] Error getting prompts:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('prompts:save', async (event, prompts) => {
    try {
      projectManager.savePrompts(prompts);
      return { success: true };
    } catch (error) {
      console.error('[main] Error saving prompts:', error);
      return { success: false, error: error.message };
    }
  });

  // ── Prompt Groups ──

  ipcMain.handle('prompt-groups:get', async () => {
    try {
      const groups = projectManager.getPromptGroups();
      return { success: true, data: groups };
    } catch (error) {
      console.error('[main] Error getting prompt groups:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('prompt-groups:save', async (event, groups) => {
    try {
      projectManager.savePromptGroups(groups);
      return { success: true };
    } catch (error) {
      console.error('[main] Error saving prompt groups:', error);
      return { success: false, error: error.message };
    }
  });

  // ── AI Prompts (Dynamic System Prompts) ──

  ipcMain.handle('ai-prompts:get', async () => {
    try {
      const prompts = projectManager.getAIPrompts();
      return { success: true, data: prompts };
    } catch (error) {
      console.error('[main] Error getting AI prompts:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ai-prompts:save', async (event, prompt) => {
    try {
      console.log('[AIPrompts] Saving:', prompt.id, 'thinkingLevel=' + prompt.thinkingLevel, 'model=' + prompt.model);
      projectManager.saveAIPrompt(prompt);
      return { success: true };
    } catch (error) {
      console.error('[main] Error saving AI prompt:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('ai-prompts:delete', async (event, id) => {
    try {
      projectManager.deleteAIPrompt(id);
      return { success: true };
    } catch (error) {
      console.error('[main] Error deleting AI prompt:', error);
      return { success: false, error: error.message };
    }
  });

  // API Call Log
  ipcMain.handle('api-calls:list', async (event, args) => {
    try {
      const projectId = args?.projectId || null;
      const limit = args?.limit || 50;
      console.log('[ApiCallLog] Listing API calls, projectId=' + (projectId || 'all') + ' limit=' + limit);
      const data = projectManager.db.getApiCallLog(projectId, limit);
      console.log('[ApiCallLog] Found ' + data.length + ' entries');
      return { success: true, data };
    } catch (error) {
      console.error('[ApiCallLog] Error listing API calls:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { register };
