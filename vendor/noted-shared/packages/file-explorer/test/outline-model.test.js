import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROOT_LAYOUT_PARENT,
  buildFileOutline,
  findOutlineLocation,
  outlineToSidebarLayout,
  planFileOutlineCommit,
} from '../src/outline/model.js'

const rootPath = '/root'

const file = (id, visualParentId = null) => ({
  id: `${rootPath}/${id}`,
  name: id,
  isDirectory: false,
  visualParentId,
})

test('buildFileOutline reconstructs visual file hierarchy without losing physical folders', () => {
  const parent = file('parent.md')
  const child = file('child.md')
  const folder = {
    id: `${rootPath}/folder`,
    name: 'folder',
    isDirectory: true,
    hasChildren: true,
    children: [file('folder/nested.md')],
  }
  const outline = buildFileOutline([parent, child, folder], {
    rootPath,
    expandedState: { [folder.id]: true },
    layout: {
      orderByParent: { [ROOT_LAYOUT_PARENT]: [folder.id, parent.id, child.id] },
      visualParentByPath: { [child.id]: parent.id },
    },
  })

  assert.deepEqual(outline.map(node => node.id), [folder.id, parent.id])
  assert.equal(findOutlineLocation(outline, child.id).parentId, parent.id)
  assert.equal(findOutlineLocation(outline, `${rootPath}/folder/nested.md`).parentId, folder.id)
})

test('saved manual order does not override an active name/date sort', () => {
  const newest = file('newest.md')
  const olderA = file('older-a.md')
  const olderB = file('older-b.md')
  const layout = {
    orderByParent: {
      [ROOT_LAYOUT_PARENT]: [olderB.id, olderA.id],
    },
  }

  const sortedOutline = buildFileOutline([newest, olderA, olderB], {
    rootPath,
    layout,
    sortMode: 'mtime-desc',
  })
  const manualOutline = buildFileOutline([newest, olderA, olderB], {
    rootPath,
    layout,
    sortMode: 'manual',
  })

  assert.deepEqual(sortedOutline.map(node => node.id), [newest.id, olderA.id, olderB.id])
  assert.deepEqual(manualOutline.map(node => node.id), [olderB.id, olderA.id, newest.id])
})

test('layout conversion preserves unloaded parent entries and rewrites represented groups', () => {
  const folderId = `${rootPath}/closed`
  const outline = buildFileOutline([
    file('b.md'),
    file('a.md'),
    { id: folderId, name: 'closed', isDirectory: true, hasChildren: true, children: [] },
  ], { rootPath, expandedState: {} })

  const layout = outlineToSidebarLayout(outline, {
    rootPath,
    previousLayout: {
      orderByParent: { [folderId]: [`${folderId}/hidden.md`] },
      visualParentByPath: {},
    },
  })

  assert.deepEqual(layout.orderByParent[ROOT_LAYOUT_PARENT], [
    `${rootPath}/b.md`,
    `${rootPath}/a.md`,
    folderId,
  ])
  assert.deepEqual(layout.orderByParent[folderId], [`${folderId}/hidden.md`])
})

test('commit plan distinguishes visual reorder from physical folder move', () => {
  const source = file('source.md')
  const folder = {
    id: `${rootPath}/folder`,
    name: 'folder',
    isDirectory: true,
    hasChildren: false,
    children: [],
  }
  const original = buildFileOutline([source, folder], { rootPath })
  const preview = [
    { ...folder, id: folder.id },
  ]
  preview[0] = {
    ...original[1],
    expanded: true,
    data: { ...original[1].data, childrenLoaded: true },
    children: [original[0]],
  }

  const plan = planFileOutlineCommit({
    originalOutline: original,
    previewOutline: preview,
    sourceId: source.id,
    rootPath,
    previousLayout: {},
  })

  assert.equal(plan.requiresPhysicalMove, true)
  assert.equal(plan.destinationFolder, folder.id)
  assert.equal(plan.expandDestination, true)
  assert.equal(plan.action.kind, 'move')
  assert.deepEqual(plan.layout.orderByParent[folder.id], [source.id])
})

test('file parent creates visual hierarchy without changing physical destination', () => {
  const parent = file('parent.md')
  const source = file('source.md')
  const original = buildFileOutline([parent, source], { rootPath })
  const preview = [{ ...original[0], children: [original[1]], hasChildren: true }]
  const plan = planFileOutlineCommit({
    originalOutline: original,
    previewOutline: preview,
    sourceId: source.id,
    rootPath,
    previousLayout: {},
  })

  assert.equal(plan.requiresPhysicalMove, false)
  assert.equal(plan.expandDestination, false)
  assert.equal(plan.action.kind, 'layout')
  assert.equal(plan.layout.visualParentByPath[source.id], parent.id)
})

test('physical move carries every independent filesystem root in a visual file subtree', () => {
  const source = file('source.md')
  const child = file('child.md')
  const grandchild = file('grandchild.md')
  const siblingChild = file('sibling-child.md')
  const folder = {
    id: `${rootPath}/folder`,
    name: 'folder',
    isDirectory: true,
    hasChildren: false,
    children: [],
  }
  const original = buildFileOutline([source, child, grandchild, siblingChild, folder], {
    rootPath,
    layout: {
      visualParentByPath: {
        [child.id]: source.id,
        [grandchild.id]: child.id,
        [siblingChild.id]: source.id,
      },
    },
  })
  const sourceNode = original.find(node => node.id === source.id)
  const folderNode = original.find(node => node.id === folder.id)
  const preview = [{
    ...folderNode,
    expanded: true,
    data: { ...folderNode.data, childrenLoaded: true },
    children: [sourceNode],
  }]

  const plan = planFileOutlineCommit({
    originalOutline: original,
    previewOutline: preview,
    sourceId: source.id,
    rootPath,
    previousLayout: {},
  })

  assert.deepEqual(plan.sourceIds, [source.id, child.id, grandchild.id, siblingChild.id])
  assert.deepEqual(plan.physicalSourceIds, [source.id, child.id, grandchild.id, siblingChild.id])
  assert.deepEqual(plan.action.sourceIds, plan.sourceIds)
  assert.deepEqual(plan.action.physicalSourceIds, plan.physicalSourceIds)
})

test('physical move does not schedule descendants already carried by a folder rename', () => {
  const sourceFolder = {
    id: `${rootPath}/source-folder`,
    name: 'source-folder',
    isDirectory: true,
    hasChildren: true,
    children: [file('source-folder/child.md')],
  }
  const destinationFolder = {
    id: `${rootPath}/destination-folder`,
    name: 'destination-folder',
    isDirectory: true,
    hasChildren: false,
    children: [],
  }
  const original = buildFileOutline([sourceFolder, destinationFolder], {
    rootPath,
    expandedState: { [sourceFolder.id]: true },
  })
  const sourceNode = original.find(node => node.id === sourceFolder.id)
  const destinationNode = original.find(node => node.id === destinationFolder.id)
  const preview = [{
    ...destinationNode,
    expanded: true,
    data: { ...destinationNode.data, childrenLoaded: true },
    children: [sourceNode],
  }]

  const plan = planFileOutlineCommit({
    originalOutline: original,
    previewOutline: preview,
    sourceId: sourceFolder.id,
    rootPath,
    previousLayout: {},
  })

  assert.deepEqual(plan.sourceIds, [sourceFolder.id, `${sourceFolder.id}/child.md`])
  assert.deepEqual(plan.physicalSourceIds, [sourceFolder.id])
})
