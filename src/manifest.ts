/**
 * 服务器清单的读取、校验与查询。
 *
 * 清单（`manifest/server-manifest.json`）由构建期的 `scripts/gen-manifest.mjs`
 * 生成，是插件唯一可信的"上游发布了什么"的事实来源。为什么运行时不去猜 URL：
 * 上游同一个仓库的资产名每年都在漂移（`-windows-`/`-win-`、`mac-arm64-v1.2.20`
 * 与 `1.2.17-linux-arm64` 混用，有的版本干脆不发某个平台），拼 URL 的代码会在
 * 某些版本上静默下载到错误的东西。所以这里只做"读 + 校验 + 查询"，绝不构造。
 *
 * 校验策略：结构不合法就抛出带文件路径的明确错误，绝不静默返回空结果 ——
 * 「清单坏了」和「这个版本没有这个平台」是两件完全不同的事，前者必须让人看见。
 */

import { readFileSync, statSync } from 'node:fs'

import { manifestPath } from './paths.js'
import { SERVER_HEALTH_PATH, SERVER_MCP_PATH } from './constants.js'
import { PLATFORM_LABELS, atLeast, compareVersions } from './util/platform.js'
import type {
  ManifestAsset,
  ManifestVersion,
  PlatformTag,
  ResolvedAsset,
  CompatSummary,
  ServerManifest,
} from './types.js'

/**
 * 归档类型优先级：数字越小越优先。zip 优先于 tar.gz 优先于 exe ——
 * zip 在上游是主发布产物（校验值最齐），tar.gz 是副本，裸 exe 只在个别
 * Windows 版本里出现过且清单里没有校验值。
 */
const KIND_RANK: Record<ManifestAsset['kind'], number> = { zip: 0, 'tar.gz': 1, exe: 2 }

/** 清单里允许出现的平台键。出现别的键说明清单被改坏或与插件版本不匹配。 */
const KNOWN_PLATFORMS: readonly string[] = ['mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64', 'win-x64']

const ASSET_KINDS: readonly string[] = ['zip', 'tar.gz', 'exe']

/** 合法的 sha256：64 位小写 hex。生成器只会写小写，兼容大写但会归一化。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/

/**
 * 清单缓存。UI 会轮询状态，而状态里带 `manifest` 字段，逐次重新读盘 + 解析
 * 是纯浪费；用 mtime + size 做键，文件一改就自动失效。
 */
let cached: { key: string; manifest: ServerManifest } | null = null

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(file: string, detail: string): never {
  throw new Error(`服务器清单不可用 (${file}): ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(file: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(file, `${field} 缺失或不是非空字符串`)
  return value
}

function isKnownPlatform(value: string): value is PlatformTag {
  return KNOWN_PLATFORMS.includes(value)
}

/**
 * 读取并校验捆绑的清单。失败时抛出，错误消息里一定带文件绝对路径 ——
 * 安装失败最常见的原因就是打包时清单没被带上，那时路径是唯一有用的线索。
 */
export function loadManifest(): ServerManifest {
  const file = manifestPath()
  let raw: string
  let key: string
  try {
    const info = statSync(file)
    key = `${info.mtimeMs}:${info.size}`
    if (cached !== null && cached.key === key) return cached.manifest
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`读取服务器清单失败 (${file}): ${describe(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`服务器清单不是合法 JSON (${file}): ${describe(error)}`)
  }

  const manifest = validate(file, parsed)
  cached = { key, manifest }
  return manifest
}

/**
 * 结构校验 + 归一化。只保留 `ServerManifest` 里声明的字段：多余字段被丢掉，
 * 免得清单里的历史残留悄悄影响行为。
 */
function validate(file: string, value: unknown): ServerManifest {
  if (!isRecord(value)) fail(file, '顶层不是 JSON 对象')

  if (value.manifestVersion !== 1) {
    fail(file, `manifestVersion 必须是 1，实际是 ${JSON.stringify(value.manifestVersion)}`)
  }

  const server = value.server
  if (!isRecord(server)) fail(file, 'server 缺失或不是对象')
  const serverName = requireString(file, server.name, 'server.name')
  const serverRepo = requireString(file, server.repo, 'server.repo')

  const sources = value.sources
  if (!isRecord(sources)) fail(file, 'sources 缺失或不是对象')
  // fota 允许为空串（表示这个渠道没配），但字段本身必须在：否则运行时
  // 读 undefined 会变成一次莫名的网络请求失败。
  if (typeof sources.fota !== 'string') fail(file, 'sources.fota 缺失或不是字符串')
  const githubBase = typeof sources.github === 'string' ? sources.github : ''

  const compat = value.pluginCompat
  if (!isRecord(compat)) fail(file, 'pluginCompat 缺失或不是对象')
  const minSupported = requireString(file, compat.minSupportedServer, 'pluginCompat.minSupportedServer')
  const maxTested = typeof compat.maxTestedServer === 'string' ? compat.maxTestedServer : null

  const versions = value.versions
  if (!isRecord(versions)) fail(file, 'versions 缺失或不是对象')
  const versionKeys = Object.keys(versions)
  if (versionKeys.length === 0) fail(file, 'versions 为空，清单里没有任何可安装版本')

  const normalized: Record<string, ManifestVersion> = {}
  for (const version of versionKeys) {
    const entry = versions[version]
    if (!isRecord(entry)) fail(file, `versions["${version}"] 不是对象`)
    const releaseTag = requireString(file, entry.releaseTag, `versions["${version}"].releaseTag`)
    const publishedAt = typeof entry.publishedAt === 'string' ? entry.publishedAt : ''

    const assets = entry.assets
    if (!isRecord(assets)) fail(file, `versions["${version}"].assets 缺失或不是对象`)
    const perPlatform: Partial<Record<PlatformTag, ManifestAsset[]>> = {}
    for (const platformKey of Object.keys(assets)) {
      if (!isKnownPlatform(platformKey)) {
        fail(file, `versions["${version}"].assets 里出现未知平台键 "${platformKey}"`)
      }
      const list = assets[platformKey]
      if (!Array.isArray(list)) {
        fail(file, `versions["${version}"].assets["${platformKey}"] 不是数组`)
      }
      const parsedAssets: ManifestAsset[] = []
      for (let index = 0; index < list.length; index += 1) {
        parsedAssets.push(validateAsset(file, version, platformKey, index, list[index]))
      }
      // 空数组等于"这个平台没有资产"，归一化成 undefined，让所有查询只判一种情况。
      if (parsedAssets.length > 0) perPlatform[platformKey] = parsedAssets
    }

    normalized[version] = { releaseTag, publishedAt, assets: perPlatform }
  }

  const fotaType = normalizeFotaType(file, value.fotaType)
  const channel = normalizeChannel(file, value.channel)

  return {
    manifestVersion: 1,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    server: {
      name: serverName,
      repo: serverRepo,
      // 路径缺失时回落到常量，避免下游拿到 undefined 拼出坏 URL。
      mcpPath: typeof server.mcpPath === 'string' && server.mcpPath !== '' ? server.mcpPath : SERVER_MCP_PATH,
      healthPath:
        typeof server.healthPath === 'string' && server.healthPath !== '' ? server.healthPath : SERVER_HEALTH_PATH,
    },
    sources: { github: githubBase, fota: sources.fota },
    fotaType,
    pluginCompat: { minSupportedServer: minSupported, maxTestedServer: maxTested },
    channel,
    versions: normalized,
  }
}

function validateAsset(file: string, version: string, platform: string, index: number, value: unknown): ManifestAsset {
  const where = `versions["${version}"].assets["${platform}"][${index}]`
  if (!isRecord(value)) fail(file, `${where} 不是对象`)
  const name = requireString(file, value.file, `${where}.file`)
  const kind = value.kind
  if (typeof kind !== 'string' || !ASSET_KINDS.includes(kind)) {
    fail(file, `${where}.kind 必须是 zip / tar.gz / exe，实际是 ${JSON.stringify(kind)}`)
  }
  const url = requireString(file, value.url, `${where}.url`)
  const size = value.size
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    fail(file, `${where}.size 必须是非负数字`)
  }

  let sha256: string | null = null
  if (value.sha256 !== null && value.sha256 !== undefined) {
    if (typeof value.sha256 !== 'string') fail(file, `${where}.sha256 必须是字符串或 null`)
    const digest = value.sha256.trim().toLowerCase()
    // 半截或格式不对的校验值比 null 更危险：它会让"已校验"变成假象。
    if (!SHA256_PATTERN.test(digest)) fail(file, `${where}.sha256 不是 64 位 hex：${JSON.stringify(value.sha256)}`)
    sha256 = digest
  }

  return { file: name, kind: kind as ManifestAsset['kind'], size, url, sha256 }
}

function normalizeFotaType(file: string, value: unknown): Partial<Record<PlatformTag, string | null>> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) fail(file, 'fotaType 必须是对象')
  const result: Partial<Record<PlatformTag, string | null>> = {}
  for (const key of Object.keys(value)) {
    if (!isKnownPlatform(key)) fail(file, `fotaType 里出现未知平台键 "${key}"`)
    const entry = value[key]
    if (entry === null || entry === undefined) {
      result[key] = null
      continue
    }
    if (typeof entry !== 'string') fail(file, `fotaType["${key}"] 必须是字符串或 null`)
    result[key] = entry.trim() === '' ? null : entry.trim()
  }
  return result
}

function normalizeChannel(file: string, value: unknown): { stable: Partial<Record<PlatformTag, string | null>> } {
  if (value === undefined || value === null) return { stable: {} }
  if (!isRecord(value)) fail(file, 'channel 必须是对象')
  const stableRaw = value.stable
  if (stableRaw === undefined || stableRaw === null) return { stable: {} }
  if (!isRecord(stableRaw)) fail(file, 'channel.stable 必须是对象')
  const stable: Partial<Record<PlatformTag, string | null>> = {}
  for (const key of Object.keys(stableRaw)) {
    if (!isKnownPlatform(key)) fail(file, `channel.stable 里出现未知平台键 "${key}"`)
    const entry = stableRaw[key]
    if (entry === null || entry === undefined) {
      stable[key] = null
      continue
    }
    if (typeof entry !== 'string') fail(file, `channel.stable["${key}"] 必须是字符串或 null`)
    stable[key] = entry
  }
  return { stable }
}

/** 该平台真正发布过安装包的版本，升序（旧 → 新）。 */
export function listVersionsForPlatform(m: ServerManifest, p: PlatformTag): string[] {
  const found: string[] = []
  for (const version of Object.keys(m.versions)) {
    const list = m.versions[version]?.assets[p]
    if (list !== undefined && list.length > 0) found.push(version)
  }
  return found.sort(compareVersions)
}

/** 该平台能装的最新版本；一个都没有时返回 null。 */
export function latestVersionForPlatform(m: ServerManifest, p: PlatformTag): string | null {
  const versions = listVersionsForPlatform(m, p)
  return versions.length === 0 ? null : (versions[versions.length - 1] ?? null)
}

/**
 * 排序权重：先按归档类型，再让同一类型的"有 sha256"排在前面。
 * 同一构建产物可能同时发 zip 和 tar.gz（1.2.17 linux-arm64 甚至发了两个
 * 内容相同的 tar.gz），能校验的那个永远更值得下。
 */
function assetRank(asset: ManifestAsset): number {
  return KIND_RANK[asset.kind] * 2 + (asset.sha256 === null ? 1 : 0)
}

/** 解析出该平台该版本优先级最高的资产；没有则该版本在这个平台不可装。 */
export function resolveAsset(m: ServerManifest, p: PlatformTag, version: string): ResolvedAsset | null {
  const list = m.versions[version]?.assets[p]
  if (list === undefined || list.length === 0) return null
  let best: ManifestAsset | null = null
  for (const asset of list) {
    if (best === null || assetRank(asset) < assetRank(best)) best = asset
  }
  if (best === null) return null
  return { version, platform: p, asset: best, unverified: best.sha256 === null }
}

/** 状态栏需要的清单摘要（避免 UI 为了这几行再取一次清单）。 */
export function compatSummary(m: ServerManifest, p: PlatformTag): CompatSummary {
  return {
    minSupportedServer: m.pluginCompat.minSupportedServer,
    maxTestedServer: m.pluginCompat.maxTestedServer,
    latestVersion: latestVersionForPlatform(m, p),
    latestVersionMatches: p,
  }
}

/**
 * 这个版本在这个平台上能不能装。两道门：
 *
 *  1. `minSupportedServer` 是硬门槛 —— 低于它的子进程与当前插件的 HTTP/MCP
 *     接口不兼容，装上去只会得到一个起不来的服务，所以必须在下载之前拒绝。
 *  2. 清单里必须有该平台的资产，否则无从下载。
 *
 * 版本号不可解析时 `compareVersions` 把它排在一切之下，于是这里会走第 1 条
 * 拒绝：拼错的版本号永远不可能被当成"升级"放行。
 */
export function isVersionUsable(
  m: ServerManifest,
  p: PlatformTag,
  version: string,
): { ok: true } | { ok: false; reason: string } {
  const minimum = m.pluginCompat.minSupportedServer
  if (!atLeast(version, minimum)) {
    return {
      ok: false,
      reason: `服务器版本 ${version} 低于插件要求的最低版本 ${minimum}，请升级到 ${minimum} 或更高版本`,
    }
  }
  const list = m.versions[version]?.assets[p]
  if (list === undefined || list.length === 0) {
    return { ok: false, reason: `清单里没有 ${PLATFORM_LABELS[p]} 平台的 ${version} 安装包` }
  }
  return { ok: true }
}
