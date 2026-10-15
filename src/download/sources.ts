/**
 * 下载来源的收集与排序。
 *
 * 上游有四个可能的包来源，可靠性依次下降，所以顺序即优先级：
 *
 *   ① github —— 清单里记录的**精确** URL（含发布侧 sha256），唯一"该版本必然
 *      存在过"的来源；
 *   ② fota   —— 官方 OTA 渠道，运行时读 `fota.json`。它是**独立渠道**：
 *      文件名、版本号都和 GitHub 不一样（`miloco-mcp-server-1.2.19-Darwin-x86_64.tar.gz`），
 *      所以只能按 `type` 匹配，绝不能拿文件名去比对；
 *   ③ mirror —— 用户自建镜像前缀，URL 由 `<前缀>/<文件名>` 拼出，沿用 GitHub 的
 *      sha256（镜像只是搬运，内容应当逐字节一致）；
 *   ④ local  —— 用户自己指定的本地压缩包（内网/离线场景）。
 *
 * 任何一个来源都不允许把整体拖垮：FOTA 拿不到、镜像没配、本地文件不存在，
 * 都只让那一个来源"缺席"。缺席原因会写进 plan 的 `skipReason` 并留在返回
 * 列表里 —— 失败时 UI 才能说清"我试过/为什么没试哪些来源"。
 */

import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { DOWNLOAD_TIMEOUT_MS } from '../constants.js'
import { PLATFORM_LABELS } from '../util/platform.js'
import { detectArchiveKind } from './extract.js'
import { fetchText } from './fetch.js'
import type { ManifestAsset, ServerManifest } from '../types.js'
import type { PlatformTag } from '../util/platform.js'

export type SourceKind = 'github' | 'fota' | 'mirror' | 'local'

export interface DownloadPlan {
  kind: SourceKind
  /** 面向用户的一句话来源描述，例如 "GitHub Releases v1.2.20"。 */
  label: string
  /** 下载地址；`isLocalFile` 为 true 时是本地绝对路径。跳过项为 null。 */
  url: string | null
  isLocalFile: boolean
  expectedSha256: string | null
  expectedMd5: string | null
  /**
   * 归档类型。清单里已经写明（GitHub/镜像就是同一个文件），FOTA 与本地包则
   * 由各自的文件名推断 —— 解压器选错类型会直接报错，所以能带就带上，
   * 别让下游再猜一次。
   */
  archiveKind?: 'zip' | 'tar.gz' | 'exe'
  /**
   * 该来源为什么不可用。带此字段的 plan 只是"诊断记录"：
   * `installBinary` 会把它算作一次没试成的来源，绝不会拿它去下载。
   */
  skipReason?: string
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MD5_PATTERN = /^[0-9a-f]{32}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 校验并归一化一个 https 地址；不合法返回 null（该来源降级，不抛错）。 */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  return parsed.protocol === 'https:' ? parsed.toString() : null
}

function normalizeSha256(value: string | null): string | null {
  if (value === null) return null
  const digest = value.trim().toLowerCase()
  return SHA256_PATTERN.test(digest) ? digest : null
}

function normalizeMd5(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const digest = value.trim().toLowerCase()
  return MD5_PATTERN.test(digest) ? digest : null
}

/** 从 URL 的最后一段推断归档类型（FOTA 的文件名与 GitHub 完全不同，只能看它自己）。 */
function archiveKindFromUrl(url: string): 'zip' | 'tar.gz' | 'exe' | undefined {
  try {
    const last = new URL(url).pathname
      .split('/')
      .filter((segment) => segment !== '')
      .pop()
    if (last === undefined) return undefined
    return detectArchiveKind(decodeURIComponent(last)) ?? undefined
  } catch {
    return undefined
  }
}

function skipped(kind: SourceKind, label: string, reason: string): DownloadPlan {
  return {
    kind,
    label,
    url: null,
    isLocalFile: false,
    expectedSha256: null,
    expectedMd5: null,
    skipReason: reason,
  }
}

export async function buildDownloadPlans(options: {
  manifest: ServerManifest
  platform: PlatformTag
  version: string
  asset: ManifestAsset
  /** 用户可配置的镜像前缀，例如 https://mirror.example.com/miloco */
  mirrorBase: string | null
  /** 用户点选/配置的本地压缩包绝对路径 */
  localArchive: string | null
  timeoutMs?: number
}): Promise<DownloadPlan[]> {
  const { manifest, platform, version, asset, mirrorBase, localArchive } = options
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const releaseTag = manifest.versions[version]?.releaseTag ?? version
  const sha256 = normalizeSha256(asset.sha256)
  const plans: DownloadPlan[] = []

  // ① GitHub Releases：清单里的精确 URL。
  const githubLabel = `GitHub Releases ${releaseTag}`
  const githubUrl = httpsUrl(asset.url)
  if (githubUrl === null) {
    plans.push(skipped('github', githubLabel, `清单里的资产 URL 不是合法的 https 地址：${asset.url}`))
  } else {
    plans.push({
      kind: 'github',
      label: githubLabel,
      url: githubUrl,
      isLocalFile: false,
      expectedSha256: sha256,
      expectedMd5: null,
      archiveKind: asset.kind,
    })
  }

  // ② FOTA：运行时取清单，按 type 匹配（不比对文件名/版本）。
  plans.push(await buildFotaPlan(manifest, platform, timeoutMs))

  // ③ 镜像前缀：镜像只是搬运，沿用原 sha256 才有意义。
  const mirrorLabel = '自定义镜像'
  if (mirrorBase === null || mirrorBase.trim() === '') {
    plans.push(skipped('mirror', mirrorLabel, '未配置镜像前缀'))
  } else {
    const base = httpsUrl(mirrorBase.trim())
    if (base === null) {
      plans.push(skipped('mirror', mirrorLabel, `镜像前缀不是合法的 https 地址：${mirrorBase}`))
    } else {
      // 镜像站常被复制粘贴成 "https://host/base/"，多一个斜杠会得到 404。
      const url = httpsUrl(`${base.replace(/\/+$/, '')}/${asset.file}`)
      if (url === null) {
        plans.push(skipped('mirror', mirrorLabel, `拼出的镜像地址不合法：${base}/${asset.file}`))
      } else {
        const host = new URL(url).host
        plans.push({
          kind: 'mirror',
          label: `自定义镜像 ${host}`,
          url,
          isLocalFile: false,
          expectedSha256: sha256,
          expectedMd5: null,
          archiveKind: asset.kind,
        })
      }
    }
  }

  // ④ 本地包：完全离线/内网场景。
  //
  // 校验值来自**清单**，不是来源，所以这里必须照抄 asset 的期望值，不能置 null。
  // 用户手头这个文件就是上游发的那个资产（手动下载或内网镜像给的），清单里
  // 记的正是它的指纹；置 null 会让"本地兜底"和"完整性校验"变成互斥 —— 想用
  // 本地包就必须关掉校验，等于把最需要防线的那条路径的门锁拆了。
  const localLabel = '本地安装包'
  if (localArchive === null || localArchive.trim() === '') {
    plans.push(skipped('local', localLabel, '未指定本地安装包'))
  } else {
    const path = resolve(localArchive.trim())
    if (!existsSync(path)) {
      plans.push(skipped('local', `本地安装包 ${basename(path)}`, `本地文件不存在：${path}`))
    } else {
      plans.push({
        kind: 'local',
        label: `本地安装包 ${basename(path)}`,
        url: path,
        isLocalFile: true,
        expectedSha256: asset.sha256 ?? null,
        // 清单只发布 sha256；md5 仅 FOTA 渠道才有，这里保持一致。
        expectedMd5: null,
        archiveKind: detectArchiveKind(basename(path)) ?? undefined,
      })
    }
  }

  return plans
}

/**
 * FOTA 渠道。失败一律降级成一条 skipReason，绝不抛错：FOTA 是补充来源，
 * 它挂了不该让整个安装失败（GitHub 通常还能用）。
 */
async function buildFotaPlan(manifest: ServerManifest, platform: PlatformTag, timeoutMs: number): Promise<DownloadPlan> {
  const label = `官方 FOTA 渠道 (${PLATFORM_LABELS[platform]})`
  const type = manifest.fotaType[platform]
  if (type === null || type === undefined || type.trim() === '') {
    return skipped('fota', label, `${PLATFORM_LABELS[platform]} 没有配置 FOTA type`)
  }

  const endpoint = manifest.sources.fota.trim()
  if (endpoint === '') return skipped('fota', label, '清单里没有配置 FOTA 地址')

  let text: string
  try {
    text = await fetchText(endpoint, { timeoutMs })
  } catch (error) {
    return skipped('fota', label, `FOTA 清单获取失败：${describe(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return skipped('fota', label, `FOTA 清单不是合法 JSON：${describe(error)}`)
  }
  if (!Array.isArray(parsed)) return skipped('fota', label, 'FOTA 清单顶层不是 JSON 数组')

  const entry = parsed.find((row) => isRecord(row) && row.type === type)
  if (entry === undefined) return skipped('fota', label, `FOTA 清单里没有 type=${type} 的条目`)

  const url = httpsUrl(entry.url)
  if (url === null) {
    return skipped('fota', label, `type=${type} 条目的 url 缺失或不是 https 地址`)
  }

  const md5 = normalizeMd5(entry.md5)
  return {
    kind: 'fota',
    label: `${label} · ${type}`,
    url,
    isLocalFile: false,
    // FOTA 只给 md5；sha256 缺失时由安装流程决定是否降级到 md5。
    expectedSha256: null,
    expectedMd5: md5,
    archiveKind: archiveKindFromUrl(url),
  }
}
