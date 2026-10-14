import test from 'node:test'
import assert from 'node:assert/strict'
import { hasSidebarLayoutEntries } from '../src/sidebarLayout.js'

test('manual mode depends on layout content, not storage revision', () => {
  assert.equal(hasSidebarLayoutEntries(null), false)
  assert.equal(hasSidebarLayoutEntries({ orderByParent: {}, visualParentByPath: {} }), false)
  assert.equal(hasSidebarLayoutEntries({ orderByParent: { __root__: [] }, visualParentByPath: {} }), false)
  assert.equal(hasSidebarLayoutEntries({ orderByParent: { __root__: ['/tmp/a'] }, visualParentByPath: {} }), true)
  assert.equal(hasSidebarLayoutEntries({ orderByParent: {}, visualParentByPath: { '/tmp/b': '/tmp/a' } }), true)
})
