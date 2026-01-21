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

  getProject(dirPath) {
    let project = this.db.getProject(dirPath);

    // If project doesn't exist, create it
    if (!project) {
      project = this.db.createProject(dirPath);
    }

    return project;
  }

  get projects() {
    // Return projects as an object with path as key (for compatibility)
    const allProjects = this.db.getAllProjects();
    const projectsObj = {};

    allProjects.forEach(project => {
      projectsObj[project.path] = project;
    });

    return projectsObj;
  }

  saveProjectNote(dirPath, content) {
    this.db.updateProjectNotes(dirPath, content);
  }

  saveProjectActions(dirPath, actions) {
    this.db.saveQuickActions(dirPath, actions);
  }

  saveProjectTabs(dirPath, tabs) {
    this.db.saveTabs(dirPath, tabs);
  }

  saveProjectMetadata(dirPath, metadata) {
    this.db.updateProjectMetadata(dirPath, metadata);
  }

  saveGeminiPrompt(dirPath, prompt) {
    this.db.updateProjectMetadata(dirPath, { geminiPrompt: prompt });
  }

  // Gemini history methods
  saveGeminiHistory(dirPath, selectedText, prompt, response) {
    return this.db.saveGeminiHistory(dirPath, selectedText, prompt, response);
  }

  getGeminiHistory(dirPath, limit = 50) {
    return this.db.getGeminiHistory(dirPath, limit);
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
}

module.exports = new ProjectManager();
