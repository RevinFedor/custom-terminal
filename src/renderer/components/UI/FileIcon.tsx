import React from 'react';
import {
  VscFile,
  VscFileCode,
  VscFileMedia,
  VscFilePdf,
  VscFolder,
  VscFolderOpened,
  VscJson,
  VscMarkdown,
  VscGear,
  VscListSelection,
  VscBook,
  VscBeaker
} from 'react-icons/vsc';
import {
  SiJavascript,
  SiCss3,
  SiHtml5,
  SiReact,
  SiPython,
  SiTypescript
} from 'react-icons/si';

import { CUSTOM_ICONS } from '../../assets/icons/registry';
import { ICON_RULES } from '../../config/iconRules';

interface FileIconProps {
  name: string;
  isDirectory: boolean;
  isOpen?: boolean;
  size?: number;
}

// Helper to render custom icon by key from registry
const renderCustomIcon = (key: string, size: number) => {
  const Icon = CUSTOM_ICONS[key];
  if (Icon) {
    return (
      <span style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text)' }}>
        {Icon}
      </span>
    );
  }
  return null;
};

// --- Theme: VS Code (React Icons) ---
const renderVscIcon = (name: string, isDirectory: boolean, isOpen: boolean, size: number) => {
  if (isDirectory) {
    return isOpen
      ? <VscFolderOpened color="#dcb67a" size={size} />
      : <VscFolder color="#dcb67a" size={size} />;
  }

  const lowerName = name.toLowerCase();
  const ext = name.split('.').pop()?.toLowerCase() || '';

  // Specific filenames
  if (lowerName === 'package.json') return <SiJavascript color="#CB3837" size={size} />;
  if (lowerName === 'readme.md') return <VscBook color="#4a90e2" size={size} />;
  if (lowerName.includes('config')) return <VscGear color="#ccc" size={size} />;
  if (lowerName.includes('todo')) return <VscListSelection color="#FF8C00" size={size} />;
  if (lowerName.includes('test')) return <VscBeaker color="#666" size={size} />;

  // Extensions
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return <SiJavascript color="#f7df1e" size={size - 1} />;
    case 'jsx':
      return <SiReact color="#61dafb" size={size - 1} />;
    case 'ts':
    case 'tsx':
      return <SiTypescript color="#3178c6" size={size - 1} />;
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return <SiCss3 color="#1572b6" size={size - 1} />;
    case 'html':
      return <SiHtml5 color="#e34c26" size={size - 1} />;
    case 'json':
      return <VscJson color="#f1e05a" size={size} />;
    case 'md':
    case 'markdown':
      return <VscMarkdown color="#4a90e2" size={size} />;
    case 'py':
      return <SiPython color="#3776ab" size={size - 1} />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return <VscFileMedia color="#b0bec5" size={size} />;
    case 'pdf':
      return <VscFilePdf color="#ef5350" size={size} />;
    default:
      return <VscFile color="#cccccc" size={size} />;
  }
};

export default function FileIcon({ name, isDirectory, isOpen = false, size = 16 }: FileIconProps) {
  // 1. Check custom icon rules first (for .claude.md, .gemini.md, etc.)
  if (!isDirectory) {
    const lowerName = name.toLowerCase();

    for (const rule of ICON_RULES) {
      if (lowerName.endsWith(rule.ext.toLowerCase())) {
        const icon = renderCustomIcon(rule.icon, size);
        if (icon) return icon;
      }
    }
  }

  // 2. VS Code theme icons
  return (
    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {renderVscIcon(name, isDirectory, isOpen, size)}
    </span>
  );
}
