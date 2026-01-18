const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');
const hljs = require('highlight.js');

// --- State ---
// Multi-Project Support: Each project has its own set of terminals
const openProjects = new Map(); // projectId -> { project, tabs: Map(), activeTabId, tabCounter }
let activeProjectId = null;
let isRenamingTab = false;

// Dashboard State
let projects = {}; // All known projects

// UI State
let isResizing = false;

// Constants
const FLUSH_DELAY = 10;
const MAX_BUFFER_SIZE = 4096;

// --- DOM Elements ---
// Views
const dashboardView = document.getElementById('dashboard-view');
const workspaceView = document.getElementById('workspace-view');

// Title Bar & Project Chips
const homeChip = document.getElementById('home-chip');
const newProjectChip = document.getElementById('new-project-chip');
const projectChipsContainer = document.getElementById('project-chips-container');

// Dashboard
const projectsList = document.getElementById('projects-list');
const commandsSettingsList = document.getElementById('commands-settings-list'); // New
const projectDetailsPanel = document.getElementById('project-details-panel');
const dashTitle = document.getElementById('dash-project-title');
const dashPath = document.getElementById('dash-project-path');
const dashNotes = document.getElementById('dash-project-notes');
const btnOpenProject = document.getElementById('btn-open-project');
const btnNewProject = document.getElementById('btn-new-project');
const dashEmptyState = document.getElementById('dashboard-empty-state');

// Selected project on dashboard (not necessarily active in workspace)
let dashboardSelectedProject = null;

// Workspace
const tabsList = document.getElementById('tabs-list');
const terminalContainer = document.getElementById('terminal-container');
const newTabBtn = document.getElementById('new-tab-btn');
const resizer = document.getElementById('resizer');
const notesPanel = document.getElementById('notes-panel');

// File Explorer
const fileExplorer = document.getElementById('file-explorer');
const fileTreeContainer = document.getElementById('file-tree');
const closeExplorerBtn = document.getElementById('close-explorer');

// File Preview Overlay
const filePreviewOverlay = document.getElementById('file-preview-overlay');
const filePreviewTitle = document.getElementById('file-preview-title');
const filePreviewContent = document.getElementById('file-preview-content');
const closePreviewBtn = document.getElementById('close-preview-btn');

// Notes Panel
const notesTabs = document.querySelectorAll('.note-tab');
const notesContentSession = document.getElementById('notes-content-session');
const notesContentProject = document.getElementById('notes-content-project');
const notesContentGemini = document.getElementById('notes-content-gemini'); // New
const notesContentActions = document.getElementById('notes-content-actions');
const notesEditor = document.getElementById('notes-editor'); // Session notes
const notesViewerProject = document.getElementById('notes-viewer-project'); // Read-only project notes
const actionsList = document.getElementById('actions-list');
const saveStatus = document.querySelector('.save-status');

// --- Initialization ---

async function init() {
  await document.fonts.ready; // Wait for fonts

  // Setup Global Listeners
  setupGlobalListeners();
  setupDashboardTabs(); // New
  
  // Load Projects
  await loadProjects();
  
  // Start on Dashboard
  showDashboard();
}

function setupDashboardTabs() {
  const dashBtns = document.querySelectorAll('.dash-nav-btn');
  const highlight = document.getElementById('dash-nav-highlight');

  // Function to move the highlight pill
  const updateHighlight = (targetBtn) => {
    if (!targetBtn || !highlight) return;
    // Calculate position relative to the container
    const left = targetBtn.offsetLeft;
    const width = targetBtn.offsetWidth;
    
    highlight.style.transform = `translateX(${left}px)`;
    highlight.style.width = `${width}px`;
  };

  // Initial position
  const activeBtn = document.querySelector('.dash-nav-btn.active');
  if (activeBtn) {
    // Wait for layout to ensure correct metrics
    requestAnimationFrame(() => updateHighlight(activeBtn));
  }

  dashBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Update active state
      dashBtns.forEach(b => {
        b.classList.remove('active');
        b.classList.remove('text-white');
        b.classList.add('text-[#888]');
      });
      btn.classList.add('active');
      btn.classList.add('text-white');
      btn.classList.remove('text-[#888]');

      // Move highlight
      updateHighlight(btn);

      const target = btn.dataset.dashTab; // projects, settings
      document.querySelectorAll('.dash-global-content').forEach(content => {
        content.classList.remove('active');
        // Ensure hidden is toggled for Tailwind
        content.classList.add('hidden');
      });

      const targetContent = document.getElementById(`dash-global-${target}`);
      if (targetContent) {
        targetContent.classList.add('active');
        targetContent.classList.remove('hidden');
      }

      if (target === 'settings') {
        renderCommandsSettings();
      }
    });
  });
  
  // Update on resize to fix positions
  window.addEventListener('resize', () => {
    const currentActive = document.querySelector('.dash-nav-btn.active');
    if (currentActive) updateHighlight(currentActive);
  });
}

function renderCommandsSettings() {
  if (!dashboardSelectedProject) {
    commandsSettingsList.innerHTML = '<p class="placeholder-text">Выберите проект в списке слева, чтобы настроить его команды.</p>';
    return;
  }

  const proj = dashboardSelectedProject;
  commandsSettingsList.innerHTML = '';

  if (!proj.quickActions || proj.quickActions.length === 0) {
    commandsSettingsList.innerHTML = '<p class="placeholder-text">У этого проекта нет доступных команд.</p>';
    return;
  }

  proj.quickActions.forEach((action, index) => {
    const item = document.createElement('div');
    item.className = 'bg-[#2d2d2d] p-3 rounded-md border border-border-main';
    
    // We only want to edit the "prompt" part of the command if it exists
    // For now, let's allow editing the full command string
    item.innerHTML = `
      <label class="block text-[11px] text-accent mb-1 uppercase font-bold">Команда: ${action.name}</label>
      <div class="font-bold mb-2 text-[#eee]">Исполняемая строка в терминале:</div>
      <textarea class="bg-[#111] border border-[#444] text-[#ddd] p-2 font-jetbrains text-xs w-full box-border rounded resize-y min-h-[60px] focus:outline-none focus:border-accent" data-index="${index}">${action.command}</textarea>
    `;

    const textarea = item.querySelector('textarea');
    textarea.addEventListener('input', () => {
      // Update local state
      proj.quickActions[index].command = textarea.value;
      
      // Save to backend
      ipcRenderer.invoke('project:save-actions', {
        dirPath: proj.path,
        actions: proj.quickActions
      });
      
      // Update sidebar if this project is currently active
      const openProj = openProjects.get(proj.id);
      if (openProj) {
        openProj.project.quickActions = proj.quickActions;
        renderActions(proj.quickActions);
      }
    });

    commandsSettingsList.appendChild(item);
  });
}

// --- Dashboard Logic ---

async function loadProjects() {
  console.log('[loadProjects] START');

  try {
    // Get CWD from main process (process.cwd() doesn't work in renderer!)
    const cwd = await ipcRenderer.invoke('app:getCwd');
    console.log('[loadProjects] CWD:', cwd);

    // Fetch project data for CWD to register it
    const project = await ipcRenderer.invoke('project:get', cwd);
    console.log('[loadProjects] Project loaded:', project);

    if (project) {
      projects[cwd] = project;
      console.log('[loadProjects] Projects object:', projects);
    }

    renderProjectList();
  } catch (err) {
    console.error('[loadProjects] ERROR:', err);
  }
}

async function handleAddNewProject() {
  try {
    const project = await ipcRenderer.invoke('project:select-directory');
    if (project) {
      // Add to our local list
      projects[project.path] = project;
      renderProjectList();
      // Optionally select it immediately
      selectProjectOnDashboard(project);
    }
  } catch (err) {
    console.error('Failed to add project:', err);
  }
}

function renderProjectList() {
  console.log('[renderProjectList] START');
  
  const listEl = document.getElementById('projects-list');
  if (!listEl) {
    console.warn('[renderProjectList] projects-list element not found in DOM yet.');
    return;
  }

  // Clear list
  listEl.innerHTML = '';

  // Create "New Project" button manually
  const newBtn = document.createElement('div');
  newBtn.className = 'project-card bg-transparent border border-dashed border-[#555] p-[10px_15px] mb-2 rounded cursor-pointer transition-colors opacity-70 hover:opacity-100 hover:border-accent text-center';
  newBtn.innerHTML = '<span>+ New Project</span>';
  newBtn.addEventListener('click', handleAddNewProject);

  // Render project cards
  const projectsArray = Object.values(projects);
  projectsArray.forEach(proj => {
    const card = document.createElement('div');
    card.className = 'project-card bg-tab p-[10px_15px] mb-2 rounded cursor-pointer transition-colors hover:bg-[#3a3a3c]';
    if (dashboardSelectedProject && dashboardSelectedProject.path === proj.path) {
      card.classList.add('active');
    }
    card.innerHTML = `
      <div style="font-weight:bold">${proj.name}</div>
    `;
    // Single click - select project
    card.onclick = () => selectProjectOnDashboard(proj);
    // Double click - open workspace
    card.ondblclick = () => openWorkspace(proj);
    listEl.appendChild(card);
  });

  listEl.appendChild(newBtn);
  console.log('[renderProjectList] DONE');
}

function selectProjectOnDashboard(project) {
  dashboardSelectedProject = project; // Store for settings tab

  // Update UI cards active state
  document.querySelectorAll('.project-card').forEach(card => {
    card.classList.remove('active');
    // Check if this card's text matches the project path
    if (card.innerHTML.includes(project.path)) {
      card.classList.add('active');
    }
  });

  dashEmptyState.style.display = 'none';
  projectDetailsPanel.style.display = 'flex';

  dashTitle.textContent = project.name;
  dashPath.textContent = project.path;
  dashNotes.innerHTML = project.notes.global;

  // If we are already on Settings tab, re-render them
  if (document.querySelector('.dash-nav-btn[data-dash-tab="settings"]').classList.contains('active')) {
    renderCommandsSettings();
  }

  // Setup 'Open' button
  btnOpenProject.onclick = () => openWorkspace(project);
  
  // Auto-save dashboard notes changes
  dashNotes.oninput = () => {
    ipcRenderer.invoke('project:save-note', {
      dirPath: project.path,
      content: dashNotes.innerHTML
    });
    // Update local cache
    project.notes.global = dashNotes.innerHTML;
  };
}

function showDashboard() {
  console.log('[showDashboard]');
  workspaceView.style.display = 'none';
  dashboardView.style.display = 'flex';

  // Update chips: hide new project chip, deactivate all
  newProjectChip.style.display = 'none';
  document.querySelectorAll('.project-chip').forEach(chip => {
    chip.classList.remove('active');
  });

  activeProjectId = null;
}

function renderProjectChips() {
  console.log('[renderProjectChips] Open projects:', openProjects.size, 'Active:', activeProjectId);

  // Remove old project chips (keep home and new buttons)
  const existingChips = projectChipsContainer.querySelectorAll('.project-chip:not(#home-chip):not(#new-project-chip)');
  existingChips.forEach(chip => chip.remove());

  // Deactivate home chip
  homeChip.classList.remove('active');

  // Add chips for each open project
  openProjects.forEach((projectData, projectId) => {
    const chip = document.createElement('button');
    chip.className = 'project-chip group flex items-center gap-1 px-3 py-0.5 rounded-xl text-xs bg-tab border border-border-main hover:bg-[#3a3a3c] hover:border-accent transition-all duration-150 no-drag h-[22px] text-text-main';
    chip.dataset.projectId = projectId;

    if (projectId === activeProjectId) {
      chip.classList.add('active');
      chip.classList.add('!bg-accent', '!border-accent', '!text-white');
    }

    chip.innerHTML = `<span class="project-indicator w-2 h-2 rounded-full bg-[#4a9eff]"></span>${projectData.project.name}`;
    chip.onclick = () => switchToProject(projectId);

    // Insert before the "+" button
    projectChipsContainer.insertBefore(chip, newProjectChip);
  });

  // Show "+" button if we have open projects
  if (openProjects.size > 0) {
    newProjectChip.style.display = 'flex';
  }
}

// --- Workspace Logic ---

// Save current tabs state to backend
async function saveProjectTabs() {
  const projectData = getCurrentProject();
  if (!projectData) return;

  const tabsState = Array.from(projectData.tabs.values()).map(tabData => ({
    name: tabData.name,
    cwd: projectData.project.path // For now all tabs use project path
  }));

  await ipcRenderer.invoke('project:save-tabs', {
    dirPath: projectData.project.path,
    tabs: tabsState
  });

  console.log('[saveProjectTabs] Saved tabs:', tabsState);
}

function openWorkspace(project) {
  console.log('[openWorkspace] Opening project:', project.name);
  const projectId = project.id;

  // Check if project is already open
  if (!openProjects.has(projectId)) {
    console.log('[openWorkspace] Creating new project instance');
    // Initialize project state
    openProjects.set(projectId, {
      project,
      tabs: new Map(),
      activeTabId: null,
      tabCounter: 0,
      sessionNotes: {}
    });
  }

  // Switch to this project
  switchToProject(projectId);
}

function switchToProject(projectId) {
  console.log('[switchToProject] Switching to:', projectId);

  if (activeProjectId === projectId && workspaceView.style.display === 'flex') {
    return;
  }

  const projectData = openProjects.get(projectId);
  if (!projectData) {
    console.error('[switchToProject] Project not found:', projectId);
    return;
  }

  activeProjectId = projectId;

  // Show workspace
  dashboardView.style.display = 'none';
  workspaceView.style.display = 'flex';

  // Update Project Notes in Sidebar (Read-only view)
  notesViewerProject.innerHTML = projectData.project.notes.global;

  // Render Actions
  renderActions(projectData.project.quickActions || []);

  // Update chips
  renderProjectChips();

  // Update File Explorer if visible
  if (fileExplorer.style.display !== 'none') {
    renderFileTree(projectData.project.path, fileTreeContainer);
  }

  // Restore tabs from saved state or create default tab
  if (projectData.tabs.size === 0) {
    const savedTabs = projectData.project.tabs || [];

    if (savedTabs.length > 0) {
      // Restore saved tabs sequentially
      console.log('[switchToProject] Restoring', savedTabs.length, 'saved tabs');
      (async () => {
        for (const savedTab of savedTabs) {
          await createTab(savedTab.cwd || projectData.project.path);
          // Rename last created tab to saved name
          const lastTabId = `${projectId}-tab-${projectData.tabCounter}`;
          const tab = projectData.tabs.get(lastTabId);
          if (tab && savedTab.name) {
            tab.name = savedTab.name;
            tab.element.querySelector('.tab-name').textContent = savedTab.name;
          }
        }
        // After all tabs restored, render them
        renderTabsForProject(projectId);
      })();
    } else {
      // Create default tab if no saved tabs
      createTab(projectData.project.path).then(() => {
        renderTabsForProject(projectId);
      });
    }
  } else {
    // Hide/show tabs based on current project
    renderTabsForProject(projectId);

    // Switch to active tab or first available
    const tabToActivate = projectData.activeTabId || Array.from(projectData.tabs.keys())[0];
    if (tabToActivate) {
      // Force switch to ensure visibility
      const currentActive = projectData.activeTabId;
      projectData.activeTabId = null;
      switchTab(tabToActivate);
    }
  }
}

function renderTabsForProject(projectId) {
  console.log('[renderTabsForProject] Called for:', projectId);
  const projectData = openProjects.get(projectId);
  if (!projectData) {
    console.error('[renderTabsForProject] No project data!');
    return;
  }

  console.log('[renderTabsForProject] Current project has', projectData.tabs.size, 'tabs');

  // Hide all tabs from all projects
  let hiddenCount = 0;
  openProjects.forEach((pd, pdId) => {
    pd.tabs.forEach(tabData => {
      tabData.element.style.display = 'none';
      tabData.wrapper.style.display = 'none';
      tabData.wrapper.classList.remove('active');
      hiddenCount++;
    });
  });
  console.log('[renderTabsForProject] Hidden', hiddenCount, 'tabs total');

  // Show only tab buttons from current project
  let shownCount = 0;
  projectData.tabs.forEach((tabData, tabId) => {
    console.log('[renderTabsForProject] Showing tab:', tabId, tabData.name);
    tabData.element.style.display = 'flex';
    shownCount++;
  });
  console.log('[renderTabsForProject] Shown', shownCount, 'tabs for current project');
}

// --- Terminal & Tabs Logic ---

// Helper: Get current project data
function getCurrentProject() {
  if (!activeProjectId) return null;
  return openProjects.get(activeProjectId);
}

async function createTab(cwd) {
  const projectData = getCurrentProject();
  if (!projectData) {
    console.error('[createTab] No active project!');
    return;
  }

  // Use project-specific tab IDs to avoid conflicts
  const tabId = `${activeProjectId}-tab-${++projectData.tabCounter}`;
  console.log('[createTab] Creating tab:', tabId, 'for project:', projectData.project.name);

  // 1. Terminal Instance
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrainsMono NF', monospace",
    lineHeight: 1.2,
    allowTransparency: true,
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4'
    }
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  
  try {
    const webgl = new WebglAddon();
    terminal.loadAddon(webgl);
  } catch (e) { console.warn('WebGL not available'); }

  // 2. DOM Elements
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper absolute inset-0 pl-1 pt-1 hidden';
  wrapper.id = `term-wrap-${tabId}`;
  terminalContainer.appendChild(wrapper);
  
  terminal.open(wrapper);

  // Right click handler for context menu
  wrapper.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hasSelection = terminal.hasSelection();
    ipcRenderer.send('show-terminal-context-menu', hasSelection);
  });

  const tabEl = createTabElement(tabId, `Tab ${projectData.tabCounter}`);
  tabsList.insertBefore(tabEl, newTabBtn); // Insert before "+" button

  // 3. Store State in project
  projectData.tabs.set(tabId, {
    terminal,
    fitAddon,
    element: tabEl,
    wrapper,
    name: `Tab ${projectData.tabCounter}`,
    writeBuffer: '',
    pendingWrite: null
  });

  // 4. Initialize Session Notes
  projectData.sessionNotes[tabId] = "";

  // 5. Backend Process
  console.log('[createTab] Calling terminal:create with tabId:', tabId);
  const result = await ipcRenderer.invoke('terminal:create', {
    tabId,  // ← Передаем tabId!
    rows: terminal.rows,
    cols: terminal.cols,
    cwd: cwd || projectData.project.path
  });
  console.log('[createTab] PTY created, result:', result);

  // 6. Hook Events
  terminal.onData(data => {
    console.log('[terminal.onData] tabId:', tabId, 'data:', data.substring(0, 10));
    ipcRenderer.send('terminal:input', tabId, data);
  });

  terminal.onResize(size => {
    console.log('[terminal.onResize] tabId:', tabId);
    ipcRenderer.send('terminal:resize', tabId, size.cols, size.rows);
  });

  // Switch to it
  switchTab(tabId);

  // Save tabs state
  saveProjectTabs();
}

function createTabElement(tabId, name) {
  const el = document.createElement('div');
  el.className = 'tab h-full px-[15px] flex items-center bg-tab border-r border-border-main text-[#999] text-[13px] cursor-pointer max-w-[200px] min-w-[100px] relative select-none hover:text-white group';
  el.innerHTML = `
    <span class="tab-name whitespace-nowrap overflow-hidden text-ellipsis mr-2 pointer-events-auto">${name}</span>
    <span class="tab-close w-4 h-4 rounded-full flex items-center justify-center text-[10px] opacity-0 transition-opacity group-hover:opacity-70 hover:!bg-[#cc3333] hover:!text-white hover:!opacity-100">×</span>
  `;
  
  const nameSpan = el.querySelector('.tab-name');

  // Click to switch (but not if we're renaming)
  el.addEventListener('click', (e) => {
    if (isRenamingTab) return;
    switchTab(tabId);
  });
  
  // Close button
  el.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tabId);
  });

  // Rename on double click
  nameSpan.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRenamingTab(tabId, nameSpan);
  });
  
  return el;
}

function switchTab(tabId) {
  const projectData = getCurrentProject();
  if (!projectData || isRenamingTab) return;

  if (projectData.activeTabId === tabId) {
    // Even if it's the same tab, make sure it's visible
    const tab = projectData.tabs.get(tabId);
    if (tab && tab.wrapper.style.display !== 'block') {
      tab.wrapper.style.display = 'block';
      tab.wrapper.classList.add('active');
      tab.fitAddon.fit();
    }
    return;
  }

  // 1. Save current notes
  if (projectData.activeTabId) {
    projectData.sessionNotes[projectData.activeTabId] = notesEditor.innerText;
    const prevTab = projectData.tabs.get(projectData.activeTabId);
    if (prevTab) {
      prevTab.element.classList.remove('active');
      prevTab.wrapper.style.display = 'none';
      prevTab.wrapper.classList.remove('active');
    }
  }

  // 2. Activate new
  projectData.activeTabId = tabId;
  const nextTab = projectData.tabs.get(tabId);
  if (nextTab) {
    nextTab.element.classList.add('active');
    nextTab.wrapper.style.display = 'block';
    nextTab.wrapper.classList.add('active');

    // Restore notes
    notesEditor.innerText = projectData.sessionNotes[tabId] || "";

    // Fit and focus
    requestAnimationFrame(() => {
      try {
        nextTab.fitAddon.fit();
        nextTab.terminal.focus();
      } catch (e) {
        console.warn('Could not fit/focus terminal:', e);
      }
    });
  }
}

function closeTab(tabId) {
  const projectData = getCurrentProject();
  if (!projectData) return;

  const tab = projectData.tabs.get(tabId);
  if (!tab) return;

  // Cleanup DOM
  tab.element.remove();
  tab.wrapper.remove();
  tab.terminal.dispose();

  // Cleanup State
  projectData.tabs.delete(tabId);
  delete projectData.sessionNotes[tabId];

  // Kill Process
  ipcRenderer.send('terminal:kill', tabId);

  if (projectData.activeTabId === tabId) {
    projectData.activeTabId = null;
    const remaining = Array.from(projectData.tabs.keys());
    if (remaining.length > 0) switchTab(remaining[remaining.length - 1]);
  }

  // Save tabs state
  saveProjectTabs();
}

function startRenamingTab(tabId, nameSpan) {
  if (isRenamingTab) return;
  
  const oldName = nameSpan.textContent;
  isRenamingTab = true;
  nameSpan.contentEditable = true;
  nameSpan.classList.add('editing');
  
  // Select all text
  const range = document.createRange();
  range.selectNodeContents(nameSpan);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  
  nameSpan.focus();
  
  const finish = () => {
    if (!isRenamingTab) return;
    isRenamingTab = false;
    nameSpan.contentEditable = false;
    nameSpan.classList.remove('editing');
    
    const newName = nameSpan.textContent.trim();
    if (newName === "") {
      nameSpan.textContent = oldName;
    }

    // Update state in project
    const projectData = getCurrentProject();
    if (projectData) {
      const tab = projectData.tabs.get(tabId);
      if (tab) {
        tab.name = nameSpan.textContent;
        // Save tabs state after rename
        saveProjectTabs();
      }
    }
  };

  nameSpan.addEventListener('blur', finish, { once: true });
  nameSpan.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') {
      e.preventDefault();
      nameSpan.blur();
    }
    if (e.code === 'Escape') {
      nameSpan.textContent = oldName;
      nameSpan.blur();
    }
  });
}

// --- Sidebar Logic ---

function setupGlobalListeners() {
  // Home Chip - return to dashboard
  homeChip.addEventListener('click', showDashboard);

  // New Project Chip - return to dashboard to select another project
  newProjectChip.addEventListener('click', handleAddNewProject);
  
  // New Tab
  newTabBtn.addEventListener('click', () => createTab());

  // Close File Explorer
  closeExplorerBtn.addEventListener('click', () => {
    fileExplorer.style.display = 'none';
    handleResize();
  });

  // Close File Preview
  closePreviewBtn.addEventListener('click', () => {
    closeFilePreview();
  });

  // Cmd + \ Shortcut for File Explorer (works with any keyboard layout)
  window.addEventListener('keydown', (e) => {
    if (e.metaKey && e.code === 'Backslash') {
      e.preventDefault();
      toggleFileExplorer();
    }
    // Escape to close file preview (works with any keyboard layout)
    if (e.code === 'Escape' && filePreviewOverlay.style.display === 'flex') {
      e.preventDefault();
      closeFilePreview();
    }
  });

  // Sidebar Tabs
  notesTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      // UI Toggle
      notesTabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const target = btn.dataset.tab; // session, project, actions
      
      // Hide all contents
      notesContentSession.classList.remove('active');
      notesContentProject.classList.remove('active');
      notesContentGemini.classList.remove('active'); // Added
      notesContentActions.classList.remove('active');
      
      // Show target
      if (target === 'session') notesContentSession.classList.add('active');
      if (target === 'project') notesContentProject.classList.add('active');
      if (target === 'gemini') notesContentGemini.classList.add('active'); // Added
      if (target === 'actions') notesContentActions.classList.add('active');
    });
  });

  // Resizer
  resizer.addEventListener('mousedown', initResize);
  
  // Global Resize
  window.addEventListener('resize', handleResize);
  
  // Notes Auto-Save Simulation
  notesEditor.addEventListener('input', () => {
    saveStatus.classList.add('saving');
    saveStatus.textContent = 'Saving...';

    const projectData = getCurrentProject();
    if (projectData && projectData.activeTabId) {
      projectData.sessionNotes[projectData.activeTabId] = notesEditor.innerText;
    }

    clearTimeout(window.saveTimeout);
    window.saveTimeout = setTimeout(() => {
      saveStatus.classList.remove('saving');
      saveStatus.classList.add('saved');
      saveStatus.textContent = 'Saved';
      setTimeout(() => saveStatus.classList.remove('saved'), 1000);
    }, 500);
  });
  
  // IPC Data handler is at the bottom of file
}

function initResize(e) {
  isResizing = true;
  document.body.style.cursor = 'col-resize';
  
  const moveHandler = (e) => {
    if (!isResizing) return;
    const width = document.body.clientWidth - e.clientX;
    if (width > 150 && width < 600) {
      notesPanel.style.width = `${width}px`;
      handleResize(); // Refit terminals
    }
  };
  
  const upHandler = () => {
    isResizing = false;
    document.body.style.cursor = 'default';
    window.removeEventListener('mousemove', moveHandler);
    window.removeEventListener('mouseup', upHandler);
  };
  
  window.addEventListener('mousemove', moveHandler);
  window.addEventListener('mouseup', upHandler);
}

function handleResize() {
  const projectData = getCurrentProject();
  if (!projectData) return;

  if (projectData.activeTabId && projectData.tabs.has(projectData.activeTabId)) {
    const tab = projectData.tabs.get(projectData.activeTabId);
    try {
      tab.fitAddon.fit();
    } catch(e) {}
  }
}

// --- Gemini API Integration ---
const GEMINI_API_KEY = 'REDACTED_GEMINI_KEY';
const geminiHistoryContainer = document.getElementById('gemini-history');

async function researchWithGemini(forcedText = null) {
  const projectData = getCurrentProject();
  if (!projectData || !projectData.activeTabId) return;

  const tab = projectData.tabs.get(projectData.activeTabId);
  if (!tab || !tab.terminal) return;

  const selectedText = forcedText || tab.terminal.getSelection();
  if (!selectedText) {
    alert('Сначала выделите текст в терминале!');
    return;
  }

  // Switch to Gemini Tab to show progress
  document.querySelector('[data-tab="gemini"]').click();

  const historyItem = document.createElement('div');
  historyItem.className = 'history-item bg-[#2d2d2d] border-l-[3px] border-l-[#eebb00] p-2.5 rounded opacity-70';
  historyItem.innerHTML = `
    <div class="history-query text-[11px] text-[#888] mb-1 font-jetbrains">🔍 ${selectedText.substring(0, 50)}${selectedText.length > 50 ? '...' : ''}</div>
    <div class="history-response text-[13px] text-[#ddd] leading-[1.4] whitespace-pre-wrap">Gemini is thinking...</div>
  `;
  
  if (geminiHistoryContainer.querySelector('.placeholder-text')) {
    geminiHistoryContainer.innerHTML = '';
  }
  geminiHistoryContainer.prepend(historyItem);

  const prompt = `вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ${selectedText}`;

  try {
    console.log('[Gemini API] Requesting with prompt:', prompt);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const data = await response.json();
    console.log('[Gemini API] Full Response:', data);

    if (data.error) {
      throw new Error(data.error.message || 'Unknown API Error');
    }

    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      console.error('[Gemini API] Unexpected response structure:', data);
      throw new Error('API returned empty or blocked response (Check safety settings or quota)');
    }

    const resultText = data.candidates[0].content.parts[0].text;

    // Update UI
    historyItem.classList.remove('opacity-70', 'border-l-[#eebb00]');
    historyItem.classList.add('border-l-accent');
    historyItem.querySelector('.history-response').textContent = resultText;

    // Copy to clipboard
    await navigator.clipboard.writeText(resultText);
    
    saveStatus.classList.remove('saving');
    saveStatus.classList.add('saved');
    saveStatus.textContent = 'Copied to clipboard!';
    setTimeout(() => saveStatus.classList.remove('saved'), 2000);
    
  } catch (err) {
    console.error('Gemini API Error:', err);
    historyItem.classList.remove('opacity-70', 'border-l-[#eebb00]');
    historyItem.classList.add('border-l-[#cc3333]');
    historyItem.querySelector('.history-response').textContent = `Error: ${err.message}`;
    
    saveStatus.textContent = 'Gemini Error';
    saveStatus.classList.remove('saving');
  }
}

// Handle Context Menu from Main Process
ipcRenderer.on('context-menu-command', (e, cmd) => {
  if (cmd === 'gemini-research') {
    researchWithGemini();
  }
});

function renderActions(actions) {
  console.log('[renderActions] START, actions:', actions);
  actionsList.innerHTML = '';

  if (!actions || !actions.length) {
    actionsList.innerHTML = '<p class="placeholder-text">No actions defined.</p>';
    return;
  }

  actions.forEach(act => {
    const btn = document.createElement('div');
    btn.className = 'action-btn bg-[#333] border border-[#444] text-[#ddd] p-2 text-left cursor-pointer rounded text-xs flex items-center hover:bg-[#444] hover:border-[#555]';
    btn.innerHTML = `<span class="mr-2 text-sm">⚡</span> ${act.name}`;
    btn.onclick = () => runAction(act.command);
    actionsList.appendChild(btn);
  });
}

function runAction(cmd) {
  console.log('[runAction] CMD:', cmd);

  const projectData = getCurrentProject();
  if (!projectData) {
    console.error('[runAction] No active project!');
    return;
  }

  const activeTabId = projectData.activeTabId;
  console.log('[runAction] activeTabId:', activeTabId);

  if (!activeTabId) {
    console.error('[runAction] No active tab!');
    return;
  }

  const tab = projectData.tabs.get(activeTabId);
  console.log('[runAction] Tab:', tab);

  if (tab && tab.terminal) {
    console.log('[runAction] Executing command via IPC...');
    // Отправляем команду напрямую в PTY с Enter
    ipcRenderer.send('terminal:executeCommand', activeTabId, cmd);
    tab.terminal.focus();
    console.log('[runAction] Command sent!');
  } else {
    console.error('[runAction] Terminal not found!');
  }
}

// Removed duplicate createTab function

// --- File Explorer Logic ---

// File Preview Functions
async function openFilePreview(filePath) {
  try {
    const fileName = path.basename(filePath);
    const fileExt = path.extname(filePath).toLowerCase();
    filePreviewTitle.textContent = filePath;
    filePreviewContent.innerHTML = '<div class="text-[#666] text-center py-4">Loading...</div>';

    // Hide all terminal wrappers when showing preview
    const projectData = getCurrentProject();
    if (projectData) {
      projectData.tabs.forEach(tabData => {
        tabData.wrapper.style.display = 'none';
      });
    }

    // Hide notes panel and resizer
    notesPanel.style.display = 'none';
    resizer.style.display = 'none';

    // Position overlay to start after file-explorer if visible
    if (fileExplorer.style.display !== 'none') {
      filePreviewOverlay.style.left = '250px'; // Width of file-explorer
    } else {
      filePreviewOverlay.style.left = '0';
    }

    filePreviewOverlay.style.display = 'flex';
    filePreviewOverlay.style.pointerEvents = 'auto';

    // Read file content via IPC
    const result = await ipcRenderer.invoke('file:read', filePath);

    if (result.success) {
      // Determine language for syntax highlighting
      const language = detectLanguage(fileExt);

      if (language) {
        // Apply syntax highlighting
        try {
          const highlighted = hljs.highlight(result.content, {
            language,
            ignoreIllegals: true
          });

          // Create code block with line numbers
          const lines = highlighted.value.split('\n');
          const lineNumberWidth = String(lines.length).length;

          const codeHTML = lines.map((line, index) => {
            const lineNum = String(index + 1).padStart(lineNumberWidth, ' ');
            return `<div class="flex hover:bg-white/5">
              <span class="inline-block text-right pr-4 text-[#666] select-none min-w-[3ch] shrink-0">${lineNum}</span>
              <span class="flex-1">${line || ' '}</span>
            </div>`;
          }).join('');

          filePreviewContent.innerHTML = `<pre class="!m-0 !p-0 !bg-transparent"><code class="hljs language-${language} !block !p-0 !bg-transparent">${codeHTML}</code></pre>`;
        } catch (e) {
          console.warn('Syntax highlighting failed:', e);
          filePreviewContent.textContent = result.content;
        }
      } else {
        // Plain text for unknown file types
        filePreviewContent.textContent = result.content;
      }
    } else {
      filePreviewContent.innerHTML = `<div class="text-[#cc3333] p-4">Error reading file: ${result.error}</div>`;
    }
  } catch (error) {
    console.error('Error opening file preview:', error);
    filePreviewContent.innerHTML = `<div class="text-[#cc3333] p-4">Error: ${error.message}</div>`;
  }
}

// Detect programming language by file extension
function detectLanguage(ext) {
  const languageMap = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.json': 'json',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.py': 'python',
    '.rb': 'ruby',
    '.java': 'java',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.go': 'go',
    '.rs': 'rust',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.fish': 'bash',
    '.sql': 'sql',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.md': 'markdown',
    '.txt': null,
    '.log': null
  };

  return languageMap[ext] || null;
}

function closeFilePreview() {
  filePreviewOverlay.style.display = 'none';
  filePreviewOverlay.style.pointerEvents = 'none';
  filePreviewContent.textContent = '';
  filePreviewTitle.textContent = '';

  // Restore notes panel and resizer
  notesPanel.style.display = 'flex';
  resizer.style.display = 'block';

  // Restore active terminal wrapper
  const projectData = getCurrentProject();
  if (projectData && projectData.activeTabId) {
    const activeTab = projectData.tabs.get(projectData.activeTabId);
    if (activeTab) {
      activeTab.wrapper.style.display = 'block';
      activeTab.wrapper.classList.add('active');
      // Refit terminal
      requestAnimationFrame(() => {
        try {
          activeTab.fitAddon.fit();
          activeTab.terminal.focus();
        } catch (e) {
          console.warn('Could not fit/focus terminal:', e);
        }
      });
    }
  }
}

function toggleFileExplorer() {
  if (workspaceView.style.display === 'none') return;

  if (fileExplorer.style.display === 'none') {
    fileExplorer.style.display = 'flex';
    const projectData = getCurrentProject();
    if (projectData) {
      renderFileTree(projectData.project.path, fileTreeContainer);
    }
  } else {
    fileExplorer.style.display = 'none';
  }
  handleResize();
}

async function renderFileTree(dirPath, container, level = 0) {
  if (level === 0) container.innerHTML = '';

  try {
    const files = await fs.promises.readdir(dirPath);
    
    // Sort: directories first, then files
    const itemPromises = files.map(async (file) => {
      const fullPath = path.join(dirPath, file);
      try {
        const stats = await fs.promises.stat(fullPath);
        return {
          name: file,
          path: fullPath,
          isDirectory: stats.isDirectory()
        };
      } catch (e) {
        return null; // Skip files we can't stat
      }
    });

    const items = (await Promise.all(itemPromises))
      .filter(item => item !== null)
      .sort((a, b) => {
        if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
        return a.isDirectory ? -1 : 1;
      });

    items.forEach(item => {
      if (item.name === '.git' || item.name === 'node_modules' || item.name === '.DS_Store') return;

      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item flex items-center py-1 cursor-pointer text-[#ccc] gap-1 whitespace-nowrap font-jetbrains text-xs hover:bg-white/5 group';
      itemEl.style.paddingLeft = `${level * 16 + 8}px`;

      // Chevron for folders (expand/collapse indicator)
      const chevron = document.createElement('span');
      chevron.className = 'chevron shrink-0 w-3 text-center text-[10px] transition-transform';

      if (item.isDirectory) {
        chevron.textContent = '▶';
      } else {
        // Empty space for files to align with folders
        chevron.innerHTML = '&nbsp;';
      }

      const icon = document.createElement('span');
      icon.className = 'icon shrink-0 w-4 text-center text-sm';
      icon.textContent = item.isDirectory ? '📁' : '📄';

      const name = document.createElement('span');
      name.className = 'name flex-1 overflow-hidden text-ellipsis ml-1';
      name.textContent = item.name;

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-path-btn shrink-0 ml-1 opacity-0 bg-[#333] border border-[#444] text-[#888] text-[9px] px-1 rounded uppercase group-hover:opacity-100 hover:bg-[#555] hover:text-white';
      copyBtn.textContent = 'Copy Path';
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(item.path);
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => copyBtn.textContent = originalText, 1000);
      };

      itemEl.appendChild(chevron);
      itemEl.appendChild(icon);
      itemEl.appendChild(name);
      itemEl.appendChild(copyBtn);

      container.appendChild(itemEl);

      if (item.isDirectory) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-folder-children';
        childrenContainer.style.display = 'none';
        container.appendChild(childrenContainer);

        itemEl.onclick = () => {
          if (childrenContainer.style.display === 'none') {
            // Expand
            childrenContainer.style.display = 'block';
            chevron.textContent = '▼';
            chevron.style.transform = 'rotate(0deg)';
            icon.textContent = '📂';
            if (childrenContainer.innerHTML === '') {
              renderFileTree(item.path, childrenContainer, level + 1);
            }
          } else {
            // Collapse
            childrenContainer.style.display = 'none';
            chevron.textContent = '▶';
            icon.textContent = '📁';
          }
        };
      } else {
        // File click handler - open preview
        itemEl.onclick = () => {
          openFilePreview(item.path);
        };
      }
    });
  } catch (err) {
    console.error('Error reading directory:', err);
  }
}

// Global Data Handler
ipcRenderer.on('terminal:data', (e, { pid, tabId, data }) => {
  console.log('[terminal:data] received for tabId:', tabId, 'length:', data.length);

  // Find which project owns this tab
  let tab = null;
  for (const [projId, projectData] of openProjects) {
    if (projectData.tabs.has(tabId)) {
      tab = projectData.tabs.get(tabId);
      break;
    }
  }

  if (!tab) {
    console.error('[terminal:data] Tab not found:', tabId);
    return;
  }

  // Buffered Write
  tab.writeBuffer += data;
  if (!tab.pendingWrite) {
    tab.pendingWrite = setTimeout(() => {
      tab.terminal.write(tab.writeBuffer);
      tab.writeBuffer = '';
      tab.pendingWrite = null;
    }, FLUSH_DELAY);
  }
});

// Run Init
init();