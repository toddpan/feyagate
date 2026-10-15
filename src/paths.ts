/**
 * Filesystem layout.
 *
 * Everything this plugin owns lives under one root, and the *shape* below is a
 * compatibility contract:
 *
 *   <root>/
 *     state.json                  the only mutable bookkeeping file
 *     config.yaml                 generated; read back and merged, never clobbered
 *     data/                       child-owned: tokens, license.json, memory, skills
 *     logs/server.log             child stdout/stderr, size-capped
 *     versions/<version>/         one immutable install per version
 *     cache/                      downloaded archives and extracted staging
 *     current                     pointer file naming the active version
 *
 * `config.yaml` sits **at the root, not in a `config/` subdirectory**, and that
 * is not a style choice. The child resolves every relative path against the
 * directory holding the config file (`src/config.cpp` → `resolve_path`, applied
 * to `license_file`, every `*_token_file`, `memory.data_dir`, and
 * `skill.*_dir`), and `src/main.cpp` derives its own data directory the same
 * way. So "the directory next to config.yaml" *is* the data root. Putting the
 * file in `config/` would silently relocate `data/` to `config/data/`, and —
 * worse — move `license.json`, which is where the device id and the license
 * binding live. A user upgrading the plugin would appear as a new device and
 * get a fresh free trial.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOME_DIR_NAME } from './constants.js'

/** Install root: `$FEYAGATE_HOME`, else `~/.feyagate-mcp`. */
export function defaultRoot(): string {
  const configured = process.env.FEYAGATE_HOME
  if (configured !== undefined && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), HOME_DIR_NAME)
}

/** `<root>/server.pid`: written on spawn, removed on clean stop. */
export function pidFile(root: string): string {
  return join(root, 'server.pid')
}

/**
 * Package directory (contains `manifest/`).
 *
 * One level up, not two: this module lives at `src/paths.ts` in the checkout and
 * at `lib/paths.js` in the published package, and both are exactly one level
 * below the package root. Getting this wrong is invisible until run time, when
 * the manifest silently fails to load and every platform reports "no version".
 */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Absolute path of the bundled server manifest. */
export function manifestPath(): string {
  return join(packageRoot(), 'manifest', 'server-manifest.json')
}

export function stateFile(root: string): string {
  return join(root, 'state.json')
}

/** The generated child config. Its directory is the child's data root. */
export function configPath(root: string): string {
  return join(root, 'config.yaml')
}

/** Child-owned data directory (tokens, license.json, memory, skills). */
export function dataDir(root: string): string {
  return join(root, 'data')
}

export function logsDir(root: string): string {
  return join(root, 'logs')
}

export function serverLogPath(root: string): string {
  return join(logsDir(root), 'server.log')
}

export function versionsDir(root: string): string {
  return join(root, 'versions')
}

export function versionDir(root: string, version: string): string {
  return join(versionsDir(root), version.replace(/[^0-9A-Za-z._-]/g, '_'))
}

export function cacheDir(root: string): string {
  return join(root, 'cache')
}

/** Pointer file naming the active version (a file, not a symlink: Windows). */
export function currentPointerPath(root: string): string {
  return join(root, 'current')
}

export function readCurrentPointer(root: string): string | null {
  const file = currentPointerPath(root)
  if (!existsSync(file)) return null
  try {
    const value = readFileSync(file, 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

/**
 * Remove the `current` pointer.
 *
 * The pointer is the tiebreaker read at startup, so a state that says "nothing
 * is current" while the pointer still names a version would be silently
 * overridden back to that version on the next boot.
 */
export function clearCurrentPointer(root: string): void {
  rmSync(currentPointerPath(root), { force: true })
}

export function writeCurrentPointer(root: string, version: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(currentPointerPath(root), `${version}\n`, 'utf8')
}

/** List version directories that contain an executable. */
export function listInstalledVersions(root: string, binary: string): string[] {
  const dir = versionsDir(root)
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const candidate = join(dir, entry)
    try {
      if (!statSync(candidate).isDirectory()) continue
    } catch {
      continue
    }
    if (existsSync(join(candidate, binary))) found.push(entry)
  }
  return found
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

/** Create every directory the plugin expects, idempotently. */
export function ensureLayout(root: string): void {
  for (const path of [root, dataDir(root), logsDir(root), versionsDir(root), cacheDir(root)]) {
    ensureDir(path)
  }
}
