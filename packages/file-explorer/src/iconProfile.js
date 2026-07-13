export const FILE_ICON_PROFILE_SCHEMA_VERSION = 2

export const DEFAULT_FILE_ICON_PROFILE = Object.freeze({
  schemaVersion: FILE_ICON_PROFILE_SCHEMA_VERSION,
  iconTheme: 'vscode',
  customIconRules: Object.freeze([]),
  nameOverrides: Object.freeze({}),
  legacyImports: Object.freeze({
    gtEditorDevelopment: false,
    gtEditorProduction: false,
    customTerminalDevelopment: false,
    customTerminalProduction: false,
  }),
})

const normalizeRule = (rule) => {
  if (!rule || typeof rule !== 'object' || typeof rule.image !== 'string' || !rule.image) return null

  let patterns = []
  if (Array.isArray(rule.patterns)) patterns = rule.patterns
  else if (rule.type === 'filename' && rule.filename) patterns = [rule.filename]
  else if (rule.extension) patterns = [rule.extension]

  patterns = [...new Set(patterns
    .filter(pattern => typeof pattern === 'string')
    .map(pattern => pattern.trim())
    .filter(Boolean))]

  if (patterns.length === 0) return null
  return {
    type: rule.type === 'filename' ? 'filename' : 'extension',
    patterns,
    image: rule.image,
  }
}

export function normalizeFileIconProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {}
  const nameOverrides = {}
  for (const key of Object.keys(source.nameOverrides || {}).sort()) {
    const value = source.nameOverrides[key]
    if (key && typeof value === 'string' && value) nameOverrides[key] = value
  }

  return {
    schemaVersion: FILE_ICON_PROFILE_SCHEMA_VERSION,
    iconTheme: source.iconTheme === 'emoji' ? 'emoji' : 'vscode',
    customIconRules: (Array.isArray(source.customIconRules) ? source.customIconRules : [])
      .map(normalizeRule)
      .filter(Boolean),
    nameOverrides,
    legacyImports: {
      gtEditorDevelopment: source.legacyImports?.gtEditorDevelopment === true,
      gtEditorProduction: source.legacyImports?.gtEditorProduction === true,
      customTerminalDevelopment: source.legacyImports?.customTerminalDevelopment === true,
      customTerminalProduction: source.legacyImports?.customTerminalProduction === true,
    },
  }
}

export function sameFileIconProfile(left, right) {
  return JSON.stringify(normalizeFileIconProfile(left)) === JSON.stringify(normalizeFileIconProfile(right))
}

// The installed GT Editor owns the one-time migration because its private DB
// contains the user's canonical icon settings. Dev profiles are disposable and
// may contain E2E data, so they must never seed the cross-application profile.
export function shouldSeedFileIconProfileFromLegacy(profile, source) {
  if (source !== 'gtEditorProduction') return false
  return !normalizeFileIconProfile(profile).legacyImports.gtEditorProduction
}

// Custom Terminal owns only its historical exact-name overrides. As with the
// GT Editor seed, import them from the installed app, never from a dev profile.
export function shouldImportLegacyFileIconOverrides(profile, source) {
  if (source !== 'customTerminalProduction') return false
  return !normalizeFileIconProfile(profile).legacyImports.customTerminalProduction
}

export async function mutateSharedFileIconProfile({ get, put }, mutation, initialResult = null) {
  let current = initialResult || await get()

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const base = normalizeFileIconProfile(current?.profile)
    const next = normalizeFileIconProfile(mutation(base))
    if (Number(current?.revision) > 0 && sameFileIconProfile(base, next)) {
      return { ...current, ok: true, unchanged: true, profile: base }
    }

    const result = await put(next, Number(current?.revision) || 0)
    if (!result?.conflict) {
      return { ...result, profile: normalizeFileIconProfile(result?.profile || next) }
    }
    current = result
  }

  return { ...current, profile: normalizeFileIconProfile(current?.profile) }
}
