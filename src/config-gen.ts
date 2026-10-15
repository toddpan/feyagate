/**
 * `config.yaml` generation — the single writer for the managed fields.
 *
 * The child process both reads and *writes* its own config: saving the Vision
 * model, the trigger engine, or the Xiaozhi endpoint list rewrites the YAML in
 * place. So this file is not "our file" in the usual sense. Two rules keep that
 * from turning into two writers fighting over one document:
 *
 *   1. **We never replace the document.** We load whatever is on disk, deep-set
 *      only the fields listed in `MANAGED_FIELDS`, and write the whole thing
 *      back. Every key we do not own — including keys from a *newer* child
 *      version that we have never heard of — survives untouched.
 *   2. **The managed set is deliberately small.** Port, bind address, and the
 *      data-relative paths we are responsible for. Everything about platforms,
 *      vision, triggers, memory, and skills belongs to the child, and is edited
 *      through its MCP tools, not through us.
 *
 * `data/`-relative paths matter more than they look. The child resolves them
 * against the directory holding this file, and it binds the device id and the
 * license to that same directory. Keeping them relative means the root can be
 * moved as a whole (or backed up and restored) without re-binding the license.
 */

import { chmodSync, existsSync, readFileSync } from 'node:fs'

import { join } from 'node:path'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { DEFAULT_WS_PORT } from './constants.js'
import { configPath, ensureDir, versionDir } from './paths.js'
import { writeFileAtomic } from './util/atomic.js'

/** Dotted paths this plugin owns and may overwrite on every generation. */
export const MANAGED_FIELDS = [
  'server.http_port',
  'server.bind_address',
  'server.webui_dir',
  'server.ws_port',
  'auth.token_file',
  'tuya.token_file',
  'midea.token_file',
  'ewelink.token_file',
  'huawei.token_file',
  'memory.data_dir',
  'skill.user_dir',
  'skill.builtin_dir',
] as const

/**
 * Fields written once, only when absent.
 *
 * These configure the child's own behaviour, so a user who changed them
 * (in the child's WebUI or by hand) must not have that change reverted by a
 * plugin upgrade. Applying them conditionally is what makes an upgrade safe.
 */
export const SEED_ONLY_FIELDS = [
  'camera.frame_interval',
  'camera.buffer_max_size',
  'camera.buffer_ttl',
  'camera.reconnect_min',
  'camera.reconnect_max',
  'camera.jpeg_quality',
  'auth.cloud_server',
  'xiaozhi.reconnect_interval_ms',
  'vision.enabled',
  'vision.base_url',
  'vision.model',
  'trigger.enabled',
  'memory.enabled',
  'skill.enabled',
] as const

export interface ConfigGenerationInput {
  root: string
  /** Port the child is being told to listen on for this start. */
  port: number
  bindAddress?: string
  cloudServer?: string
}

type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getPath(document: Dict, dotted: string): unknown {
  let cursor: unknown = document
  for (const key of dotted.split('.')) {
    if (!isDict(cursor)) return undefined
    cursor = cursor[key]
  }
  return cursor
}

function setPath(document: Dict, dotted: string, value: unknown): void {
  const keys = dotted.split('.')
  let cursor: Dict = document
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key]
    if (!isDict(next)) {
      const created: Dict = {}
      cursor[key] = created
      cursor = created
    } else {
      cursor = next
    }
  }
  cursor[keys.at(-1)!] = value
}

/** Read the config as a plain object; `{}` when absent or unparseable. */
export function loadConfig(root: string): Dict {
  const file = configPath(root)
  if (!existsSync(file)) return {}
  try {
    const parsed = parseYaml(readFileSync(file, 'utf8'))
    return isDict(parsed) ? parsed : {}
  } catch {
    // A config we cannot parse is worse than a config we cannot see: the child
    // would refuse to start or, worse, start with defaults. Surface it instead.
    throw new Error(`无法解析配置文件 ${file}：文件内容可能已损坏。请先备份并删除它，插件会重新生成。`)
  }
}

/** True when the file exists but has no `server.http_port` (a fresh stub). */
export function needsGeneration(root: string): boolean {
  const file = configPath(root)
  if (!existsSync(file)) return true
  try {
    return getPath(loadConfig(root), 'server.http_port') === undefined
  } catch {
    return true
  }
}

/**
 * Write the managed fields into the existing document.
 *
 * @returns the path written and whether the content actually changed, so the
 * caller can log "config regenerated" only when something moved.
 */
export function generateConfig(input: ConfigGenerationInput): { path: string; changed: boolean; document: Dict } {
  const { root } = input
  // The config file lives *at the root*: the child resolves `data/`, `license.json`
  // and every token file relative to this file's directory. See paths.ts.
  ensureDir(root)
  const document = needsGeneration(root) ? {} : loadConfig(root)
  const before = JSON.stringify(document)

  // 1. Seed-only defaults: applied only where the key is absent.
  const seeds: Dict = {
    'server.ws_port': DEFAULT_WS_PORT,
    'camera.frame_interval': 500,
    'camera.buffer_max_size': 20,
    'camera.buffer_ttl': 300,
    'camera.reconnect_min': 3,
    'camera.reconnect_max': 1200,
    'camera.jpeg_quality': 90,
    'auth.cloud_server': input.cloudServer ?? 'cn',
    'xiaozhi.reconnect_interval_ms': 5000,
    'vision.enabled': false,
    'vision.base_url': 'https://api.openai.com/v1',
    'vision.model': 'gpt-4o-mini',
    'trigger.enabled': false,
    'memory.enabled': true,
    'skill.enabled': true,
  }
  for (const [dotted, value] of Object.entries(seeds)) {
    if (getPath(document, dotted) === undefined) setPath(document, dotted, value)
  }

  // 2. Managed fields: always reflect the plugin's current intent.
  setPath(document, 'server.http_port', input.port)
  setPath(document, 'server.bind_address', input.bindAddress ?? '127.0.0.1')
  setPath(document, 'server.webui_dir', 'webui')
  for (const platform of ['auth', 'tuya', 'midea', 'ewelink', 'huawei']) {
    setPath(document, `${platform}.token_file`, `data/${platform === 'auth' ? 'auth_token' : `${platform}_token`}.json`)
  }
  setPath(document, 'license.license_file', 'data/license.json')
  setPath(document, 'memory.data_dir', 'data/memory')
  setPath(document, 'skill.user_dir', 'data/skills')
  setPath(document, 'skill.builtin_dir', 'skills')

  const after = JSON.stringify(document)
  if (before !== after || !existsSync(configPath(root))) {
    // Note: the child rewrites this file itself (yaml-cpp emitter) whenever a
    // settings tool saves, which drops these comments. The comment is for the
    // human reading the file, not a durable marker.
    const text = `# 本文件由 feyagate CLI 生成与管理。\n# 手工修改会被插件的下一次启动覆盖，请通过 feyagate CLI 或 MCP 工具修改。\n# 未被插件管理的键（vision / trigger / xiaozhi 等）会被原样保留。\n${stringifyYaml(document)}`
    // 0600: this file holds the Vision API key once the user configures it.
    writeFileAtomic(configPath(root), text, 0o600)
  }
  try {
    chmodSync(configPath(root), 0o600)
  } catch {
    /* best effort; Windows ignores POSIX modes */
  }

  return { path: configPath(root), changed: before !== after, document }
}

/**
 * Rewrite only `server.http_port`.
 *
 * Used when the preferred port was occupied and we are starting on a drifted
 * one. Doing it as a targeted edit (rather than a full regeneration) keeps the
 * intent explicit: the configured port stays in `state.json`, while the file
 * reflects what this particular start is bound to.
 */
export function applyEffectivePort(root: string, port: number): { path: string; changed: boolean } {
  const document = loadConfig(root)
  const current = getPath(document, 'server.http_port')
  if (current === port) return { path: configPath(root), changed: false }
  setPath(document, 'server.http_port', port)
  writeFileAtomic(
    configPath(root),
    `# 本文件由 feyagate CLI 生成与管理。\n${stringifyYaml(document)}`,
    0o600,
  )
  return { path: configPath(root), changed: true }
}

/**
 * Point `server.webui_dir` at the installed version's own `webui/` directory.
 *
 * The child resolves this value against its working directory, which is the
 * install root — but the release payload puts `webui/` inside the *version*
 * directory. Left as the upstream default (`webui`), `set_mount_point` fails and
 * the child merely logs "WebUI directory not found (web UI disabled)": one
 * silently dropped feature, which is exactly the failure mode that hides for
 * months. An absolute path makes it work, and re-pointing it on every activation
 * keeps it correct across upgrades instead of pinning the old version's assets.
 *
 * Returns without writing when the version ships no `webui/` directory, so a
 * payload change upstream cannot leave a dangling absolute path in the config.
 */
export function applyWebuiDir(root: string, version: string): { path: string; changed: boolean } {
  const target = join(versionDir(root, version), 'webui')
  if (!existsSync(target)) return { path: configPath(root), changed: false }
  const document = loadConfig(root)
  if (getPath(document, 'server.webui_dir') === target) return { path: configPath(root), changed: false }
  setPath(document, 'server.webui_dir', target)
  writeFileAtomic(
    configPath(root),
    `# 本文件由 feyagate CLI 生成与管理。\n${stringifyYaml(document)}`,
    0o600,
  )
  return { path: configPath(root), changed: true }
}

export { getPath as getConfigPath }
