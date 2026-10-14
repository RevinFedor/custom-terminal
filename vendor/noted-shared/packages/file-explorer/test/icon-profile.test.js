import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mutateSharedFileIconProfile,
  normalizeFileIconProfile,
  sameFileIconProfile,
  shouldImportLegacyFileIconOverrides,
  shouldSeedFileIconProfileFromLegacy,
} from '../src/iconProfile.js'

test('profile normalization preserves only supported icon settings', () => {
  const profile = normalizeFileIconProfile({
    iconTheme: 'emoji',
    customIconRules: [
      { type: 'filename', filename: 'README.md', image: 'data:readme' },
      { extension: '.prompt.md', image: 'data:prompt' },
      { patterns: [], image: 'data:invalid' },
    ],
    nameOverrides: { 'one.md': 'vscode', empty: '', invalid: 42 },
    legacyImports: { gtEditorProduction: true },
  })

  assert.equal(profile.iconTheme, 'emoji')
  assert.deepEqual(profile.customIconRules, [
    { type: 'filename', patterns: ['README.md'], image: 'data:readme' },
    { type: 'extension', patterns: ['.prompt.md'], image: 'data:prompt' },
  ])
  assert.deepEqual(profile.nameOverrides, { 'one.md': 'vscode' })
  assert.deepEqual(profile.legacyImports, {
    gtEditorDevelopment: false,
    gtEditorProduction: true,
    customTerminalDevelopment: false,
    customTerminalProduction: false,
  })
})

test('CAS mutation retries against the newest profile', async () => {
  let server = normalizeFileIconProfile({ nameOverrides: { 'server.md': 'vscode' } })
  let revision = 1
  let writes = 0
  const result = await mutateSharedFileIconProfile({
    get: async () => ({ revision, profile: server }),
    put: async (profile, expectedRevision) => {
      writes += 1
      if (writes === 1) {
        server = normalizeFileIconProfile({ ...server, iconTheme: 'emoji' })
        revision += 1
        return { conflict: true, revision, profile: server }
      }
      assert.equal(expectedRevision, revision)
      server = profile
      revision += 1
      return { ok: true, revision, profile: server }
    },
  }, profile => ({
    ...profile,
    nameOverrides: { ...profile.nameOverrides, 'local.md': 'data:local' },
  }))

  assert.equal(writes, 2)
  assert.equal(result.profile.iconTheme, 'emoji')
  assert.deepEqual(result.profile.nameOverrides, {
    'local.md': 'data:local',
    'server.md': 'vscode',
  })
  assert.equal(sameFileIconProfile(result.profile, server), true)
})

test('only production GT Editor may seed the shared profile from legacy settings', () => {
  const empty = normalizeFileIconProfile({})
  assert.equal(shouldSeedFileIconProfileFromLegacy(empty, 'gtEditorDevelopment'), false)
  assert.equal(shouldSeedFileIconProfileFromLegacy(empty, 'customTerminalProduction'), false)
  assert.equal(shouldSeedFileIconProfileFromLegacy(empty, 'gtEditorProduction'), true)

  const migrated = normalizeFileIconProfile({
    legacyImports: { gtEditorProduction: true },
  })
  assert.equal(shouldSeedFileIconProfileFromLegacy(migrated, 'gtEditorProduction'), false)
})

test('only production Custom Terminal may import legacy exact-name overrides', () => {
  const empty = normalizeFileIconProfile({})
  assert.equal(shouldImportLegacyFileIconOverrides(empty, 'customTerminalDevelopment'), false)
  assert.equal(shouldImportLegacyFileIconOverrides(empty, 'gtEditorProduction'), false)
  assert.equal(shouldImportLegacyFileIconOverrides(empty, 'customTerminalProduction'), true)

  const migrated = normalizeFileIconProfile({
    legacyImports: { customTerminalProduction: true },
  })
  assert.equal(shouldImportLegacyFileIconOverrides(migrated, 'customTerminalProduction'), false)
})
