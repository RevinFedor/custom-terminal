import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useUIStore } from '../../store/useUIStore';

const { ipcRenderer } = window.require('electron');
const fs = window.require('fs').promises;
const path = window.require('path');

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileTreeItemProps {
  item: FileItem;
  level: number;
  onFileClick: (path: string) => void;
}

function FileTreeItem({ item, level, onFileClick }: FileTreeItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadChildren = async () => {
    if (children.length > 0) return;
    setLoading(true);

    try {
      const files = await fs.readdir(item.path);
      const items: FileItem[] = [];

      for (const file of files) {
        if (file === '.git' || file === 'node_modules' || file === '.DS_Store') continue;

        const fullPath = path.join(item.path, file);
        try {
          const stats = await fs.stat(fullPath);
          items.push({
            name: file,
            path: fullPath,
            isDirectory: stats.isDirectory()
          });
        } catch (e) {
          // Skip files we can't stat
        }
      }

      // Sort: directories first, then files
      items.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
        return a.isDirectory ? -1 : 1;
      });

      setChildren(items);
    } catch (err) {
      console.error('Error loading directory:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    if (item.isDirectory) {
      if (!expanded) loadChildren();
      setExpanded(!expanded);
    } else {
      onFileClick(item.path);
    }
  };

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(item.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  };

  return (
    <>
      <div
        className="flex items-center py-1 cursor-pointer text-[#ccc] gap-1 whitespace-nowrap font-jetbrains text-xs hover:bg-white/5 group"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleClick}
      >
        <span className="shrink-0 w-3 text-center text-[10px] transition-transform">
          {item.isDirectory ? (expanded ? '▼' : '▶') : '\u00A0'}
        </span>
        <span className="shrink-0 w-4 text-center text-sm">
          {item.isDirectory ? (expanded ? '📂' : '📁') : '📄'}
        </span>
        <span className="flex-1 overflow-hidden text-ellipsis ml-1">
          {item.name}
        </span>
        <button
          className="shrink-0 ml-1 opacity-0 bg-[#333] border border-[#444] text-[#888] text-[9px] px-1 rounded uppercase group-hover:opacity-100 hover:bg-[#555] hover:text-white transition-opacity"
          onClick={handleCopyPath}
        >
          {copied ? 'Copied!' : 'Copy Path'}
        </button>
      </div>

      {expanded && item.isDirectory && (
        <div className="tree-folder-children">
          {loading ? (
            <div className="text-[10px] text-[#666] pl-8 py-1">Loading...</div>
          ) : (
            children.map((child) => (
              <FileTreeItem
                key={child.path}
                item={child}
                level={level + 1}
                onFileClick={onFileClick}
              />
            ))
          )}
        </div>
      )}
    </>
  );
}

interface FileExplorerProps {
  projectPath: string;
}

export default function FileExplorer({ projectPath }: FileExplorerProps) {
  const { fileExplorerOpen, setFileExplorerOpen, openFilePreview, showToast } = useUIStore();
  const [rootItems, setRootItems] = useState<FileItem[]>([]);

  useEffect(() => {
    if (fileExplorerOpen && projectPath) {
      loadRootDirectory();
    }
  }, [fileExplorerOpen, projectPath]);

  const loadRootDirectory = async () => {
    try {
      const files = await fs.readdir(projectPath);
      const items: FileItem[] = [];

      for (const file of files) {
        if (file === '.git' || file === 'node_modules' || file === '.DS_Store') continue;

        const fullPath = path.join(projectPath, file);
        try {
          const stats = await fs.stat(fullPath);
          items.push({
            name: file,
            path: fullPath,
            isDirectory: stats.isDirectory()
          });
        } catch (e) {
          // Skip files we can't stat
        }
      }

      items.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
        return a.isDirectory ? -1 : 1;
      });

      setRootItems(items);
    } catch (err) {
      console.error('Error loading root directory:', err);
    }
  };

  const handleFileClick = async (filePath: string) => {
    try {
      const result = await ipcRenderer.invoke('file:read', filePath);

      if (result.success) {
        const ext = path.extname(filePath).toLowerCase();
        const language = detectLanguage(ext);

        openFilePreview({
          path: filePath,
          content: result.content,
          language
        });
      } else {
        showToast(`Error reading file: ${result.error}`, 'error');
      }
    } catch (error: any) {
      showToast(`Error: ${error.message}`, 'error');
    }
  };

  return createPortal(
    <AnimatePresence>
      {fileExplorerOpen && (
        <motion.div
          initial={{ x: -250 }}
          animate={{ x: 0 }}
          exit={{ x: -250 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          style={{
            position: 'fixed',
            left: 0,
            top: 36,
            bottom: 0,
            width: 250,
            backgroundColor: '#1e1e1e',
            borderRight: '1px solid #333',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 99999,
            boxShadow: '4px 0 20px rgba(0,0,0,0.5)'
          }}
        >
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#888', fontWeight: 'bold', textTransform: 'uppercase' }}>Explorer</span>
            <button
              style={{ color: '#888', fontSize: 18, background: 'none', border: 'none', cursor: 'pointer' }}
              onClick={() => setFileExplorerOpen(false)}
            >
              ×
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {rootItems.map((item) => (
              <FileTreeItem
                key={item.path}
                item={item}
                level={0}
                onFileClick={handleFileClick}
              />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

// Detect programming language by file extension
function detectLanguage(ext: string): string | null {
  const languageMap: Record<string, string | null> = {
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
