import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Pencil } from 'lucide-react'

function asArray(value) {
  if (!value) return []
  if (value instanceof Set) return [...value]
  return Array.isArray(value) ? value : []
}

function creationParent(node, rootPath) {
  if (!node) return null
  if (node.isDirectory) return node
  const slash = String(node.id || '').lastIndexOf('/')
  const parentId = slash > 0 ? node.id.slice(0, slash) : rootPath
  return !parentId || parentId === rootPath
    ? null
    : { id: parentId, name: parentId.split('/').pop(), isDirectory: true }
}

function renderExtension(extension, context) {
  return typeof extension === 'function' ? extension(context) : extension || null
}

export function FileMenuDivider() {
  return <div className="noted-file-menu__divider" role="separator" />
}

export function FileMenuItem({
  children,
  icon = null,
  disabled = false,
  destructive = false,
  className = '',
  onSelect,
  title,
}) {
  return (
    <button
      type="button"
      className={[
        'noted-file-menu__item',
        destructive ? 'is-destructive' : '',
        className,
      ].filter(Boolean).join(' ')}
      disabled={disabled}
      title={title}
      onClick={event => {
        event.stopPropagation()
        if (!disabled) onSelect?.(event)
      }}
    >
      {icon && <span className="noted-file-menu__icon" aria-hidden="true">{icon}</span>}
      <span className="noted-file-menu__label">{children}</span>
    </button>
  )
}

export function FileMenuSubmenu({ label, children, disabled = false }) {
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const closeTimerRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)

  const cancelClose = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => setOpen(false), 90)
  }

  useEffect(() => () => cancelClose(), [])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return
    const trigger = triggerRef.current.getBoundingClientRect()
    const panel = panelRef.current.getBoundingClientRect()
    const pad = 8
    const roomRight = window.innerWidth - trigger.right - pad
    const left = roomRight >= panel.width
      ? trigger.right + 2
      : Math.max(pad, trigger.left - panel.width - 2)
    const top = Math.min(
      Math.max(pad, trigger.top - 3),
      Math.max(pad, window.innerHeight - panel.height - pad),
    )
    setPosition({ left, top })
  }, [open, children])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="noted-file-menu__item has-submenu"
        disabled={disabled}
        onMouseEnter={() => { cancelClose(); if (!disabled) setOpen(true) }}
        onMouseLeave={scheduleClose}
        onFocus={() => { cancelClose(); if (!disabled) setOpen(true) }}
        onKeyDown={event => {
          if (event.key === 'ArrowRight' && !disabled) setOpen(true)
          if (event.key === 'Escape') setOpen(false)
        }}
      >
        <span className="noted-file-menu__label">{label}</span>
        <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="noted-file-menu noted-file-menu__submenu"
          data-file-menu-layer
          style={{
            left: position?.left ?? -10000,
            top: position?.top ?? -10000,
            visibility: position ? 'visible' : 'hidden',
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  )
}

export default function FileExplorerContextMenu({
  x,
  y,
  node = null,
  rootPath,
  selectedIds = [],
  onClose,
  actions = {},
  extensions = {},
  isExternalInteraction,
}) {
  const menuRef = useRef(null)
  const [position, setPosition] = useState(null)
  const selection = asArray(selectedIds)
  const selectionCount = selection.length > 1 ? selection.length : (node ? 1 : 0)
  const multi = selectionCount > 1
  const extensionContext = { node, selectedIds: selection, close: onClose, menuRef }

  useEffect(() => {
    const handlePointerDown = event => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-file-menu-layer]')) return
      if (isExternalInteraction?.(event)) return
      onClose?.()
    }
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose?.()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isExternalInteraction, onClose])

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const pad = 8
    setPosition({
      left: Math.min(Math.max(x, pad), Math.max(pad, window.innerWidth - rect.width - pad)),
      top: Math.min(Math.max(y, pad), Math.max(pad, window.innerHeight - rect.height - pad)),
    })
  }, [x, y, node, selectionCount])

  const run = callback => async () => {
    try {
      await callback?.()
    } finally {
      onClose?.()
    }
  }

  const createTarget = creationParent(node, rootPath)
  const hasCreateActions = !!actions.createFile || !!actions.createFolder

  return createPortal(
    <div
      ref={menuRef}
      className="noted-file-menu"
      data-file-menu-layer
      role="menu"
      style={{
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position ? 'visible' : 'hidden',
      }}
      onContextMenu={event => event.preventDefault()}
    >
      {multi ? (
        <>
          {actions.copyMultiPaths && (
            <FileMenuItem onSelect={run(() => actions.copyMultiPaths(selection))}>
              {`Copy Paths (${selectionCount})`}
            </FileMenuItem>
          )}
          {actions.copyMultiContent && (
            <FileMenuItem onSelect={run(() => actions.copyMultiContent(selection))}>
              {`Copy Content (${selectionCount})`}
            </FileMenuItem>
          )}
          {renderExtension(extensions.multi, extensionContext)}
          {actions.deleteItems && <FileMenuDivider />}
          {actions.deleteItems && (
            <FileMenuItem destructive onSelect={run(() => actions.deleteItems(selection, node))}>
              {`Delete ${selectionCount} items`}
            </FileMenuItem>
          )}
        </>
      ) : node ? (
        <>
          {actions.rename && (
            <FileMenuItem
              icon={<Pencil size={13} strokeWidth={2} />}
              onSelect={run(() => actions.rename(node))}
            >
              Rename
            </FileMenuItem>
          )}
          {actions.copyPath && (
            <FileMenuItem onSelect={run(() => actions.copyPath(node))}>Copy Path</FileMenuItem>
          )}
          {!node.isDirectory && actions.copyContent && (
            <FileMenuItem onSelect={run(() => actions.copyContent(node))}>Copy Content</FileMenuItem>
          )}
          {renderExtension(extensions.afterCopy, extensionContext)}
          {!node.isDirectory && actions.chooseIcon && (
            <FileMenuItem onSelect={run(() => actions.chooseIcon(node))}>Choose Icon</FileMenuItem>
          )}
          {renderExtension(extensions.afterIdentity, extensionContext)}
          {renderExtension(extensions.beforeCreate, extensionContext)}
          {hasCreateActions && <FileMenuDivider />}
          {actions.createFile && (
            <FileMenuItem onSelect={run(() => actions.createFile(createTarget))}>New File</FileMenuItem>
          )}
          {actions.createFolder && (
            <FileMenuItem onSelect={run(() => actions.createFolder(createTarget))}>New Folder</FileMenuItem>
          )}
          {renderExtension(extensions.afterCreate, extensionContext)}
          {renderExtension(extensions.beforeDelete, extensionContext)}
          {actions.deleteItems && <FileMenuDivider />}
          {actions.deleteItems && (
            <FileMenuItem destructive onSelect={run(() => actions.deleteItems([node.id], node))}>
              Delete
            </FileMenuItem>
          )}
          {renderExtension(extensions.afterDelete, extensionContext)}
          {actions.revealInFinder && <FileMenuDivider />}
          {actions.revealInFinder && (
            <FileMenuItem onSelect={run(() => actions.revealInFinder(node))}>Open in Finder</FileMenuItem>
          )}
        </>
      ) : (
        <>
          {actions.createFile && (
            <FileMenuItem onSelect={run(() => actions.createFile(null))}>New File</FileMenuItem>
          )}
          {actions.createFolder && (
            <FileMenuItem onSelect={run(() => actions.createFolder(null))}>New Folder</FileMenuItem>
          )}
          {renderExtension(extensions.empty, extensionContext)}
        </>
      )}
    </div>,
    document.body,
  )
}
