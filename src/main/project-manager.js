const DatabaseManager = require('./database');
const { migrateFromJSON } = require('./migration');

class ProjectManager {
  constructor() {
    this.db = new DatabaseManager();
    this.init();
  }

  init() {
    try {
      // Check if this is first run and migrate from JSON if needed
      const projectCount = this.db.db.prepare('SELECT COUNT(*) as count FROM projects').get().count;

      if (projectCount === 0) {
        try {
          migrateFromJSON();
        } catch (err) {
        }
      }

      // Migrate quick_actions to global_commands
      const migrationResult = this.db.migrateQuickActionsToGlobal();
      if (migrationResult.migrated) {
      }
    } catch (err) {
      console.error('[ProjectManager] Init error:', err);
    }
  }

  createProjectInstance(projectPath, customName = null) {
    return this.db.createProjectInstance(projectPath, customName);
  }

  createEmptyProject(name) {
    return this.db.createEmptyProject(name);
  }

  get projects() {
    // Return projects as an object with ID as key
    const allProjects = this.db.getAllProjects();
    const projectsObj = {};

    allProjects.forEach(project => {
      projectsObj[project.id] = project;
    });

    return projectsObj;
  }

  saveProjectNote(projectId, content) {
    this.db.updateProjectNotes(projectId, content);
  }

  saveProjectActions(projectId, actions) {
    this.db.saveQuickActions(projectId, actions);
  }

  saveProjectTabs(projectId, tabs, forceCleanup = false) {
    this.db.saveTabs(projectId, tabs, forceCleanup);
  }

  saveProjectMetadata(projectId, metadata) {
    this.db.updateProjectMetadata(projectId, metadata);
  }

  deleteProject(projectId) {
    return this.db.deleteProject(projectId);
  }

  saveGeminiPrompt(projectId, prompt) {
    this.db.updateProjectMetadata(projectId, { geminiPrompt: prompt });
  }

  // Gemini history methods
  saveGeminiHistory(projectId, selectedText, prompt, response) {
    return this.db.saveGeminiHistory(projectId, selectedText, prompt, response);
  }

  getGeminiHistory(projectId, limit = 50) {
    return this.db.getGeminiHistory(projectId, limit);
  }

  deleteGeminiHistoryItem(historyId) {
    this.db.deleteGeminiHistoryItem(historyId);
  }

  // Global commands methods
  getGlobalCommands() {
    return this.db.getGlobalCommands();
  }

  saveGlobalCommands(commands) {
    this.db.saveGlobalCommands(commands);
  }

  // Prompts methods
  getPrompts() {
    return this.db.getPrompts();
  }

  savePrompts(prompts) {
    this.db.savePrompts(prompts);
  }

  // Tab history methods
  archiveTab(projectId, tab) {
    this.db.archiveTab(projectId, tab);
  }

  getTabHistory(projectId, limit) {
    return this.db.getTabHistory(projectId, limit);
  }

  clearTabHistory(projectId) {
    this.db.clearTabHistory(projectId);
  }
}

module.exports = new ProjectManager();
