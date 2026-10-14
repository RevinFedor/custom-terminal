import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const NOTED_SHARED_VERSION = '0.2.0'

function packageVersion(packageJsonPath) {
  if (!existsSync(packageJsonPath)) {
    throw new Error(`[noted-shared] Missing package manifest: ${packageJsonPath}`)
  }
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version
}

export function assertNotedShared({
  sharedRoot,
  consumerRoot,
  consumer,
  packages,
  expectedVersion = NOTED_SHARED_VERSION,
}) {
  const rootVersion = packageVersion(resolve(sharedRoot, 'package.json'))
  if (rootVersion !== expectedVersion) {
    throw new Error(`[noted-shared] ${consumer} expects ${expectedVersion}, root is ${rootVersion}`)
  }

  for (const packageName of packages) {
    const sharedManifest = resolve(sharedRoot, 'packages', packageName, 'package.json')
    const actualVersion = packageVersion(sharedManifest)
    if (actualVersion !== expectedVersion) {
      throw new Error(
        `[noted-shared] ${consumer} expects ${packageName}@${expectedVersion}, found ${actualVersion}`,
      )
    }

    const staleLocalManifest = resolve(consumerRoot, 'packages', packageName, 'package.json')
    if (existsSync(staleLocalManifest)) {
      throw new Error(
        `[noted-shared] ${consumer} has a stale local ${packageName} package; remove ${staleLocalManifest}`,
      )
    }
  }

  console.log(`[noted-shared] ${consumer} -> ${packages.join(', ')}@${expectedVersion}`)
}
