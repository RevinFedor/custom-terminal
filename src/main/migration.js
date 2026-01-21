const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const DatabaseManager = require('./database');

/**
 * Migration script to transfer data from projects.json to SQLite database
 * Run this once to migrate existing data
 */
function migrateFromJSON() {
  const userDataPath = app.getPath('userData');
  const jsonPath = path.join(userDataPath, 'projects.json');

  // Check if JSON file exists
  if (!fs.existsSync(jsonPath)) {
    return;
  }

  try {
    const jsonData = fs.readFileSync(jsonPath, 'utf-8');
    const projects = JSON.parse(jsonData);


    const db = new DatabaseManager();

    let migratedCount = 0;
    let errorCount = 0;

    // Migrate each project
    for (const [projectPath, projectData] of Object.entries(projects)) {
      try {

        // Insert project
        const projectId = projectData.id || Buffer.from(projectPath).toString('base64');

        db.db.prepare(`
          INSERT OR REPLACE INTO projects (id, path, name, description, gemini_prompt, notes_global)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          projectId,
          projectPath,
          projectData.name || path.basename(projectPath),
          projectData.description || '',
          projectData.geminiPrompt || 'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ',
          projectData.notes?.global || ''
        );

        // Migrate quick actions
        if (projectData.quickActions && Array.isArray(projectData.quickActions)) {
          const insertAction = db.db.prepare(`
            INSERT INTO quick_actions (project_id, name, command, position)
            VALUES (?, ?, ?, ?)
          `);

          projectData.quickActions.forEach((action, index) => {
            insertAction.run(projectId, action.name, action.command, index);
          });

        }

        // Migrate tabs
        if (projectData.tabs && Array.isArray(projectData.tabs)) {
          const insertTab = db.db.prepare(`
            INSERT INTO tabs (project_id, name, cwd, position)
            VALUES (?, ?, ?, ?)
          `);

          projectData.tabs.forEach((tab, index) => {
            insertTab.run(
              projectId,
              tab.name || `Tab ${index + 1}`,
              tab.cwd || projectPath,
              index
            );
          });

        }

        migratedCount++;
      } catch (err) {
        errorCount++;
        console.error(`  ✗ Error migrating project ${projectPath}:`, err.message);
      }
    }

    db.close();


    // Backup the old JSON file
    const backupPath = path.join(userDataPath, `projects.json.backup-${Date.now()}`);
    fs.copyFileSync(jsonPath, backupPath);

  } catch (err) {
    console.error('[Migration] Fatal error during migration:', err);
    throw err;
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  // For testing, we need to initialize electron app
  if (!app.isReady()) {
    app.on('ready', () => {
      migrateFromJSON();
      setTimeout(() => app.quit(), 1000);
    });
  } else {
    migrateFromJSON();
  }
}

module.exports = { migrateFromJSON };
