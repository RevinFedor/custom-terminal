import React, { useState, useEffect } from 'react';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useBookmarksStore, Bookmark } from '../../store/useBookmarksStore';
import ProjectCard from './ProjectCard';
import BookmarkCard from './BookmarkCard';
import { Plus } from 'lucide-react';

const { ipcRenderer } = window.require('electron');

export default function Dashboard() {
  const [processStatus, setProcessStatus] = useState<Map<string, boolean>>(new Map());
  const { projects, loadProjects } = useProjectsStore();
  const { openProject, openProjects } = useWorkspaceStore();
  const { bookmarks, loadBookmarks, addBookmarkFromDialog, updateBookmark, deleteBookmark } = useBookmarksStore();

  // Edit bookmark modal state
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  useEffect(() => {
    loadProjects();
    loadBookmarks();
  }, []);

  // OSC 133 Event-driven process status
  useEffect(() => {
    const allTabIds: string[] = [];
    for (const [, workspace] of openProjects) {
      allTabIds.push(...workspace.tabs.keys());
    }

    if (allTabIds.length === 0) return;

    const initStatus = async () => {
      const newStatus = new Map<string, boolean>();
      await Promise.all(
        allTabIds.map(async (tabId) => {
          try {
            const state = await ipcRenderer.invoke('terminal:getCommandState', tabId);
            newStatus.set(tabId, state.isRunning);
          } catch {
            newStatus.set(tabId, false);
          }
        })
      );
      setProcessStatus(newStatus);
    };
    initStatus();

    const handleCommandStarted = (_: any, { tabId }: { tabId: string }) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, true);
        return next;
      });
    };

    const handleCommandFinished = (_: any, { tabId }: { tabId: string }) => {
      setProcessStatus(prev => {
        const next = new Map(prev);
        next.set(tabId, false);
        return next;
      });
    };

    ipcRenderer.on('terminal:command-started', handleCommandStarted);
    ipcRenderer.on('terminal:command-finished', handleCommandFinished);

    return () => {
      ipcRenderer.removeListener('terminal:command-started', handleCommandStarted);
      ipcRenderer.removeListener('terminal:command-finished', handleCommandFinished);
    };
  }, [openProjects.size]);

  // Create project from bookmark - always creates a NEW project instance
  const handleCreateProjectFromBookmark = async (bookmark: Bookmark) => {
    console.log('[Dashboard] handleCreateProjectFromBookmark called with bookmark:', bookmark);

    // Generate unique name with suffix if needed
    let projectName = bookmark.name;
    const existingNames = Object.values(projects).map(p => p.name);
    console.log('[Dashboard] Existing project names:', existingNames);

    if (existingNames.includes(projectName)) {
      let suffix = 1;
      while (existingNames.includes(`${bookmark.name}-${suffix}`)) {
        suffix++;
      }
      projectName = `${bookmark.name}-${suffix}`;
    }
    console.log('[Dashboard] Final project name:', projectName);

    // Always create new project instance
    console.log('[Dashboard] Calling project:create-instance...');
    try {
      const newProject = await ipcRenderer.invoke('project:create-instance', {
        path: bookmark.path,
        name: projectName
      });
      console.log('[Dashboard] project:create-instance returned:', newProject);

      if (newProject) {
        console.log('[Dashboard] Loading projects...');
        await loadProjects();
        console.log('[Dashboard] Opening project:', newProject.id, newProject.path);
        openProject(newProject.id, newProject.path);
      } else {
        console.error('[Dashboard] project:create-instance returned null/undefined!');
      }
    } catch (err) {
      console.error('[Dashboard] Error in handleCreateProjectFromBookmark:', err);
    }
  };

  const handleOpenProjectWorkspace = (projectId: string) => {
    openProject(projectId, projects[projectId].path);
  };

  // Get ALL projects from DB, sorted by updated_at (most recent first)
  const allProjects = Object.values(projects);

  // Check if project is currently open
  const isProjectOpen = (projectId: string) => openProjects.has(projectId);

  // Get tabs stats for each project
  const getTabsStats = (projectId: string) => {
    const projectData = openProjects.get(projectId);
    if (!projectData) return { total: 0, active: 0 };

    const total = projectData.tabs.size;
    let active = 0;

    for (const tabId of projectData.tabs.keys()) {
      if (processStatus.get(tabId)) {
        active++;
      }
    }

    return { total, active };
  };

  // Handle edit bookmark
  const handleEditBookmark = (bookmark: Bookmark) => {
    setEditingBookmark(bookmark);
    setEditName(bookmark.name);
    setEditDescription(bookmark.description);
  };

  const handleSaveEdit = async () => {
    if (editingBookmark) {
      await updateBookmark(editingBookmark.id, {
        name: editName,
        description: editDescription
      });
      setEditingBookmark(null);
    }
  };

  // Handle delete bookmark
  const handleDeleteBookmark = async (bookmark: Bookmark) => {
    if (confirm(`Delete bookmark "${bookmark.name}"?`)) {
      await deleteBookmark(bookmark.id);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-bg-main overflow-hidden">
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 pb-6 pt-12">
        {/* All Projects Section */}
        {allProjects.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-[#888] mb-3">Projects</h2>
            <div
              className="gap-3"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 180px))',
              }}
            >
              {allProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  isOpen={isProjectOpen(project.id)}
                  onOpen={() => handleOpenProjectWorkspace(project.id)}
                  tabsStats={getTabsStats(project.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Bookmarks Section */}
        <div>
          <h2 className="text-sm font-medium text-[#888] mb-3">Reserved Directories</h2>

          <div className="flex flex-wrap gap-2">
            {bookmarks.map((bookmark) => (
              <BookmarkCard
                key={bookmark.id}
                bookmark={bookmark}
                onCreateProject={handleCreateProjectFromBookmark}
                onEdit={handleEditBookmark}
                onDelete={handleDeleteBookmark}
              />
            ))}

            {/* Add Directory Card - same style as BookmarkCard */}
            <div
              className="flex items-center justify-center gap-2 px-3 py-3 rounded-lg border border-dashed border-[#444] bg-transparent cursor-pointer transition-all duration-150 hover:border-[#666] hover:bg-[#1a1a1a]"
              onClick={addBookmarkFromDialog}
            >
              <Plus size={14} className="text-[#666]" />
              <span className="text-sm text-[#666]">Add Directory</span>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Bookmark Modal */}
      {editingBookmark && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#252525] border border-[#444] rounded-lg p-4 w-[400px] shadow-2xl">
            <h3 className="text-sm font-medium text-white mb-4">Edit Bookmark</h3>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-[#888] block mb-1">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-[#1a1a1a] border border-[#444] rounded px-3 py-2 text-sm text-white focus:border-accent outline-none"
                />
              </div>

              <div>
                <label className="text-xs text-[#888] block mb-1">Description</label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  className="w-full bg-[#1a1a1a] border border-[#444] rounded px-3 py-2 text-sm text-white focus:border-accent outline-none resize-none"
                  placeholder="What is this project about?"
                />
              </div>

              <div className="text-xs text-[#666] truncate">
                {editingBookmark.path}
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setEditingBookmark(null)}
                className="px-3 py-1.5 text-xs text-[#888] hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-3 py-1.5 text-xs bg-accent/20 text-accent hover:bg-accent/30 rounded transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
