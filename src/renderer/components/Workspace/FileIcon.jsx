import React from 'react'
import { VscFile, VscFileCode, VscFileMedia, VscFilePdf, VscFolder, VscFolderOpened, VscJson, VscMarkdown, VscGear, VscListSelection, VscBook, VscBeaker } from 'react-icons/vsc'
import { SiJavascript, SiCss3, SiHtml5, SiReact, SiPython, SiTypescript, SiJson, SiMarkdown } from 'react-icons/si'

const DefaultFolderIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 14.5 4H7.707l-.854-.854A.5.5 0 0 0 6.5 3H1.5z"/>
  </svg>
)

const DefaultFileIcon = ({ name }) => {
  const ext = name.split('.').pop().toLowerCase()
  const isMarkdown = ['md', 'markdown', 'txt'].includes(ext)

  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill={isMarkdown ? '#89b4fa' : '#cdd6f4'}>
      <path d="M4 0h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm0 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H4z"/>
      {isMarkdown && <text x="4" y="11" fontSize="6" fill="#89b4fa">M</text>}
    </svg>
  )
}

// Render a base64 image as icon
const renderImageIcon = (src) => (
  <span style={{ width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <img src={src} width={16} height={16} alt="" style={{ borderRadius: 2, objectFit: 'cover' }} />
  </span>
)

// --- Theme: VS Code (React Icons) ---
const renderVscIcon = (name, isDirectory, isOpen) => {
  if (isDirectory) {
    return isOpen ? <VscFolderOpened color="#dcb67a" size={16} /> : <VscFolder color="#dcb67a" size={16} />
  }

  const lowerName = name.toLowerCase()
  const ext = name.split('.').pop().toLowerCase()

  // Specific filenames
  if (lowerName === 'package.json') return <SiJavascript color="#CB3837" size={16} />
  if (lowerName === 'readme.md') return <VscBook color="#4a90e2" size={16} />
  if (lowerName.includes('config')) return <VscGear color="#ccc" size={16} />
  if (lowerName.includes('todo')) return <VscListSelection color="#FF8C00" size={16} />
  if (lowerName.includes('test')) return <VscBeaker color="#666" size={16} />

  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return <SiJavascript color="#f7df1e" size={15} />
    case 'jsx':
      return <SiReact color="#61dafb" size={15} />
    case 'ts':
    case 'tsx':
      return <SiTypescript color="#3178c6" size={15} />
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return <SiCss3 color="#1572b6" size={15} />
    case 'html':
      return <SiHtml5 color="#e34c26" size={15} />
    case 'json':
      return <VscJson color="#f1e05a" size={16} />
    case 'md':
    case 'markdown':
      return <VscMarkdown color="#4a90e2" size={16} />
    case 'py':
      return <SiPython color="#3776ab" size={15} />
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return <VscFileMedia color="#b0bec5" size={16} />
    case 'pdf':
      return <VscFilePdf color="#ef5350" size={16} />
    default:
      return <VscFile color="#cccccc" size={16} />
  }
}


// --- Main Component ---
const FileIcon = ({ name, isDirectory, expanded, customIcons, theme = 'vscode', settings }) => {
  // 1. Per-file override (highest priority)
  if (customIcons && customIcons[name]) {
    const override = customIcons[name]

    // Base64 image (new format)
    if (override.startsWith?.('data:')) {
      return renderImageIcon(override)
    }

    // "vscode" — force VS Code theme
    if (override === 'vscode') {
      return (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {renderVscIcon(name, isDirectory, expanded)}
        </span>
      )
    }

    // Fallback: emoji text
    return <span style={{ fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{override}</span>
  }

  // 2. Extension rules (from Settings)
  if (!isDirectory) {
    const lowerName = name.toLowerCase()
    const userRules = settings?.customIconRules || []
    for (const rule of userRules) {
      if (rule.extension && lowerName.endsWith(rule.extension.toLowerCase())) {
        if (rule.image) return renderImageIcon(rule.image)
      }
    }
  }

  // 3. Theme fallback
  if (theme === 'vscode') {
    return (
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {renderVscIcon(name, isDirectory, expanded)}
      </span>
    )
  }

  if (theme === 'emoji') {
    if (isDirectory) return <DefaultFolderIcon />
    return <DefaultFileIcon name={name} />
  }

  return isDirectory
    ? <DefaultFolderIcon />
    : <DefaultFileIcon name={name} />
}

export default FileIcon
