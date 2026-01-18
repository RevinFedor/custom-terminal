const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ProjectManager {
  constructor() {
    this.userDataPath = app.getPath('userData');
    this.projectsFilePath = path.join(this.userDataPath, 'projects.json');
    this.projects = {};
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(this.projectsFilePath)) {
        const data = fs.readFileSync(this.projectsFilePath, 'utf-8');
        this.projects = JSON.parse(data);
      } else {
        this.projects = {};
        this.save();
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
      this.projects = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(this.projectsFilePath, JSON.stringify(this.projects, null, 2));
    } catch (err) {
      console.error('Failed to save projects:', err);
    }
  }

  getProject(dirPath) {
    // Normalize path to avoid / vs \ issues and trailing slashes
    const normalizedPath = path.resolve(dirPath);

    // Migration: Add tabs field to old projects
    if (this.projects[normalizedPath] && !this.projects[normalizedPath].tabs) {
      this.projects[normalizedPath].tabs = [];
      this.save();
    }

    if (!this.projects[normalizedPath]) {
      // Initialize new project if it doesn't exist
      const folderName = path.basename(normalizedPath);
      this.projects[normalizedPath] = {
        id: Buffer.from(normalizedPath).toString('base64'),
        path: normalizedPath,
        name: folderName,
        notes: {
          global: `<h1>${folderName}</h1><p>Project notes go here...</p>`,
          sessions: [] // History of session summaries
        },
        quickActions: [
          {
            name: "gemini (прочитать docs)",
            command: "gemini 'Прочитай всю документацию в папке docs и в корне проекта, чтобы понять архитектуру. Не отвечай пока я не спрошу.'"
          },
          {
            name: "claude (прочитать docs)",
            command: "claude 'Прочитай всю документацию в папке docs и в корне проекта, чтобы понять архитектуру. Не отвечай пока я не спрошу.'"
          },
          {
            name: "📂 List Project Files",
            command: "ls -lah"
          }
        ],
        tabs: [] // Saved tabs state: [{ name: "Tab 1", cwd: "/path" }]
      };
      this.save();
    }
    return this.projects[normalizedPath];
  }

  saveProjectNote(dirPath, noteContent) {
    const normalizedPath = path.resolve(dirPath);
    if (this.projects[normalizedPath]) {
      this.projects[normalizedPath].notes.global = noteContent;
      this.save();
    }
  }

  saveProjectActions(dirPath, actions) {
    const normalizedPath = path.resolve(dirPath);
    if (this.projects[normalizedPath]) {
      this.projects[normalizedPath].quickActions = actions;
      this.save();
    }
  }

  saveProjectTabs(dirPath, tabs) {
    const normalizedPath = path.resolve(dirPath);
    if (this.projects[normalizedPath]) {
      this.projects[normalizedPath].tabs = tabs;
      this.save();
    }
  }
}

module.exports = new ProjectManager();
