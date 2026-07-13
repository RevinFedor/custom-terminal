import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const sourcePath = fileURLToPath(new URL('../src/FileRow.jsx', import.meta.url))

const mocks = new Map([
  ['react', `
    export const memo = (component) => component;
    export const useState = (initial) => [initial, () => {}];
    export const useEffect = (effect) => { effect(); };
    export const useRef = (initial) => {
      if (!globalThis.__fileRowRefClaimed) {
        globalThis.__fileRowRefClaimed = true;
        return { current: globalThis.__fileRowElement };
      }
      return { current: initial };
    };
    const React = {
      Fragment: Symbol('Fragment'),
      createElement(type, props, ...children) {
        const flat = children.flat(Infinity).filter((child) => (
          child !== null && child !== undefined && child !== false
        ));
        return {
          type,
          props: {
            ...(props || {}),
            children: flat.length < 2 ? flat[0] : flat,
          },
        };
      },
    };
    export default React;
  `],
  ['@atlaskit/pragmatic-drag-and-drop/element/adapter', `
    export const draggable = (config) => {
      globalThis.__fileRowDraggable = config;
      return () => {};
    };
    export const dropTargetForElements = (config) => {
      globalThis.__fileRowDropTarget = config;
      return () => {};
    };
  `],
  ['@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview', `
    export const disableNativeDragPreview = () => {};
  `],
  ['@atlaskit/pragmatic-drag-and-drop/prevent-unhandled', `
    export const preventUnhandled = { start() {} };
  `],
  ['@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', `
    export const attachClosestEdge = (data) => data;
    export const extractClosestEdge = () => null;
  `],
  ['./FileIcon', 'export default function FileIcon() { return null; }'],
])

const result = await build({
  entryPoints: [sourcePath],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  jsx: 'transform',
  logLevel: 'silent',
  plugins: [{
    name: 'file-row-test-mocks',
    setup(esbuild) {
      esbuild.onResolve({ filter: /.*/ }, (args) => (
        mocks.has(args.path) ? { path: args.path, namespace: 'file-row-test' } : undefined
      ))
      esbuild.onLoad({ filter: /.*/, namespace: 'file-row-test' }, (args) => ({
        contents: mocks.get(args.path),
        loader: 'js',
      }))
    },
  }],
})

const compiledSource = result.outputFiles[0].text
const { default: FileRow } = await import(
  `data:text/javascript;base64,${Buffer.from(compiledSource).toString('base64')}`
)

function renderRow({ isDirectory = true, isEditing = false } = {}) {
  const calls = {
    toggle: [],
    select: [],
    rename: [],
    contextMenu: [],
  }
  const node = {
    id: isDirectory ? '/tmp/folder' : '/tmp/file.md',
    name: isDirectory ? 'folder' : 'file.md',
    parentId: '/tmp',
    isDirectory,
  }

  globalThis.__fileRowRefClaimed = false
  globalThis.__fileRowElement = { nodeType: 1 }
  globalThis.__fileRowDraggable = undefined

  const tree = FileRow({
    node,
    level: 0,
    isExpanded: false,
    isEditing,
    onToggle: (id) => calls.toggle.push(id),
    onSelect: (modifiers) => calls.select.push(modifiers),
    onStartRename: (target) => calls.rename.push(target.id),
    onCommitRename: () => {},
    onCancelRename: () => {},
    onContextMenu: (_event, target) => calls.contextMenu.push(target.id),
  })

  return {
    tree,
    node,
    calls,
    draggable: globalThis.__fileRowDraggable,
  }
}

function findByClass(element, className) {
  if (!element || typeof element !== 'object') return null
  if (element.props?.className === className) return element
  const children = element.props?.children
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    const match = findByClass(child, className)
    if (match) return match
  }
  return null
}

function targetMatching(needle = null) {
  return {
    closest(selector) {
      return needle && selector.includes(needle) ? this : null
    },
  }
}

function mouseEvent(target, overrides = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    ...overrides,
  }
}

function dispatchWithBubble(tree, control, handlerName, event) {
  control.props?.[handlerName]?.(event)
  if (!event.propagationStopped) tree.props?.[handlerName]?.(event)
}

test('folder chevron owns one completed click', () => {
  const { tree, node, calls } = renderRow()
  const chevron = findByClass(tree, 'arborist-chevron')

  assert.equal(chevron.type, 'button')
  assert.equal(chevron.props.type, 'button')
  assert.equal(chevron.props['data-no-card-drag'], true)
  assert.equal(chevron.props.onPointerDown, undefined)

  const event = mouseEvent(targetMatching('button'))
  dispatchWithBubble(tree, chevron, 'onClick', event)

  assert.deepEqual(calls.toggle, [node.id])
  assert.deepEqual(calls.select, [])
  assert.deepEqual(calls.rename, [])
  assert.equal(event.propagationStopped, true)
})

test('folder body click still toggles and selects exactly once', () => {
  const { tree, node, calls } = renderRow()
  tree.props.onClick(mouseEvent(targetMatching()))

  assert.deepEqual(calls.toggle, [node.id])
  assert.deepEqual(calls.select, [{}])
})

test('file chevron placeholder lets click and drag belong to the row', () => {
  const { tree, calls, draggable } = renderRow({ isDirectory: false })
  const placeholder = findByClass(tree, 'arborist-chevron')

  assert.equal(placeholder.type, 'span')
  assert.equal(placeholder.props.onClick, undefined)
  assert.equal(placeholder.props['data-no-card-drag'], undefined)

  dispatchWithBubble(tree, placeholder, 'onClick', mouseEvent(targetMatching()))
  assert.deepEqual(calls.select, [{ metaKey: false, shiftKey: false }])

  const originalDocument = globalThis.document
  globalThis.document = { elementFromPoint: () => targetMatching() }
  try {
    assert.equal(draggable.canDrag({ input: { clientX: 4, clientY: 6 } }), true)
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('rapid chevron clicks toggle once per click without row rename', () => {
  const { tree, node, calls } = renderRow()
  const chevron = findByClass(tree, 'arborist-chevron')

  dispatchWithBubble(tree, chevron, 'onClick', mouseEvent(targetMatching('button')))
  dispatchWithBubble(tree, chevron, 'onClick', mouseEvent(targetMatching('button')))
  dispatchWithBubble(tree, chevron, 'onDoubleClick', mouseEvent(targetMatching('button')))

  assert.deepEqual(calls.toggle, [node.id, node.id])
  assert.deepEqual(calls.select, [])
  assert.deepEqual(calls.rename, [])
})

test('modified primary chevron clicks stay owned by the chevron', async (t) => {
  for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    await t.test(modifier, () => {
      const { tree, node, calls } = renderRow()
      const chevron = findByClass(tree, 'arborist-chevron')
      const event = mouseEvent(targetMatching('button'), { [modifier]: true })

      dispatchWithBubble(tree, chevron, 'onClick', event)

      assert.deepEqual(calls.toggle, [node.id])
      assert.deepEqual(calls.select, [])
    })
  }
})

test('context menu is separate from chevron activation', () => {
  const { tree, node, calls } = renderRow()
  const chevron = findByClass(tree, 'arborist-chevron')
  const event = mouseEvent(targetMatching('button'), { button: 2 })

  dispatchWithBubble(tree, chevron, 'onContextMenu', event)

  assert.deepEqual(calls.toggle, [])
  assert.deepEqual(calls.select, [])
  assert.deepEqual(calls.contextMenu, [node.id])
})

test('nested controls cannot start row drag, while the row body can', () => {
  const { draggable } = renderRow()
  const originalDocument = globalThis.document
  let hit = targetMatching()
  const points = []
  globalThis.document = {
    elementFromPoint(x, y) {
      points.push([x, y])
      return hit
    },
  }

  try {
    const input = { clientX: 17, clientY: 29 }

    hit = targetMatching('[data-no-card-drag]')
    assert.equal(draggable.canDrag({ input }), false)

    hit = targetMatching('button')
    assert.equal(draggable.canDrag({ input }), false)

    hit = targetMatching('input')
    assert.equal(draggable.canDrag({ input }), false)

    hit = targetMatching()
    assert.equal(draggable.canDrag({ input }), true)
    assert.deepEqual(points.at(-1), [17, 29])
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('editing disables row drag without changing body rename behavior', () => {
  const editing = renderRow({ isEditing: true })
  assert.equal(editing.draggable.canDrag({ input: { clientX: 0, clientY: 0 } }), false)

  const { tree, node, calls } = renderRow()
  tree.props.onDoubleClick(mouseEvent(targetMatching()))
  assert.deepEqual(calls.rename, [node.id])
})
