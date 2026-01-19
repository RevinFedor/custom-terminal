const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { WebglAddon } = require('@xterm/addon-webgl');
const { SerializeAddon } = require('@xterm/addon-serialize');
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
const commandsSettingsList = document.getElementById('commands-settings-list');
// Old elements removed in redesign:
// const projectsList = document.getElementById('projects-list');
// const projectDetailsPanel = document.getElementById('project-details-panel');
// const dashTitle = document.getElementById('dash-project-title');
// const dashPath = document.getElementById('dash-project-path');
// const dashNotes = document.getElementById('dash-project-notes');
// const btnOpenProject = document.getElementById('btn-open-project');
// const dashEmptyState = document.getElementById('dashboard-empty-state');

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
const notesContentGemini = document.getElementById('notes-content-gemini');
const notesContentActions = document.getElementById('notes-content-actions');
const notesContentSessions = document.getElementById('notes-content-sessions');
const notesEditor = document.getElementById('notes-editor'); // Session notes
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

  // Auto-open favorite projects (DISABLED - causes lag on startup)
  // await autoOpenFavoriteProjects();

  // Start on Dashboard
  showDashboard();
}

// Auto-open specified projects on startup
async function autoOpenFavoriteProjects() {
  const favoriteProjects = [
    { name: 'custom-terminal', path: '/Users/fedor/Desktop/custom-terminal' },
    { name: 'cli-tools', path: '/Users/fedor/Desktop/cli-tools' }
  ];

  for (const favorite of favoriteProjects) {
    // Try to find by name first
    let project = Object.values(projects).find(p => p.name === favorite.name);

    // If not found by name, try to load by path
    if (!project) {
      console.log('[autoOpenFavoriteProjects] Project not found by name, loading:', favorite.name);
      try {
        project = await ipcRenderer.invoke('project:get', favorite.path);
        if (project) {
          projects[project.path] = project;
        }
      } catch (err) {
        console.error('[autoOpenFavoriteProjects] Failed to load project:', favorite.name, err);
      }
    }

    if (project) {
      console.log('[autoOpenFavoriteProjects] Opening:', favorite.name);
      openWorkspace(project);
    } else {
      console.log('[autoOpenFavoriteProjects] Project not found:', favorite.name);
    }
  }

  // Re-render project list after loading new projects
  renderProjectList();
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
        renderPromptsSettings();
      }
    });
  });
  
  // Update on resize to fix positions
  window.addEventListener('resize', () => {
    const currentActive = document.querySelector('.dash-nav-btn.active');
    if (currentActive) updateHighlight(currentActive);
  });
}

// populateSettingsProjectSelect removed - commands are now global

let commandsSaveTimeout = null;

async function renderCommandsSettings() {
  commandsSettingsList.innerHTML = '';

  // Load global commands
  const result = await ipcRenderer.invoke('commands:get-global');

  if (!result.success) {
    commandsSettingsList.innerHTML = '<p class="placeholder-text text-[#cc3333] text-center mt-5 text-xs">Error loading global commands.</p>';
    return;
  }

  const globalCommands = result.data;

  if (!globalCommands || globalCommands.length === 0) {
    commandsSettingsList.innerHTML = '<p class="text-[#666] text-sm">No commands yet. Click "Add Command" to create one.</p>';
    return;
  }

  globalCommands.forEach((action, index) => {
    const item = document.createElement('div');
    item.className = 'group bg-[#2d2d2d] px-6 py-5 rounded-lg border-2 border-border-main hover:border-accent/50 transition-all relative';

    item.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-3">
        <input type="text" class="command-name-input bg-transparent border-none text-white font-bold text-base flex-1 outline-none focus:text-accent transition-colors" value="${action.name}" placeholder="Command name..." />
        <button class="delete-btn opacity-0 group-hover:opacity-100 text-[#888] hover:text-red-500 text-xl transition-all px-2" title="Delete command">×</button>
      </div>
      <textarea class="command-textarea bg-[#1a1a1a] border-2 border-[#444] text-[#ddd] p-4 font-jetbrains text-xs w-full box-border rounded-md resize-y min-h-[90px] focus:outline-none focus:border-accent transition-colors" placeholder="Enter terminal command...">${action.command}</textarea>
    `;

    const nameInput = item.querySelector('.command-name-input');
    const textarea = item.querySelector('.command-textarea');
    const deleteBtn = item.querySelector('.delete-btn');

    const saveCommands = () => {
      globalCommands[index].name = nameInput.value.trim() || `Command ${index + 1}`;
      globalCommands[index].command = textarea.value;

      // Debounce save
      clearTimeout(commandsSaveTimeout);
      commandsSaveTimeout = setTimeout(async () => {
        await ipcRenderer.invoke('commands:save-global', globalCommands);
        showToast('Commands saved');

        // Update all open projects
        openProjects.forEach(projectData => {
          projectData.project.quickActions = globalCommands.map(gc => ({
            name: gc.name,
            command: gc.command
          }));

          if (projectData.project.id === activeProjectId) {
            renderActions(projectData.project.quickActions);
          }
        });
      }, 800);
    };

    deleteBtn.addEventListener('click', async () => {
      if (confirm(`Delete command "${action.name}"?`)) {
        globalCommands.splice(index, 1);
        await ipcRenderer.invoke('commands:save-global', globalCommands);
        showToast('Command deleted');
        renderCommandsSettings();

        // Update all open projects
        openProjects.forEach(projectData => {
          projectData.project.quickActions = globalCommands.map(gc => ({
            name: gc.name,
            command: gc.command
          }));
          if (projectData.project.id === activeProjectId) {
            renderActions(projectData.project.quickActions);
          }
        });
      }
    });

    nameInput.addEventListener('input', saveCommands);
    textarea.addEventListener('input', saveCommands);

    commandsSettingsList.appendChild(item);
  });
}

let promptsSaveTimeout = null;

async function renderPromptsSettings() {
  const promptsList = document.getElementById('prompts-settings-list');
  if (!promptsList) return;

  promptsList.innerHTML = '';

  const result = await ipcRenderer.invoke('prompts:get');

  if (!result.success) {
    promptsList.innerHTML = '<p class="text-[#cc3333] text-sm">Error loading prompts.</p>';
    return;
  }

  const prompts = result.data;

  if (!prompts || prompts.length === 0) {
    promptsList.innerHTML = '<p class="text-[#666] text-sm">No prompts yet. Click "Add Prompt" to create one.</p>';
    return;
  }

  prompts.forEach((prompt, index) => {
    const item = document.createElement('div');
    item.className = 'group bg-[#2d2d2d] px-6 py-5 rounded-lg border-2 border-border-main hover:border-accent/50 transition-all relative';

    item.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-3">
        <input type="text" class="prompt-title-input bg-transparent border-none text-white font-bold text-base flex-1 outline-none focus:text-accent transition-colors" value="${prompt.title}" placeholder="Prompt title..." />
        <button class="delete-btn opacity-0 group-hover:opacity-100 text-[#888] hover:text-red-500 text-xl transition-all px-2" title="Delete prompt">×</button>
      </div>
      <textarea class="prompt-content-textarea bg-[#1a1a1a] border-2 border-[#444] text-[#ddd] p-4 font-jetbrains text-xs w-full box-border rounded-md resize-y min-h-[120px] focus:outline-none focus:border-accent transition-colors" placeholder="Prompt content...">${prompt.content}</textarea>
      <div class="text-[10px] text-[#666] mt-2 italic">This text will be inserted when selected from context menu</div>
    `;

    const titleInput = item.querySelector('.prompt-title-input');
    const contentTextarea = item.querySelector('.prompt-content-textarea');
    const deleteBtn = item.querySelector('.delete-btn');

    const savePrompts = () => {
      prompts[index].title = titleInput.value.trim() || `Prompt ${index + 1}`;
      prompts[index].content = contentTextarea.value;

      // Debounce save
      clearTimeout(promptsSaveTimeout);
      promptsSaveTimeout = setTimeout(async () => {
        await ipcRenderer.invoke('prompts:save', prompts);
        showToast('Prompts saved');
      }, 800);
    };

    deleteBtn.addEventListener('click', async () => {
      if (confirm(`Delete prompt "${prompt.title}"?`)) {
        prompts.splice(index, 1);
        await ipcRenderer.invoke('prompts:save', prompts);
        showToast('Prompt deleted');
        renderPromptsSettings();
      }
    });

    titleInput.addEventListener('input', savePrompts);
    contentTextarea.addEventListener('input', savePrompts);

    promptsList.appendChild(item);
  });
}

// --- Toast Notifications ---

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg backdrop-blur-sm transform transition-all duration-300 ease-out opacity-0 translate-x-4 ${
    type === 'success' ? 'bg-[#22c55e]/90 text-white' :
    type === 'error' ? 'bg-[#ef4444]/90 text-white' :
    'bg-[#3b82f6]/90 text-white'
  }`;

  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';

  toast.innerHTML = `
    <span class="text-lg font-bold">${icon}</span>
    <span class="text-sm font-medium">${message}</span>
  `;

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    });
  });

  // Remove after 2.5 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(4rem)';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// --- Dashboard Logic ---

async function loadProjects() {
  try {
    // Load all saved projects
    const allProjects = await ipcRenderer.invoke('project:list');

    // Build projects object
    allProjects.forEach(project => {
      projects[project.path] = project;
    });

    // Also ensure CWD is registered (if it's not a system directory)
    const cwd = await ipcRenderer.invoke('app:getCwd');

    // Don't auto-load system directories as projects
    const isSystemDir = cwd === '/' ||
                       cwd === '/Users/fedor' ||
                       cwd === '/Users' ||
                       cwd === '/Users/fedor/Desktop';

    if (!isSystemDir) {
      const cwdProject = await ipcRenderer.invoke('project:get', cwd);
      if (cwdProject) {
        projects[cwd] = cwdProject;
      }
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

  const gridEl = document.getElementById('projects-grid');
  if (!gridEl) {
    console.warn('[renderProjectList] projects-grid element not found in DOM yet.');
    return;
  }

  // Clear grid
  gridEl.innerHTML = '';

  // Filter projects
  const excludedNames = ['Fedor', 'Desktop', 'Documents', 'Downloads', 'Applications'];
  const projectsArray = Object.values(projects).filter(proj => {
    // Filter out projects with empty names
    if (!proj.name || proj.name.trim() === '') {
      console.log('[renderProjectList] Filtering out: empty name, path:', proj.path);
      return false;
    }

    // Filter out excluded names
    if (excludedNames.includes(proj.name)) {
      console.log('[renderProjectList] Filtering out:', proj.name);
      return false;
    }

    // Filter out root and system directories
    const isSystemDir = proj.path === '/' ||
                       proj.path === '/Users/fedor' ||
                       proj.path === '/Users' ||
                       proj.path === '/Users/fedor/Desktop';
    if (isSystemDir) {
      console.log('[renderProjectList] Filtering out system dir:', proj.path);
      return false;
    }

    return true;
  });

  // Render project cards
  projectsArray.forEach(proj => {
    const card = createProjectCard(proj);
    gridEl.appendChild(card);
  });

  // Add "New Project" card
  const newCard = document.createElement('div');
  newCard.className = 'bg-transparent border-2 border-dashed border-[#555] p-6 rounded-xl cursor-pointer transition-all opacity-70 hover:opacity-100 hover:border-accent flex items-center justify-center min-h-[200px]';
  newCard.innerHTML = '<span class="text-xl">+ New Project</span>';
  newCard.onclick = handleAddNewProject;
  gridEl.appendChild(newCard);

  // Adjust tooltip positions for rightmost cards
  requestAnimationFrame(() => {
    adjustTooltipPositions();
  });

  console.log('[renderProjectList] DONE');
}

function adjustTooltipPositions() {
  const cards = document.querySelectorAll('.project-card-item');
  if (cards.length === 0) return;

  // Get grid container width and card positions
  cards.forEach((card, index) => {
    const rect = card.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const spaceOnRight = viewportWidth - rect.right;

    // If less than 300px space on right, open tooltip to the left
    const tooltipWrapper = card.querySelector('.info-icon-wrapper');
    if (tooltipWrapper && spaceOnRight < 300) {
      const tooltipContainer = tooltipWrapper.querySelector('.tooltip-container');
      if (tooltipContainer) {
        // Change position from left to right
        tooltipContainer.classList.remove('left-0');
        tooltipContainer.classList.add('right-0');

        // Change origin from bottom-left to bottom-right
        const tooltipInner = tooltipContainer.querySelector('div');
        if (tooltipInner) {
          tooltipInner.classList.remove('origin-bottom-left');
          tooltipInner.classList.add('origin-bottom-right');
        }
      }
    }

    // Show tooltip container (was hidden initially)
    const tooltipContainer = card.querySelector('.tooltip-container');
    if (tooltipContainer) {
      tooltipContainer.classList.remove('hidden');
    }
  });
}

function createProjectCard(proj) {
  // Count active tabs for this project
  const projectData = openProjects.get(proj.id);
  const activeTabsCount = projectData ? projectData.tabs.size : 0;

  const card = document.createElement('div');
  card.className = 'group bg-tab border border-border-main rounded-xl p-6 cursor-pointer transition-all hover:border-accent hover:shadow-lg relative project-card-item';
  card.dataset.projectId = proj.id;

  card.innerHTML = `
    <div class="flex justify-between items-start mb-3">
      <div class="flex items-center gap-2 flex-1 mr-2 min-w-0">
        <h3 class="text-lg font-bold text-white truncate">${proj.name}</h3>
        ${proj.description ? `
          <span class="relative group/desc inline-block info-icon-wrapper shrink-0">
            <span class="text-xs text-[#aaa] cursor-help hover:text-white transition-colors">ℹ️</span>
            <div class="tooltip-container absolute bottom-full left-0 mb-2 pointer-events-none z-50 hidden">
              <div class="origin-bottom-left opacity-0 scale-x-0 scale-y-[0.85]
                group-hover/desc:opacity-100 group-hover/desc:scale-x-100 group-hover/desc:scale-y-100
                transition-all duration-200 ease-out
                bg-gray-900/95 backdrop-blur-sm border border-gray-700
                p-3 rounded-xl shadow-2xl w-64 whitespace-normal">
                <p class="text-xs text-gray-300">${proj.description}</p>
              </div>
            </div>
          </span>
        ` : ''}
      </div>
      <div class="opacity-0 group-hover:opacity-100 transition-opacity relative shrink-0">
        <button class="menu-btn text-[#999] hover:text-white text-xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-white/10" data-project-id="${proj.id}">⋯</button>
        <div class="menu-dropdown absolute right-0 top-full mt-1 bg-panel border border-border-main rounded-lg shadow-xl hidden min-w-[150px] z-10">
          <button class="edit-btn w-full text-left px-4 py-2 text-sm text-[#ccc] hover:bg-white/5 rounded-t-lg" data-project-id="${proj.id}">✏️ Edit</button>
          <button class="delete-btn w-full text-left px-4 py-2 text-sm text-[#cc3333] hover:bg-[#cc3333]/10 rounded-b-lg" data-project-id="${proj.id}">🗑️ Delete</button>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-2 mb-3">
      <span class="text-xs font-jetbrains text-[#666] truncate flex-1">${proj.path}</span>
    </div>

    <div class="flex items-center justify-between text-xs text-[#888]">
      <span>${activeTabsCount} active tab${activeTabsCount !== 1 ? 's' : ''}</span>
      <span class="text-accent">Click to open →</span>
    </div>
  `;

  // Click to open workspace (but not if clicking menu or info icon)
  card.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-btn') &&
        !e.target.closest('.menu-dropdown') &&
        !e.target.closest('.info-icon-wrapper')) {
      openWorkspace(proj);
    }
  });

  // Setup menu toggle
  const menuBtn = card.querySelector('.menu-btn');
  const menuDropdown = card.querySelector('.menu-dropdown');

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close other menus
    document.querySelectorAll('.menu-dropdown').forEach(m => {
      if (m !== menuDropdown) m.classList.add('hidden');
    });
    menuDropdown.classList.toggle('hidden');
  });

  // Edit button
  card.querySelector('.edit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menuDropdown.classList.add('hidden');
    openEditModal(proj);
  });

  // Delete button
  card.querySelector('.delete-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menuDropdown.classList.add('hidden');
    deleteProject(proj);
  });

  return card;
}

// Close menus when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.menu-dropdown').forEach(m => m.classList.add('hidden'));
});

// Modal management
let currentEditingProject = null;

function openEditModal(project) {
  currentEditingProject = project;
  const modal = document.getElementById('edit-project-modal');
  const nameInput = document.getElementById('edit-project-name');
  const descInput = document.getElementById('edit-project-description');

  nameInput.value = project.name;
  descInput.value = project.description || '';

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  nameInput.focus();
}

function closeEditModal() {
  const modal = document.getElementById('edit-project-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  currentEditingProject = null;
}

async function saveProjectEdit() {
  if (!currentEditingProject) return;

  const nameInput = document.getElementById('edit-project-name');
  const descInput = document.getElementById('edit-project-description');

  const newName = nameInput.value.trim();
  const newDesc = descInput.value.trim();

  if (!newName) {
    alert('Project name cannot be empty');
    return;
  }

  // Save to backend
  await ipcRenderer.invoke('project:save-metadata', {
    dirPath: currentEditingProject.path,
    metadata: {
      name: newName,
      description: newDesc
    }
  });

  // Update local cache
  currentEditingProject.name = newName;
  currentEditingProject.description = newDesc;
  projects[currentEditingProject.path] = currentEditingProject;

  closeEditModal();
  renderProjectList();
  renderProjectChips();
}

async function deleteProject(project) {
  const confirm = window.confirm(`Are you sure you want to delete "${project.name}"? This cannot be undone.`);
  if (!confirm) return;

  // Close project if it's open
  if (openProjects.has(project.id)) {
    // Close all tabs
    const projectData = openProjects.get(project.id);
    for (const tabId of projectData.tabs.keys()) {
      await ipcRenderer.send('terminal:destroy', tabId);
    }
    openProjects.delete(project.id);
  }

  // Remove from projects list
  delete projects[project.path];

  // TODO: Add backend delete if needed
  // For now just remove from local cache, backend still has it

  renderProjectList();
  renderProjectChips();
}

function selectProjectOnDashboard(project) {
  dashboardSelectedProject = project; // Store for settings tab

  // If we are already on Settings tab, re-render them
  if (document.querySelector('.dash-nav-btn[data-dash-tab="settings"]')?.classList.contains('active')) {
    renderCommandsSettings();
  }
}

function showDashboard() {
  console.log('[showDashboard]');
  workspaceView.style.display = 'none';
  dashboardView.style.display = 'flex';

  // Update chips: hide new project chip, deactivate all project chips
  newProjectChip.style.display = 'none';
  document.querySelectorAll('.project-chip:not(#home-chip):not(#new-project-chip)').forEach(chip => {
    chip.classList.remove('active', '!bg-accent', '!border-accent', '!text-white', 'shadow-lg', 'ring-2', 'ring-accent/50');
  });

  // Activate home chip
  homeChip.classList.add('active', '!bg-accent', '!border-accent', '!text-white');

  activeProjectId = null;
}

function renderProjectChips() {
  // Remove old project chips (keep home and new buttons)
  const existingChips = projectChipsContainer.querySelectorAll('.project-chip:not(#home-chip):not(#new-project-chip)');
  existingChips.forEach(chip => chip.remove());

  // Deactivate home chip
  homeChip.classList.remove('active', '!bg-accent', '!border-accent', '!text-white');

  // Add chips for each open project
  openProjects.forEach((projectData, projectId) => {
    const chip = document.createElement('button');
    chip.className = 'project-chip group flex items-center gap-1 px-3 py-0.5 rounded-xl text-xs bg-tab border border-border-main hover:bg-[#3a3a3c] hover:border-accent transition-all duration-150 no-drag h-[22px] text-text-main cursor-pointer';
    chip.dataset.projectId = projectId;

    if (projectId === activeProjectId) {
      chip.classList.add('active');
      chip.classList.add('!bg-accent', '!border-accent', '!text-white', 'shadow-lg', 'ring-2', 'ring-accent/50');
    }

    const indicatorColor = projectId === activeProjectId ? 'bg-white' : 'bg-[#4a9eff]';
    chip.innerHTML = `
      <span class="project-indicator w-2 h-2 rounded-full ${indicatorColor}"></span>
      <span class="chip-name">${projectData.project.name}</span>
      <span class="chip-close opacity-0 group-hover:opacity-70 hover:!opacity-100 ml-1 text-[10px] w-3 h-3 flex items-center justify-center rounded-full hover:bg-[#cc3333]/20">×</span>
    `;

    // Click to switch project (but not if clicking close button)
    chip.onclick = (e) => {
      if (!e.target.closest('.chip-close')) {
        switchToProject(projectId);
      }
    };

    // Close button
    chip.querySelector('.chip-close').onclick = (e) => {
      e.stopPropagation();
      closeProject(projectId);
    };

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
}

function openWorkspace(project) {
  const projectId = project.id;

  // Check if project is already open
  if (!openProjects.has(projectId)) {
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
  console.time('[PERF] switchToProject total');
  console.log('[switchToProject] START, projectId:', projectId);

  if (activeProjectId === projectId && workspaceView.style.display === 'flex') {
    console.log('[switchToProject] Already active, skipping');
    console.timeEnd('[PERF] switchToProject total');
    return;
  }

  const t0 = performance.now();
  const projectData = openProjects.get(projectId);
  if (!projectData) {
    console.error('[switchToProject] Project not found:', projectId);
    console.timeEnd('[PERF] switchToProject total');
    return;
  }
  console.log(`[switchToProject] Get project data took ${(performance.now() - t0).toFixed(2)}ms`);

  activeProjectId = projectId;

  // Show workspace
  console.log('[switchToProject] Showing workspace');
  const t1 = performance.now();
  dashboardView.style.display = 'none';
  workspaceView.style.display = 'flex';
  console.log(`[switchToProject] Show workspace took ${(performance.now() - t1).toFixed(2)}ms`);

  // Render Actions (only if changed)
  console.log('[switchToProject] Calling renderActions');
  const t2 = performance.now();
  renderActions(projectData.project.quickActions || []);
  console.log(`[switchToProject] renderActions took ${(performance.now() - t2).toFixed(2)}ms`);

  // Update chips
  console.log('[switchToProject] Updating chips');
  const t3 = performance.now();
  renderProjectChips();
  console.log(`[switchToProject] renderProjectChips took ${(performance.now() - t3).toFixed(2)}ms`);

  // Don't load Gemini history here - it blocks UI for 3-6 seconds!
  // It will be loaded lazily when user opens AI tab
  console.log('[switchToProject] Skipping Gemini history (lazy load when AI tab opened)');

  // Update File Explorer only if visible
  console.log('[switchToProject] Checking file explorer');
  const t5 = performance.now();
  if (fileExplorer.style.display !== 'none' && fileExplorer.style.display !== '') {
    renderFileTree(projectData.project.path, fileTreeContainer);
  }
  console.log(`[switchToProject] File explorer check/render took ${(performance.now() - t5).toFixed(2)}ms`);

  console.timeEnd('[PERF] switchToProject total');
  console.log('[switchToProject] END (sync part)');

  // Always create a fresh tab on project open (no restoration)
  if (projectData.tabs.size === 0) {
    console.log('[switchToProject] Creating fresh tab');
    createTab(projectData.project.path).then(() => {
      // Don't call renderTabsForProject here - createTab already calls switchTab
      // which shows the terminal. renderTabsForProject would hide it again!
      console.log('[switchToProject] Tab created and activated');
    });
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
  console.time('[PERF] renderTabsForProject');
  console.log('[renderTabsForProject] START, projectId:', projectId);

  const t0 = performance.now();
  const projectData = openProjects.get(projectId);
  if (!projectData) {
    console.error('[renderTabsForProject] No project data!');
    return;
  }
  console.log(`[renderTabsForProject] Get project data took ${(performance.now() - t0).toFixed(2)}ms`);

  // Hide all tabs from all projects
  console.log('[renderTabsForProject] Hiding all tabs from all projects');
  const t1 = performance.now();
  openProjects.forEach((pd, pdId) => {
    pd.tabs.forEach(tabData => {
      tabData.element.style.display = 'none';
      tabData.element.classList.remove('active');
      tabData.wrapper.classList.add('hidden');
      tabData.wrapper.classList.remove('active');
    });
  });
  console.log(`[renderTabsForProject] Hide all tabs took ${(performance.now() - t1).toFixed(2)}ms`);

  // Show only tab buttons from current project
  console.log('[renderTabsForProject] Showing tabs for current project');
  const t2 = performance.now();
  projectData.tabs.forEach((tabData, tabId) => {
    tabData.element.style.display = 'flex';
  });
  console.log(`[renderTabsForProject] Show current project tabs took ${(performance.now() - t2).toFixed(2)}ms`);

  console.timeEnd('[PERF] renderTabsForProject');
  console.log('[renderTabsForProject] END');
}

// --- Terminal & Tabs Logic ---

// Helper: Get current project data
function getCurrentProject() {
  if (!activeProjectId) return null;
  return openProjects.get(activeProjectId);
}

async function createTab(cwd) {
  console.time(`[PERF] createTab total`);
  console.log('[createTab] START, cwd:', cwd);

  const t0 = performance.now();
  const projectData = getCurrentProject();
  if (!projectData) {
    console.error('[createTab] No active project!');
    return;
  }

  // Use project-specific tab IDs to avoid conflicts
  const tabId = `${activeProjectId}-tab-${++projectData.tabCounter}`;
  console.log('[createTab] Generated tabId:', tabId);
  console.log(`[createTab] Get project data took ${(performance.now() - t0).toFixed(2)}ms`);

  // 1. Terminal Instance
  console.log('[createTab] Creating Terminal instance');
  const t1 = performance.now();
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
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(new WebLinksAddon());

  try {
    const webgl = new WebglAddon();
    terminal.loadAddon(webgl);
  } catch (e) { console.warn('WebGL not available'); }
  console.log(`[createTab] Terminal creation took ${(performance.now() - t1).toFixed(2)}ms`);

  // 2. DOM Elements
  console.log('[createTab] Creating DOM elements');
  const t2 = performance.now();
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper absolute inset-0 pl-1 pt-1 hidden';
  wrapper.id = `term-wrap-${tabId}`;
  terminalContainer.appendChild(wrapper);
  console.log(`[createTab] DOM creation took ${(performance.now() - t2).toFixed(2)}ms`);

  console.log('[createTab] Calling terminal.open()');
  const t3 = performance.now();
  terminal.open(wrapper);
  console.log(`[createTab] terminal.open() took ${(performance.now() - t3).toFixed(2)}ms`);

  // Right click handler for context menu
  wrapper.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const hasSelection = terminal.hasSelection();

    // Get prompts for context menu
    const promptsResult = await ipcRenderer.invoke('prompts:get');
    const prompts = promptsResult.success ? promptsResult.data : [];

    ipcRenderer.send('show-terminal-context-menu', { hasSelection, prompts });
  });

  const tabEl = createTabElement(tabId, `Tab ${projectData.tabCounter}`);
  tabsList.insertBefore(tabEl, newTabBtn); // Insert before "+" button

  // 3. Store State in project
  projectData.tabs.set(tabId, {
    terminal,
    fitAddon,
    serializeAddon,
    element: tabEl,
    wrapper,
    name: `Tab ${projectData.tabCounter}`,
    writeBuffer: '',
    pendingWrite: null,
    lastDataTime: null // Track last data time for active process detection
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

  // 6. Hook Events
  terminal.onData(data => {
    ipcRenderer.send('terminal:input', tabId, data);
  });

  terminal.onResize(size => {
    ipcRenderer.send('terminal:resize', tabId, size.cols, size.rows);
  });

  // Switch to it
  console.log('[createTab] Switching to new tab');
  const t7 = performance.now();
  switchTab(tabId);
  console.log(`[createTab] switchTab took ${(performance.now() - t7).toFixed(2)}ms`);

  // Save tabs state
  saveProjectTabs();

  console.timeEnd(`[PERF] createTab total`);
  console.log('[createTab] END');
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
    console.log('[TAB CLICK] Clicked on tab:', tabId);
    if (isRenamingTab) {
      console.log('[TAB CLICK] BLOCKED: Currently renaming');
      return;
    }
    console.log('[TAB CLICK] Calling switchTab...');
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
  console.time('[PERF] switchTab total');
  console.log('[switchTab] START, tabId:', tabId);

  const t0 = performance.now();
  const projectData = getCurrentProject();
  console.log(`[switchTab] getCurrentProject took ${(performance.now() - t0).toFixed(2)}ms`);

  if (!projectData || isRenamingTab) {
    console.log('[switchTab] ABORT: no project or renaming');
    return;
  }

  if (projectData.activeTabId === tabId) {
    console.log('[switchTab] Same tab, checking visibility');
    // Even if it's the same tab, make sure it's visible
    const tab = projectData.tabs.get(tabId);
    console.log('[switchTab] Tab data:', tab ? 'exists' : 'NOT FOUND');
    if (tab) {
      console.log('[switchTab] Wrapper classes BEFORE:', tab.wrapper.className);
      console.log('[switchTab] Has hidden class?', tab.wrapper.classList.contains('hidden'));
      if (tab.wrapper.classList.contains('hidden')) {
        console.log('[switchTab] Removing hidden class...');
        tab.wrapper.classList.remove('hidden');
        tab.wrapper.classList.add('active');
        console.log('[switchTab] Wrapper classes AFTER:', tab.wrapper.className);
        tab.fitAddon.fit();
      }
    }
    console.timeEnd('[PERF] switchTab total');
    return;
  }

  // 1. Save current notes
  console.log('[switchTab] Saving current notes');
  const t1 = performance.now();
  if (projectData.activeTabId) {
    projectData.sessionNotes[projectData.activeTabId] = notesEditor.innerText;
    const prevTab = projectData.tabs.get(projectData.activeTabId);
    if (prevTab) {
      prevTab.element.classList.remove('active');
      prevTab.wrapper.classList.add('hidden');
      prevTab.wrapper.classList.remove('active');
    }
  }
  console.log(`[switchTab] Save notes took ${(performance.now() - t1).toFixed(2)}ms`);

  // 2. Activate new
  console.log('[switchTab] Activating new tab');
  const t2 = performance.now();
  projectData.activeTabId = tabId;
  const nextTab = projectData.tabs.get(tabId);
  if (nextTab) {
    nextTab.element.classList.add('active');
    nextTab.wrapper.classList.remove('hidden');
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
  console.log(`[switchTab] Activate took ${(performance.now() - t2).toFixed(2)}ms`);
  console.timeEnd('[PERF] switchTab total');
  console.log('[switchTab] END');
}

function closeTab(tabId, skipConfirmation = false) {
  const projectData = getCurrentProject();
  if (!projectData) return;

  const tab = projectData.tabs.get(tabId);
  if (!tab) return;

  // Check for active processes
  if (!skipConfirmation && hasActiveProcess(tab)) {
    const confirm = window.confirm('This tab has an active process running. Are you sure you want to close it?');
    if (!confirm) return;
  }

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

// Check if tab has active process (heuristic)
function hasActiveProcess(tabData) {
  // Simple heuristic: if terminal has received data in last 2 seconds
  if (!tabData.lastDataTime) return false;
  const timeSinceLastData = Date.now() - tabData.lastDataTime;
  return timeSinceLastData < 2000;
}

// Helper: Check if we're in workspace view
function isInWorkspace() {
  return workspaceView.style.display !== 'none' && workspaceView.style.display !== '';
}

// Handle Cmd+W context-aware close
function handleCloseShortcut() {
  if (isInWorkspace()) {
    // In workspace - close active tab
    const projectData = getCurrentProject();
    if (projectData && projectData.activeTabId) {
      closeTab(projectData.activeTabId);
    }
  } else {
    // On dashboard - close active project chip
    if (activeProjectId) {
      closeProject(activeProjectId);
    }
  }
}

// Close an entire project
async function closeProject(projectId, skipConfirmation = false) {
  const projectData = openProjects.get(projectId);
  if (!projectData) return;

  // Count active processes
  let activeProcessCount = 0;
  projectData.tabs.forEach(tabData => {
    if (hasActiveProcess(tabData)) activeProcessCount++;
  });

  // Confirm if there are active processes
  if (!skipConfirmation && activeProcessCount > 0) {
    const plural = activeProcessCount > 1 ? 's' : '';
    const confirm = window.confirm(
      `Project "${projectData.project.name}" has ${activeProcessCount} active process${plural}. Close anyway?`
    );
    if (!confirm) return;
  }

  // Close all tabs and cleanup
  const tabIds = Array.from(projectData.tabs.keys());
  for (const tabId of tabIds) {
    const tab = projectData.tabs.get(tabId);
    if (tab) {
      // Cleanup DOM
      tab.element.remove();
      tab.wrapper.remove();
      tab.terminal.dispose();

      // Kill PTY process
      ipcRenderer.send('terminal:kill', tabId);
    }
  }

  // Clear all tabs from project data
  projectData.tabs.clear();

  // Remove from open projects
  openProjects.delete(projectId);

  // Update UI
  renderProjectChips();

  // If this was active project, switch to another or go to dashboard
  if (activeProjectId === projectId) {
    const remaining = Array.from(openProjects.keys());
    if (remaining.length > 0) {
      switchToProject(remaining[0]);
    } else {
      showDashboard();
    }
  }
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

  // Edit Modal handlers
  document.getElementById('close-modal-btn')?.addEventListener('click', closeEditModal);
  document.getElementById('cancel-edit-btn')?.addEventListener('click', closeEditModal);
  document.getElementById('save-edit-btn')?.addEventListener('click', saveProjectEdit);

  // Close modal on Escape
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('edit-project-modal');
      if (modal && !modal.classList.contains('hidden')) {
        closeEditModal();
      }
    }
  });

  // Settings project select removed - commands are now global

  // Add Command button
  const addCommandBtn = document.getElementById('add-command-btn');
  if (addCommandBtn) {
    addCommandBtn.addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('commands:get-global');
      if (!result.success) return;

      const commands = result.data;
      commands.push({
        name: `New Command ${commands.length + 1}`,
        command: ''
      });

      await ipcRenderer.invoke('commands:save-global', commands);
      showToast('Command added');
      renderCommandsSettings();
    });
  }

  // Add Prompt button
  const addPromptBtn = document.getElementById('add-prompt-btn');
  if (addPromptBtn) {
    addPromptBtn.addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('prompts:get');
      if (!result.success) return;

      const prompts = result.data;
      prompts.push({
        title: `New Prompt ${prompts.length + 1}`,
        content: ''
      });

      await ipcRenderer.invoke('prompts:save', prompts);
      showToast('Prompt added');
      renderPromptsSettings();
    });
  }

  // Close File Explorer
  closeExplorerBtn.addEventListener('click', () => {
    fileExplorer.style.display = 'none';
    handleResize();
  });

  // Close File Preview
  closePreviewBtn.addEventListener('click', () => {
    closeFilePreview();
  });

  // Global keyboard shortcuts (work with any keyboard layout)
  window.addEventListener('keydown', (e) => {
    // Cmd + \ - Toggle File Explorer
    if (e.metaKey && e.code === 'Backslash') {
      e.preventDefault();
      toggleFileExplorer();
      return;
    }

    // Escape - Close file preview or Gemini modal
    if (e.code === 'Escape') {
      const geminiModal = document.getElementById('gemini-modal');
      if (geminiModal) {
        e.preventDefault();
        geminiModal.remove();
        return;
      }
      if (filePreviewOverlay.style.display === 'flex') {
        e.preventDefault();
        closeFilePreview();
        return;
      }
    }

    // Cmd + T - New Tab (only in workspace)
    if (e.metaKey && e.code === 'KeyT') {
      e.preventDefault();
      if (isInWorkspace()) {
        createTab();
      }
      return;
    }

    // Cmd + W - Close Tab/Project (context-aware)
    if (e.metaKey && e.code === 'KeyW') {
      e.preventDefault();
      handleCloseShortcut();
      return;
    }
  });

  // Sidebar Tabs
  notesTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      // UI Toggle
      notesTabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const target = btn.dataset.tab; // session, gemini, actions, sessions

      // Hide all contents
      notesContentSession.classList.remove('active');
      notesContentGemini.classList.remove('active');
      notesContentActions.classList.remove('active');
      notesContentSessions.classList.remove('active');

      // Show target
      if (target === 'session') notesContentSession.classList.add('active');
      if (target === 'gemini') {
        notesContentGemini.classList.add('active');
        // Lazy load Gemini history only when AI tab is opened
        const projectData = getCurrentProject();
        if (projectData && projectData.project) {
          console.log('[Sidebar] AI tab opened, loading Gemini history...');
          loadGeminiHistory(projectData.project.path);
        }
      }
      if (target === 'actions') notesContentActions.classList.add('active');
      if (target === 'sessions') {
        notesContentSessions.classList.add('active');
        // Auto-refresh sessions list when tab is opened
        refreshSessionsList();
      }
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

async function loadGeminiHistory(projectPath) {
  console.time('[PERF] loadGeminiHistory total');
  console.log('[loadGeminiHistory] START, path:', projectPath);

  try {
    const t0 = performance.now();
    const result = await ipcRenderer.invoke('gemini:get-history', { dirPath: projectPath, limit: 50 });
    console.log(`[loadGeminiHistory] IPC invoke took ${(performance.now() - t0).toFixed(2)}ms`);

    if (result.success && result.data) {
      console.log(`[loadGeminiHistory] Got ${result.data.length} items`);

      // Clear existing history
      const t1 = performance.now();
      geminiHistoryContainer.innerHTML = '';
      console.log(`[loadGeminiHistory] Clear container took ${(performance.now() - t1).toFixed(2)}ms`);

      if (result.data.length === 0) {
        geminiHistoryContainer.innerHTML = '<p class="placeholder-text text-[#555] text-center mt-5 text-xs">No Gemini searches yet. Select text in terminal and right-click to search.</p>';
        document.getElementById('gemini-count').textContent = '0';
        console.timeEnd('[PERF] loadGeminiHistory total');
        return;
      }

      // Render history items (newest first)
      const t2 = performance.now();
      result.data.forEach(item => {
        const timestamp = new Date(item.timestamp * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const charCount = item.selected_text.length;

        const historyItem = document.createElement('div');
        historyItem.className = 'history-item group bg-[#2d2d2d] border-l-2 border-l-accent rounded p-2 transition-all hover:bg-[#333]';
        historyItem.dataset.historyId = item.id;

        historyItem.innerHTML = `
          <div class="flex items-start justify-between gap-2 mb-1">
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <span class="text-[9px] text-[#666] shrink-0">${timestamp}</span>
              <span class="text-[10px] text-[#888] truncate" title="${item.selected_text}">${charCount} chars</span>
            </div>
            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button class="copy-btn text-[#666] hover:text-accent text-xs px-1 rounded hover:bg-white/5 transition-colors" title="Copy response">📋</button>
              <button class="expand-btn text-[#666] hover:text-white text-xs px-1 rounded hover:bg-white/5 transition-colors" title="Show full">⤢</button>
              <button class="delete-btn text-[#666] hover:text-[#cc3333] text-xs px-1 rounded hover:bg-white/5 transition-colors" title="Delete">🗑️</button>
            </div>
          </div>
          <div class="status-text text-[10px] text-accent">✓ Done</div>
        `;

        // Setup copy button
        const copyBtn = historyItem.querySelector('.copy-btn');
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await navigator.clipboard.writeText(item.response);
          copyBtn.textContent = '✓';
          setTimeout(() => copyBtn.textContent = '📋', 1000);
        });

        // Setup expand button
        const expandBtn = historyItem.querySelector('.expand-btn');
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showGeminiModal(item.selected_text, item.prompt, item.response, timestamp);
        });

        // Setup delete button
        const deleteBtn = historyItem.querySelector('.delete-btn');
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const confirm = window.confirm('Delete this search from history?');
          if (confirm) {
            await ipcRenderer.invoke('gemini:delete-history', item.id);
            historyItem.remove();
            updateGeminiCount();
          }
        });

        geminiHistoryContainer.appendChild(historyItem);
      });
      console.log(`[loadGeminiHistory] Render items took ${(performance.now() - t2).toFixed(2)}ms`);

      const t3 = performance.now();
      updateGeminiCount();
      console.log(`[loadGeminiHistory] Update count took ${(performance.now() - t3).toFixed(2)}ms`);
    }
  } catch (err) {
    console.error('[loadGeminiHistory] Error:', err);
  }
  console.timeEnd('[PERF] loadGeminiHistory total');
  console.log('[loadGeminiHistory] END');
}

function updateGeminiCount() {
  const count = geminiHistoryContainer.querySelectorAll('.history-item').length;
  document.getElementById('gemini-count').textContent = count;
}

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

  // Get or create Gemini prompt from project settings
  const geminiPrompt = projectData.project.geminiPrompt ||
    'вот моя проблема нужно чтобы ты понял что за проблема и на reddit поискал обсуждения. Не ограничивайся категориями. Проблема: ';

  const timestamp = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const charCount = selectedText.length;

  const historyItem = document.createElement('div');
  historyItem.className = 'history-item group bg-[#2d2d2d] border-l-2 border-l-[#eebb00] rounded p-2 transition-all hover:bg-[#333]';

  const itemId = `gemini-${Date.now()}`;
  let responseText = '';

  historyItem.innerHTML = `
    <div class="flex items-start justify-between gap-2 mb-1">
      <div class="flex items-center gap-2 min-w-0 flex-1">
        <span class="text-[9px] text-[#666] shrink-0">${timestamp}</span>
        <span class="text-[10px] text-[#888] truncate" title="${selectedText}">${charCount} chars</span>
      </div>
      <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button class="copy-btn text-[#666] hover:text-accent text-xs px-1 rounded hover:bg-white/5 transition-colors" data-id="${itemId}" title="Copy response">📋</button>
        <button class="expand-btn text-[#666] hover:text-white text-xs px-1 rounded hover:bg-white/5 transition-colors" data-id="${itemId}" title="Show full">⤢</button>
        <button class="delete-btn text-[#666] hover:text-[#cc3333] text-xs px-1 rounded hover:bg-white/5 transition-colors" data-id="${itemId}" title="Delete">🗑️</button>
      </div>
    </div>
    <div class="status-text text-[10px] text-[#888] italic">Searching...</div>
  `;

  if (geminiHistoryContainer.querySelector('.placeholder-text')) {
    geminiHistoryContainer.innerHTML = '';
  }
  geminiHistoryContainer.prepend(historyItem);

  // Update counter
  updateGeminiCount();

  const prompt = geminiPrompt + selectedText;

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

    responseText = data.candidates[0].content.parts[0].text;

    // Save to database
    const saveResult = await ipcRenderer.invoke('gemini:save-history', {
      dirPath: projectData.project.path,
      selectedText: selectedText,
      prompt: geminiPrompt,
      response: responseText
    });

    if (saveResult.success) {
      // Store history ID for delete functionality
      historyItem.dataset.historyId = saveResult.data.id;
    }

    // Update UI - success
    historyItem.classList.remove('border-l-[#eebb00]');
    historyItem.classList.add('border-l-accent');
    historyItem.querySelector('.status-text').textContent = '✓ Done';
    historyItem.querySelector('.status-text').classList.remove('italic');
    historyItem.querySelector('.status-text').classList.add('text-accent');

    // Store response in data attribute
    historyItem.dataset.response = responseText;

    // Setup copy button
    const copyBtn = historyItem.querySelector('.copy-btn');
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(responseText);
      copyBtn.textContent = '✓';
      setTimeout(() => copyBtn.textContent = '📋', 1000);
    });

    // Setup expand button
    const expandBtn = historyItem.querySelector('.expand-btn');
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showGeminiModal(selectedText, geminiPrompt, responseText, timestamp);
    });

    // Setup delete button
    const deleteBtn = historyItem.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const confirm = window.confirm('Delete this search from history?');
      if (confirm && historyItem.dataset.historyId) {
        await ipcRenderer.invoke('gemini:delete-history', parseInt(historyItem.dataset.historyId));
        historyItem.remove();
        updateGeminiCount();
      }
    });

  } catch (err) {
    console.error('Gemini API Error:', err);
    historyItem.classList.remove('border-l-[#eebb00]');
    historyItem.classList.add('border-l-[#cc3333]');
    historyItem.querySelector('.status-text').textContent = `✗ ${err.message}`;
    historyItem.querySelector('.status-text').classList.remove('italic');
    historyItem.querySelector('.status-text').classList.add('text-[#cc3333]');
  }
}

function showGeminiModal(selectedText, prompt, response, timestamp) {
  // Create modal overlay inside terminal container
  const modal = document.createElement('div');
  modal.className = 'gemini-modal-overlay absolute inset-0 bg-bg-main z-[90] flex flex-col border border-border-main';
  modal.id = 'gemini-modal';

  modal.innerHTML = `
    <div class="modal-header h-10 bg-tab border-b border-border-main flex items-center justify-between px-4 shrink-0">
      <div class="flex items-center gap-3">
        <h3 class="text-sm font-bold">AI Response</h3>
        <span class="text-[10px] text-[#666]">${timestamp}</span>
      </div>
      <button class="close-modal text-[#999] hover:text-white text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-white/10">×</button>
    </div>

    <div class="modal-content flex-1 overflow-y-auto p-4 flex flex-col gap-3">
      <!-- Selected Text (Collapsible) -->
      <div class="section bg-[#2d2d2d] rounded border border-border-main">
        <button class="section-toggle w-full px-3 py-2 flex items-center justify-between text-left hover:bg-[#333] transition-colors">
          <div class="flex items-center gap-2">
            <span class="toggle-icon text-xs transition-transform">▶</span>
            <span class="text-xs font-bold text-accent uppercase">Selected Text</span>
            <span class="text-[10px] text-[#666]">${selectedText.length} chars</span>
          </div>
        </button>
        <div class="section-content hidden px-3 pb-3">
          <div class="p-2 bg-[#1e1e1e] rounded font-jetbrains text-xs text-[#ccc] whitespace-pre-wrap max-h-[200px] overflow-y-auto">${selectedText}</div>
        </div>
      </div>

      <!-- Prompt -->
      <div class="section bg-[#2d2d2d] rounded border border-border-main p-3">
        <p class="text-[10px] text-[#888] uppercase mb-2">Prompt Template:</p>
        <div class="p-2 bg-[#1e1e1e] rounded font-jetbrains text-xs text-[#ddd] whitespace-pre-wrap">${prompt}</div>
      </div>

      <!-- Response -->
      <div class="section bg-[#2d2d2d] rounded border border-accent p-3 flex-1">
        <div class="flex items-center justify-between mb-2">
          <p class="text-[10px] text-accent uppercase font-bold">AI Response:</p>
          <button class="copy-response text-[10px] text-[#666] hover:text-accent px-2 py-1 rounded hover:bg-white/5 transition-colors">📋 Copy</button>
        </div>
        <div class="response-text p-2 bg-[#1e1e1e] rounded font-jetbrains text-sm text-[#eee] leading-relaxed whitespace-pre-wrap">${response}</div>
      </div>
    </div>

    <div class="modal-footer p-3 border-t border-border-main flex gap-2 justify-end shrink-0 bg-panel">
      <button class="close-modal px-4 py-2 bg-transparent border border-border-main rounded text-[#ccc] hover:bg-white/5 text-sm">Close</button>
    </div>
  `;

  // Append to terminal container
  terminalContainer.appendChild(modal);

  // Toggle collapsible section
  const toggleBtn = modal.querySelector('.section-toggle');
  const toggleIcon = modal.querySelector('.toggle-icon');
  const sectionContent = modal.querySelector('.section-content');

  toggleBtn.addEventListener('click', () => {
    const isHidden = sectionContent.classList.contains('hidden');
    if (isHidden) {
      sectionContent.classList.remove('hidden');
      toggleIcon.style.transform = 'rotate(90deg)';
    } else {
      sectionContent.classList.add('hidden');
      toggleIcon.style.transform = 'rotate(0deg)';
    }
  });

  // Close handlers
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });

  // Copy handler
  modal.querySelector('.copy-response').addEventListener('click', async () => {
    await navigator.clipboard.writeText(response);
    const btn = modal.querySelector('.copy-response');
    const originalText = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => btn.textContent = originalText, 1000);
  });
}

// Handle Context Menu from Main Process
ipcRenderer.on('context-menu-command', (e, cmd, data) => {
  if (cmd === 'gemini-research') {
    researchWithGemini();
  } else if (cmd === 'insert-prompt') {
    // Insert prompt text into active terminal
    const projectData = getCurrentProject();
    if (projectData && projectData.activeTabId) {
      const tab = projectData.tabs.get(projectData.activeTabId);
      if (tab && tab.terminal) {
        tab.terminal.paste(data);
        tab.terminal.focus();
      }
    }
  }
});

function renderActions(actions) {
  console.time('[PERF] renderActions total');
  console.log('[renderActions] START, actions count:', actions?.length || 0);
  console.log('[renderActions] Full actions:', actions);

  const t0 = performance.now();
  actionsList.innerHTML = '';
  console.log(`[renderActions] Clear list took ${(performance.now() - t0).toFixed(2)}ms`);

  if (!actions || !actions.length) {
    actionsList.innerHTML = '<p class="placeholder-text">No actions defined.</p>';
    console.timeEnd('[PERF] renderActions total');
    console.log('[renderActions] END (no actions)');
    return;
  }

  const t1 = performance.now();
  actions.forEach(act => {
    const btn = document.createElement('div');
    btn.className = 'action-btn bg-[#333] border border-[#444] text-[#ddd] p-2 text-left cursor-pointer rounded text-xs flex items-center hover:bg-[#444] hover:border-[#555]';
    btn.innerHTML = `<span class="mr-2 text-sm">⚡</span> ${act.name}`;
    btn.onclick = () => runAction(act.command);
    actionsList.appendChild(btn);
  });
  console.log(`[renderActions] Render buttons took ${(performance.now() - t1).toFixed(2)}ms`);

  console.timeEnd('[PERF] renderActions total');
  console.log('[renderActions] END');
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
        tabData.wrapper.classList.add('hidden');
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
      activeTab.wrapper.classList.remove('hidden');
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
  // Find which project owns this tab
  let tab = null;
  for (const [projId, projectData] of openProjects) {
    if (projectData.tabs.has(tabId)) {
      tab = projectData.tabs.get(tabId);
      break;
    }
  }

  if (!tab) {
    // Silently ignore - tab might have been closed
    return;
  }

  // Track last data time for active process detection
  tab.lastDataTime = Date.now();

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

// ========== SESSION PERSISTENCE ==========

/**
 * Show modal prompt (replacement for prompt())
 */
function showPromptModal(title, label, placeholder = '', hint = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('session-input-modal');
    const titleEl = document.getElementById('session-modal-title');
    const labelEl = document.getElementById('session-modal-label');
    const inputEl = document.getElementById('session-input-field');
    const hintEl = document.getElementById('session-modal-hint');
    const confirmBtn = document.getElementById('confirm-session-btn');
    const cancelBtn = document.getElementById('cancel-session-btn');
    const closeBtn = document.getElementById('close-session-modal-btn');

    // Set content
    titleEl.textContent = title;
    labelEl.textContent = label;
    inputEl.placeholder = placeholder;
    hintEl.textContent = hint;
    inputEl.value = '';

    // Show modal
    modal.classList.remove('hidden');
    inputEl.focus();

    // Handle confirm
    const handleConfirm = () => {
      const value = inputEl.value.trim();
      cleanup();
      resolve(value || null);
    };

    // Handle cancel
    const handleCancel = () => {
      cleanup();
      resolve(null);
    };

    // Handle Enter key
    const handleKeyPress = (e) => {
      if (e.key === 'Enter') {
        handleConfirm();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    };

    // Cleanup
    const cleanup = () => {
      modal.classList.add('hidden');
      confirmBtn.removeEventListener('click', handleConfirm);
      cancelBtn.removeEventListener('click', handleCancel);
      closeBtn.removeEventListener('click', handleCancel);
      inputEl.removeEventListener('keypress', handleKeyPress);
    };

    // Attach listeners
    confirmBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);
    inputEl.addEventListener('keypress', handleKeyPress);
  });
}

/**
 * Save visual snapshot of current tab
 */
async function saveVisualSnapshot() {
  if (!activeProjectId) {
    showToast('No active project', 'error');
    return;
  }

  const projectData = openProjects.get(activeProjectId);
  if (!projectData || !projectData.activeTabId) {
    showToast('No active tab', 'error');
    return;
  }

  const tab = projectData.tabs.get(projectData.activeTabId);
  if (!tab || !tab.serializeAddon) {
    showToast('Terminal not ready', 'error');
    return;
  }

  // Get tab index
  const tabs = Array.from(projectData.tabs.keys());
  const tabIndex = tabs.indexOf(projectData.activeTabId);

  // Serialize terminal buffer
  const snapshot = tab.serializeAddon.serialize();

  // Save to database
  const result = await ipcRenderer.invoke('session:save-visual', {
    dirPath: projectData.project.path,
    tabIndex,
    snapshot
  });

  if (result.success) {
    showToast('Terminal buffer saved', 'success');
    console.log('[Session] Visual snapshot saved');
  } else {
    showToast('Failed to save terminal buffer', 'error');
    console.error('[Session] Failed to save visual snapshot:', result.error);
  }
}

/**
 * Restore visual snapshot for a tab (called during tab creation)
 */
async function restoreVisualSnapshot(tabId, tabIndex) {
  if (!activeProjectId) return;

  const projectData = openProjects.get(activeProjectId);
  if (!projectData) return;

  const tab = projectData.tabs.get(tabId);
  if (!tab || !tab.terminal) return;

  // Get visual snapshot from database
  const result = await ipcRenderer.invoke('session:get-visual', {
    dirPath: projectData.project.path,
    tabIndex
  });

  if (result.success && result.data) {
    console.log('[Session] Restoring visual snapshot');
    tab.terminal.write(result.data);
  }
}

/**
 * Refresh sessions list UI
 */
async function refreshSessionsList() {
  if (!activeProjectId) return;

  const projectData = openProjects.get(activeProjectId);
  if (!projectData) return;

  console.log('[Sessions] Refreshing sessions list...');

  const result = await ipcRenderer.invoke('session:list', {
    dirPath: projectData.project.path,
    toolType: null
  });

  if (!result.success) {
    console.error('[Sessions] Failed to load sessions:', result.error);
    return;
  }

  const sessions = result.data;
  console.log('[Sessions] Loaded sessions:', sessions);

  // Separate by type
  const geminiSessions = sessions.filter(s => s.tool_type === 'gemini');
  const claudeSessions = sessions.filter(s => s.tool_type === 'claude');

  // Update counts
  document.getElementById('gemini-session-count').textContent = geminiSessions.length;
  document.getElementById('claude-session-count').textContent = claudeSessions.length;

  // Render Gemini sessions
  const geminiList = document.getElementById('gemini-sessions-list');
  geminiList.innerHTML = '';

  if (geminiSessions.length === 0) {
    geminiList.innerHTML = '<div class="text-[10px] text-[#555] italic">No saved sessions</div>';
  } else {
    geminiSessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item flex items-center gap-2 p-2 bg-[#2a2a2a] hover:bg-[#333] rounded cursor-pointer border border-transparent hover:border-accent transition-colors';
      item.dataset.sessionKey = session.session_key;
      item.dataset.sessionType = 'gemini';

      const updatedDate = new Date(session.updated_at * 1000);
      const timeAgo = getTimeAgo(updatedDate);

      item.innerHTML = `
        <div class="flex-1 min-w-0">
          <div class="text-xs text-white truncate">${session.session_key}</div>
          <div class="text-[10px] text-[#666]">${timeAgo}</div>
        </div>
        <button onclick="deleteSession(event, ${session.id})" class="text-[#888] hover:text-red-500 text-xs">🗑️</button>
      `;

      // Click to select for restore
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') return; // Ignore delete button
        // Remove selection from all items
        document.querySelectorAll('#gemini-sessions-list .session-item').forEach(el => {
          el.classList.remove('border-accent');
          el.classList.add('border-transparent');
        });
        // Add selection to clicked item
        item.classList.remove('border-transparent');
        item.classList.add('border-accent');
      });

      geminiList.appendChild(item);
    });
  }

  // Render Claude sessions
  const claudeList = document.getElementById('claude-sessions-list');
  claudeList.innerHTML = '';

  if (claudeSessions.length === 0) {
    claudeList.innerHTML = '<div class="text-[10px] text-[#555] italic">No saved sessions</div>';
  } else {
    claudeSessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item flex items-center gap-2 p-2 bg-[#2a2a2a] hover:bg-[#333] rounded cursor-pointer border border-transparent hover:border-accent transition-colors';
      item.dataset.sessionKey = session.session_key;
      item.dataset.sessionType = 'claude';

      const updatedDate = new Date(session.updated_at * 1000);
      const timeAgo = getTimeAgo(updatedDate);

      item.innerHTML = `
        <div class="flex-1 min-w-0">
          <div class="text-xs text-white truncate">${session.session_key}</div>
          <div class="text-[10px] text-[#666]">${timeAgo}</div>
        </div>
        <button onclick="deleteSession(event, ${session.id})" class="text-[#888] hover:text-red-500 text-xs">🗑️</button>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        // Remove selection from all items
        document.querySelectorAll('#claude-sessions-list .session-item').forEach(el => {
          el.classList.remove('border-accent');
          el.classList.add('border-transparent');
        });
        // Add selection to clicked item
        item.classList.remove('border-transparent');
        item.classList.add('border-accent');
      });

      claudeList.appendChild(item);
    });
  }
}

/**
 * Get human-readable time ago
 */
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Delete session
 */
async function deleteSession(event, sessionId) {
  event.stopPropagation();

  const confirmed = confirm('Delete this session?');
  if (!confirmed) return;

  const result = await ipcRenderer.invoke('session:delete', sessionId);

  if (result.success) {
    showToast('Session deleted', 'success');
    await refreshSessionsList();
  } else {
    showToast('Failed to delete session', 'error');
  }
}

/**
 * Wait for terminal output matching pattern
 * @param {string} tabId - Tab ID to monitor
 * @param {RegExp} pattern - Pattern to match
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<boolean>} - True if pattern found, false if timeout
 */
function waitForTerminalOutput(tabId, pattern, timeout = 10000) {
  return new Promise((resolve) => {
    let found = false;
    const startTime = Date.now();

    const checkOutput = (event, data) => {
      if (data.tabId !== tabId) return;

      const text = data.data;
      console.log('[Sessions] Terminal output chunk:', text.substring(0, 100));

      if (pattern.test(text)) {
        console.log('[Sessions] ✅ Pattern matched!');
        found = true;
        cleanup();
        resolve(true);
      }
    };

    const cleanup = () => {
      ipcRenderer.removeListener('terminal:data', checkOutput);
      clearTimeout(timeoutId);
    };

    const timeoutId = setTimeout(() => {
      if (!found) {
        console.log('[Sessions] ⏱️ Timeout waiting for pattern');
        cleanup();
        resolve(false);
      }
    }, timeout);

    ipcRenderer.on('terminal:data', checkOutput);
  });
}

/**
 * Export Gemini session
 * Automatically runs /chat save in terminal, then exports to DB
 */
async function exportGeminiSession() {
  if (!activeProjectId) {
    showToast('No active project', 'error');
    return;
  }

  const projectData = openProjects.get(activeProjectId);

  if (!projectData.activeTabId) {
    showToast('Please open a terminal tab first', 'error');
    return;
  }

  const sessionKey = await showPromptModal(
    'Export Gemini Session',
    'Checkpoint Name',
    'session-' + Date.now(),
    'This will run "/chat save <name>" in your terminal'
  );

  if (!sessionKey) return;

  console.log('[Sessions] Starting Gemini export workflow...');
  console.log('[Sessions] Active tab:', projectData.activeTabId);

  // Step 1: Send /chat save command to terminal
  showToast('Saving checkpoint in Gemini...', 'info');
  const saveCommand = `/chat save ${sessionKey}`;
  console.log('[Sessions] ===== SENDING COMMAND =====');
  console.log('[Sessions] Command:', JSON.stringify(saveCommand));
  console.log('[Sessions] Tab ID:', projectData.activeTabId);

  // Start monitoring terminal output BEFORE sending command
  const successPattern = /checkpoint saved with\s+tag:\s*(\S+)/i;
  console.log('[Sessions] Starting output monitor with pattern:', successPattern);
  const outputPromise = waitForTerminalOutput(projectData.activeTabId, successPattern, 8000);

  // Send command
  console.log('[Sessions] Calling ipcRenderer.send...');
  ipcRenderer.send('terminal:executeCommand', projectData.activeTabId, saveCommand);
  console.log('[Sessions] ✅ IPC send called');

  // Step 2: Wait for confirmation from Gemini
  console.log('[Sessions] Waiting for Gemini confirmation...');
  const success = await outputPromise;

  if (!success) {
    showToast('Timeout: Gemini did not confirm save. Check terminal.', 'error');
    console.error('[Sessions] ❌ Did not receive checkpoint confirmation');
    return;
  }

  console.log('[Sessions] ✅ Gemini confirmed checkpoint save');

  // Small additional delay to ensure file is written to disk
  await new Promise(resolve => setTimeout(resolve, 500));

  // Step 3: Export the checkpoint to database
  showToast('Exporting to database...', 'info');

  const result = await ipcRenderer.invoke('session:export-gemini', {
    dirPath: projectData.project.path,
    sessionKey
  });

  if (result.success) {
    showToast(result.message, 'success');
    await refreshSessionsList(); // Refresh list after export
  } else {
    showToast('Export failed: ' + result.message, 'error');
  }
}

/**
 * Import Gemini session from selected item in list
 */
async function importGeminiSessionFromList() {
  if (!activeProjectId) {
    showToast('No active project', 'error');
    return;
  }

  const projectData = openProjects.get(activeProjectId);

  if (!projectData.activeTabId) {
    showToast('Please create a tab first', 'error');
    return;
  }

  // Get selected session from list
  const selectedItem = document.querySelector('#gemini-sessions-list .session-item.border-accent');

  if (!selectedItem) {
    showToast('Please select a session from the list', 'error');
    return;
  }

  const sessionKey = selectedItem.dataset.sessionKey;
  console.log('[Sessions] Restoring Gemini session:', sessionKey);

  showToast('Restoring session...', 'info');

  const result = await ipcRenderer.invoke('session:import-gemini', {
    dirPath: projectData.project.path,
    sessionKey,
    tabId: projectData.activeTabId
  });

  if (result.success) {
    showToast(result.message, 'success');

    // Smart auto-resume with state detection
    await smartGeminiResume(projectData.activeTabId, sessionKey);
  } else {
    showToast('Import failed: ' + result.message, 'error');
  }
}

/**
 * Smart Gemini resume - detects if Gemini is running and waits for ready state
 */
async function smartGeminiResume(tabId, sessionKey) {
  const tab = getTabById(tabId);
  if (!tab) {
    console.error('[SmartResume] Tab not found:', tabId);
    return;
  }

  console.log('[SmartResume] Starting smart resume for session:', sessionKey);

  // Step 1: Check if Gemini is already running
  const isGeminiRunning = await detectGeminiRunning(tab);

  if (isGeminiRunning) {
    console.log('[SmartResume] ✅ Gemini already running, sending resume command directly');
    showToast('Resuming session...', 'info');
    ipcRenderer.send('terminal:executeCommand', tabId, `/chat resume ${sessionKey}`);
    return;
  }

  // Step 2: Gemini not running, start it
  console.log('[SmartResume] Gemini not running, starting...');
  showToast('Starting Gemini CLI...', 'info');
  ipcRenderer.send('terminal:executeCommand', tabId, 'gemini');

  // Step 3: Wait for Gemini to be ready
  console.log('[SmartResume] Waiting for Gemini to be ready...');
  const ready = await waitForGeminiReady(tab, 15000); // 15 second timeout

  if (!ready) {
    console.error('[SmartResume] ❌ Timeout waiting for Gemini to start');
    showToast('Timeout waiting for Gemini. Please run: /chat resume ' + sessionKey, 'warning');
    return;
  }

  // Step 4: Gemini ready, send resume command
  console.log('[SmartResume] ✅ Gemini ready, sending resume command');
  showToast('Resuming session...', 'info');
  await new Promise(resolve => setTimeout(resolve, 500)); // Small delay for stability
  ipcRenderer.send('terminal:executeCommand', tabId, `/chat resume ${sessionKey}`);

  showToast('Session resumed successfully!', 'success');
}

/**
 * Detect if Gemini is currently running in the terminal
 *
 * ISSUE: Current buffer-based detection is unreliable because:
 * 1. Old patterns remain in buffer from previous sessions
 * 2. Can't distinguish "Gemini running now" vs "Gemini was running before"
 *
 * TODO: Better approach - check PTY child processes via main.js IPC
 * ipcRenderer.invoke('terminal:getActiveProcess', tabId) -> 'gemini' | 'claude' | null
 */
async function detectGeminiRunning(tab) {
  console.log('[DetectGemini] ========== START DETECTION ==========');

  // Check terminal buffer for Gemini prompt patterns
  if (!tab.serializeAddon) {
    console.log('[DetectGemini] ❌ No serializeAddon available');
    return false;
  }

  const buffer = tab.serializeAddon.serialize();
  const bufferLength = buffer.length;

  // Only check last 2000 chars (recent output)
  const recentBuffer = buffer.slice(-2000);
  const lastLines = recentBuffer.split('\n').slice(-20); // Last 20 lines

  console.log('[DetectGemini] Buffer length:', bufferLength);
  console.log('[DetectGemini] Last 20 lines:', lastLines);

  // Gemini prompt patterns - only in RECENT output
  const geminiPatterns = [
    'Type your message or @path/to/file',
    'YOLO mode',
    // Removed />\s*$/m - too generic, matches bash prompt too
  ];

  for (const pattern of geminiPatterns) {
    if (typeof pattern === 'string') {
      // Check only in recent buffer
      if (recentBuffer.includes(pattern)) {
        console.log('[DetectGemini] ✅ Found pattern in recent output:', pattern);
        return true;
      }
    }
  }

  console.log('[DetectGemini] ❌ No Gemini patterns found in recent output');
  return false;
}

/**
 * Wait for Gemini to be ready (detect ready pattern in terminal output)
 *
 * ISSUE: Same as detectGeminiRunning - buffer-based detection is unreliable
 * TODO: Use PTY process monitoring instead
 */
function waitForGeminiReady(tab, timeoutMs = 15000) {
  console.log('[WaitGeminiReady] ========== WAITING FOR GEMINI ==========');
  console.log('[WaitGeminiReady] Timeout:', timeoutMs, 'ms');

  return new Promise((resolve) => {
    const startTime = Date.now();
    let lastCheckTime = Date.now();
    let checkCount = 0;
    let lastBufferSnapshot = '';

    const checkInterval = setInterval(() => {
      // Timeout check
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        console.log('[WaitGeminiReady] ⏱️ Timeout after', checkCount, 'checks');
        resolve(false);
        return;
      }

      // Only check every 500ms to avoid spam
      if (Date.now() - lastCheckTime < 500) return;
      lastCheckTime = Date.now();
      checkCount++;

      // Check terminal buffer
      if (!tab.serializeAddon) {
        console.log('[WaitGeminiReady] ❌ No serializeAddon');
        return;
      }

      const buffer = tab.serializeAddon.serialize();

      // Log if buffer changed (new output)
      const recentBuffer = buffer.slice(-1000);
      if (recentBuffer !== lastBufferSnapshot) {
        console.log('[WaitGeminiReady] Check #', checkCount, '- Buffer changed, last 200 chars:', recentBuffer.slice(-200));
        lastBufferSnapshot = recentBuffer;
      }

      // Ready patterns (Gemini shows these when ready for input)
      const readyPatterns = [
        'Type your message or @path/to/file',
        'YOLO mode',
      ];

      for (const pattern of readyPatterns) {
        // Check only recent buffer
        if (recentBuffer.includes(pattern)) {
          clearInterval(checkInterval);
          console.log('[WaitGeminiReady] ✅ Ready! Found pattern:', pattern, 'after', checkCount, 'checks');
          resolve(true);
          return;
        }
      }
    }, 100); // Check every 100ms
  });
}

/**
 * Helper to get tab by ID across all projects
 */
function getTabById(tabId) {
  for (const [projId, projectData] of openProjects) {
    if (projectData.tabs.has(tabId)) {
      return projectData.tabs.get(tabId);
    }
  }
  return null;
}

/**
 * Import Gemini session (manual prompt version)
 */
async function importGeminiSession() {
  if (!activeProjectId) {
    showToast('No active project', 'error');
    return;
  }

  const projectData = openProjects.get(activeProjectId);

  if (!projectData.activeTabId) {
    showToast('Please create a tab first', 'error');
    return;
  }

  const sessionKey = await showPromptModal(
    'Restore Gemini Session',
    'Checkpoint Name',
    'test-001',
    'Enter the checkpoint name to restore'
  );

  if (!sessionKey) return;

  showToast('Restoring session...', 'info');

  const result = await ipcRenderer.invoke('session:import-gemini', {
    dirPath: projectData.project.path,
    sessionKey,
    tabId: projectData.activeTabId
  });

  if (result.success) {
    showToast(result.message, 'success');

    // Smart auto-resume with state detection
    await smartGeminiResume(projectData.activeTabId, sessionKey);
  } else {
    showToast('Import failed: ' + result.message, 'error');
  }
}

/**
 * Export Claude session
 */
async function exportClaudeSession() {
  if (!activeProjectId) {
    showToast('No active project', 'error');
    return;
  }

  const projectData = openProjects.get(activeProjectId);
  const sessionKey = await showPromptModal(
    'Export Claude Session',
    'Session UUID (optional)',
    '',
    'Leave empty to auto-detect latest session'
  );

  // Allow empty for auto-detect
  const result = await ipcRenderer.invoke('session:export-claude', {
    dirPath: projectData.project.path,
    sessionKey: sessionKey || ''
  });

  if (result.success) {
    showToast(result.message, 'success');
    await refreshSessionsList(); // Refresh list after export
  } else {
    showToast('Export failed: ' + result.message, 'error');
  }
}

/**
 * Import Claude session from selected item in list
 */
async function importClaudeSessionFromList() {
  if (!activeProjectId) {
    showToast('No active project', 'error');
    return;
  }

  const projectData = openProjects.get(activeProjectId);

  // Get selected session from list
  const selectedItem = document.querySelector('#claude-sessions-list .session-item.border-accent');

  if (!selectedItem) {
    showToast('Please select a session from the list', 'error');
    return;
  }

  const sessionKey = selectedItem.dataset.sessionKey;
  console.log('[Sessions] Restoring Claude session:', sessionKey);

  const result = await ipcRenderer.invoke('session:import-claude', {
    dirPath: projectData.project.path,
    sessionKey
  });

  if (result.success) {
    showToast(result.message, 'success');

    // Show command to user
    if (result.commands && result.commands.length > 0) {
      console.log('[Session] Run this command:', result.commands[0]);
      showToast('Run: ' + result.commands[0], 'info');
    }
  } else {
    showToast('Import failed: ' + result.message, 'error');
  }
}

/**
 * Import Claude session (manual input - kept for backward compatibility)
 */
async function importClaudeSession() {
  if (!activeProjectId) {
    showToast('No active project', 'error');
    return;
  }

  const projectData = openProjects.get(activeProjectId);
  const sessionKey = await showPromptModal(
    'Restore Claude Session',
    'Session UUID',
    '',
    'Enter the session UUID to restore'
  );

  if (!sessionKey) return;

  const result = await ipcRenderer.invoke('session:import-claude', {
    dirPath: projectData.project.path,
    sessionKey
  });

  if (result.success) {
    showToast(result.message, 'success');

    // Show command to user
    if (result.commands && result.commands.length > 0) {
      console.log('[Session] Run this command:', result.commands[0]);
      showToast('Run: ' + result.commands[0], 'info');
    }
  } else {
    showToast('Import failed: ' + result.message, 'error');
  }
}

// Expose functions globally for button access
window.saveVisualSnapshot = saveVisualSnapshot;
window.exportGeminiSession = exportGeminiSession;
window.importGeminiSession = importGeminiSession;
window.importGeminiSessionFromList = importGeminiSessionFromList;
window.exportClaudeSession = exportClaudeSession;
window.importClaudeSession = importClaudeSession;
window.importClaudeSessionFromList = importClaudeSessionFromList;
window.refreshSessionsList = refreshSessionsList;
window.deleteSession = deleteSession;

// Run Init
init();