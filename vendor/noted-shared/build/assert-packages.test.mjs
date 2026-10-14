import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertNotedShared } from './assert-packages.mjs'

function fixture({ packageVersion = '0.2.0', staleLocal = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'noted-shared-guard-'))
  const sharedRoot = join(root, 'shared')
  const consumerRoot = join(root, 'consumer')
  mkdirSync(join(sharedRoot, 'packages', 'structured-dnd'), { recursive: true })
  mkdirSync(consumerRoot, { recursive: true })
  writeFileSync(join(sharedRoot, 'package.json'), JSON.stringify({ version: '0.2.0' }))
  writeFileSync(
    join(sharedRoot, 'packages', 'structured-dnd', 'package.json'),
    JSON.stringify({ version: packageVersion }),
  )
  if (staleLocal) {
    mkdirSync(join(consumerRoot, 'packages', 'structured-dnd'), { recursive: true })
    writeFileSync(
      join(consumerRoot, 'packages', 'structured-dnd', 'package.json'),
      JSON.stringify({ version: '0.1.0' }),
    )
  }
  return { root, sharedRoot, consumerRoot }
}

test('accepts one explicitly supported shared version', () => {
  const paths = fixture()
  try {
    assert.doesNotThrow(() => assertNotedShared({
      sharedRoot: paths.sharedRoot,
      consumerRoot: paths.consumerRoot,
      consumer: 'test-consumer',
      packages: ['structured-dnd'],
      expectedVersion: '0.2.0',
    }))
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('rejects a shared package whose version diverges from the accepted version', () => {
  const paths = fixture({ packageVersion: '0.3.0' })
  try {
    assert.throws(() => assertNotedShared({
      sharedRoot: paths.sharedRoot,
      consumerRoot: paths.consumerRoot,
      consumer: 'test-consumer',
      packages: ['structured-dnd'],
      expectedVersion: '0.2.0',
    }), /expects structured-dnd@0\.2\.0, found 0\.3\.0/)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})

test('rejects a stale app-local package copy even when versions match upstream', () => {
  const paths = fixture({ staleLocal: true })
  try {
    assert.throws(() => assertNotedShared({
      sharedRoot: paths.sharedRoot,
      consumerRoot: paths.consumerRoot,
      consumer: 'test-consumer',
      packages: ['structured-dnd'],
      expectedVersion: '0.2.0',
    }), /stale local structured-dnd package/)
  } finally {
    rmSync(paths.root, { recursive: true, force: true })
  }
})
