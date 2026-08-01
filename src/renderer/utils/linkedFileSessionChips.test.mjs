import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectLinkedFileSessionChips,
  linkedFileSessionChipSnapshot,
} from './linkedFileSessionChips.mjs'

test('projects a linked file tab as a chip for its parent session', () => {
  const tabs = new Map([
    ['session-1', { id: 'session-1', name: 'History repair', commandType: 'claude' }],
    ['file-1', {
      id: 'file-1',
      tabType: 'file',
      filePath: '/repo/docs/plan.md',
      visualParentTabId: 'session-1',
    }],
  ])

  assert.deepEqual(collectLinkedFileSessionChips(tabs), [{
    filePath: '/repo/docs/plan.md',
    fileTabId: 'file-1',
    sessionTabId: 'session-1',
    sessionName: 'History repair',
    sessionKind: 'claude',
  }])
})

test('one file can expose several distinct session chips without duplicates', () => {
  const tabs = [
    { id: 'codex', name: 'Tests', commandType: 'codex' },
    { id: 'sdk', name: 'Architecture', tabType: 'claude-sdk' },
    { id: 'file-a', tabType: 'file', filePath: '/repo/a.md', visualParentTabId: 'codex' },
    { id: 'file-b', tabType: 'file', filePath: '/repo/a.md', visualParentTabId: 'sdk' },
    { id: 'file-duplicate', tabType: 'file', filePath: '/repo/a.md', visualParentTabId: 'codex' },
  ]

  assert.deepEqual(
    collectLinkedFileSessionChips(tabs).map(chip => [chip.sessionName, chip.sessionKind]),
    [['Architecture', 'claude'], ['Tests', 'codex']],
  )
})

test('orphaned and ordinary files do not produce session chips', () => {
  const tabs = [
    { id: 'ordinary', name: 'Terminal' },
    { id: 'plain-file', tabType: 'file', filePath: '/repo/plain.md' },
    { id: 'orphan', tabType: 'file', filePath: '/repo/orphan.md', visualParentTabId: 'missing' },
  ]

  assert.deepEqual(collectLinkedFileSessionChips(tabs), [])
  assert.equal(linkedFileSessionChipSnapshot(tabs), '[]')
})

