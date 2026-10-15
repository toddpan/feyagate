/**
 * 安装编排：下载 → 校验 → 解压 → 落位。
 *
 * 这个文件里最重要的不是流程本身，而是**顺序**和**清理**：
 *
 *  * **先校验、后解压**。解压会把外部字节变成可执行文件；只有确认字节与
 *    发布侧一致之后才允许发生。校验失败就删掉下载文件并抛出 —— 绝不"先解开
 *    看看再说"，那样落进 staging 的东西已经没有意义，但已经消耗了解压器的
 *    攻击面（zip bomb、路径穿越）。
 *  * **staging 是唯一的写入点**。所有解压/改权限/签名都发生在一个随机命名的
 *    staging 目录里，最后整目录 `rename` 到 `versions/<version>`。中途失败时
 *    `versions/` 里不会留下半个安装（半个安装会让 UI 显示"已安装"而进程起不来）。
 *  * **一次失败只影响一个来源**。网络、404、校验不通过都只是"换下一个来源"，
 *    全部失败才抛聚合错误，且消息里逐条列出试过谁、为什么失败。
 */

import { existsSync, readdirSync, readFileSync, cpSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { DOWNLOAD_TIMEOUT_MS } from '../constants.js'
import { cacheDir, ensureDir, versionDir, versionsDir } from '../paths.js'
import { isMac } from '../util/platform.js'
import { extractArchive, detectArchiveKind, ensureExecutableMode, fixMacQuarantine, flattenSingleTopDir } from './extract.js'
import { downloadToFile, fetchText, isAbortError } from './fetch.js'
import { describeVerification, md5File, sha256File } from './verify.js'
import type { DownloadProgress } from './fetch.js'
import type { DownloadPlan } from './sources.js'
import type { PlatformTag } from '../util/platform.js'

/** 拉取 `<url>.sha256` 侧边车文件的超时：它只是个几十字节的小文件。 */
const SIDECAR_TIMEOUT_MS = 15_000

/** 已安装时的占位来源：让返回值保持同一个形状，同时诚实说明没有下载。 */
const EXISTING_INSTALL_PLAN: DownloadPlan = {
  kind: 'local',
  label: '已安装（未重新下载）',
  url: null,
  isLocalFile: false,
  expectedSha256: null,
  expectedMd5: null,
}

export interface InstallBinaryOptions {
  root: string
  platform: PlatformTag
  version: string
  binary: string
  plans: DownloadPlan[]
  signal: AbortSignal
  allowUnverified: boolean
  /**
   * 显式重装。默认（false/未给）是幂等的：目标版本已装好就直接返回成功。
   * 但"修复/重装同一个版本"必须能真的重下一次，调用方（`install.ts` 的
   * `reinstall`）要么传这个开关，要么先把 `versions/<version>` 删掉 ——
   * 只靠默认行为重装会变成一次空操作，用户看到"已安装"却什么都没修。
   */
  reinstall?: boolean
  onProgress: (p: {
    phase: 'downloading' | 'verifying' | 'extracting'
    percent: number | null
    bytesDone: number | null
    bytesTotal: number | null
    message: string
  }) => void
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

export interface InstallBinaryResult {
  version: string
  versionDir: string
  binaryPath: string
  usedPlan: DownloadPlan
  /** 实际在本地算出的 sha256（未校验时也记录，供用户事后核对）。 */
  sha256: string | null
  /** 依次失败的来源与原因，失败时用于展示"我试过哪些"。 */
  attempts: Array<{ label: string; error: string }>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cancelledError(): Error {
  const error = new Error('安装已取消')
  error.name = 'AbortError'
  return error
}

function percentOf(progress: DownloadProgress): number | null {
  if (progress.bytesTotal === null || progress.bytesTotal <= 0) return null
  return Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
}

/**
 * 缓存文件名。来源地址可能带查询串（签名 URL），必须剥掉；也绝不允许出现
 * 路径分隔符 —— 文件名是远程可控输入，`..%2f` 这类东西一旦拼进 cacheDir
 * 就是一次目录穿越写。
 */
function archiveFileName(url: string): string {
  const withoutFragment = url.split('#')[0] ?? ''
  const withoutQuery = withoutFragment.split('?')[0] ?? ''
  const parts = withoutQuery.split(/[\\/]/).filter((part) => part !== '')
  const last = parts[parts.length - 1]
  if (last === undefined || last === '' || last === '.' || last === '..' || last.includes('\0')) {
    throw new Error(`无法从来源地址推断缓存文件名：${url}`)
  }
  return last
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 校验值来源的优先级：plan 自带的 sha256 → 下载时的 `.sha256` 侧边车 →
 * FOTA 的 md5。侧边车只在"清单没给校验值"时才去取，因为清单里的值本身
 * 就来自发布侧的侧边车，没必要每次安装都多打一次网络。
 */
async function readSidecarSha256(
  plan: DownloadPlan,
  log: InstallBinaryOptions['log'],
): Promise<string | null> {
  if (plan.url === null) return null
  // The FOTA channel publishes its own md5 inside its manifest. GitHub's
  // `.sha256` sidecar convention does not exist there, so probing for one is a
  // guaranteed 404 — one wasted round trip and one misleading "校验值获取失败"
  // warning on every single install. Skip straight to the md5 fallback.
  if (plan.kind === 'fota') return null
  try {
    let text: string
    if (plan.isLocalFile) {
      const sidecar = `${plan.url}.sha256`
      if (!existsSync(sidecar)) return null
      text = readFileSync(sidecar, 'utf8')
    } else {
      text = await fetchText(`${plan.url}.sha256`, { timeoutMs: SIDECAR_TIMEOUT_MS })
    }
    const match = /([0-9a-f]{64})/i.exec(text)
    return match === null ? null : match[1]!.toLowerCase()
  } catch (error) {
    log.warn(`未能取得 .sha256 侧边车校验值（${describe(error)}），继续按已知校验值处理`)
    return null
  }
}

/**
 * 就位。先删掉同名旧目录再 rename：rename 到已存在的非空目录会失败，
 * 而"重装同一个版本"是必须支持的（上一次装坏了要靠它修）。
 */
function activateVersion(staging: string, targetDir: string, log: InstallBinaryOptions['log']): void {
  if (existsSync(targetDir)) {
    log.warn(`目标版本目录已存在，先删除再就位：${targetDir}`)
    rmSync(targetDir, { recursive: true, force: true })
  }
  try {
    renameSync(staging, targetDir)
    return
  } catch (error) {
    const code = (error as { code?: unknown }).code
    // 缓存与 versions 通常在同一分区，但用户可以配置不同磁盘。
    if (code !== 'EXDEV') throw error
    log.warn('跨设备 rename 不可用，退化为复制 + 删除 staging')
  }
  try {
    cpSync(staging, targetDir, { recursive: true })
  } catch (error) {
    // 复制到一半失败会在 versions/ 里留下半个安装，必须清掉。
    rmSync(targetDir, { recursive: true, force: true })
    throw error
  }
  rmSync(staging, { recursive: true, force: true })
}

/**
 * 在 staging 里定位主二进制。
 *
 * 这里刻意**不做全盘搜索**：找到了也不会把它单独挪上来，因为二进制旁边
 * 通常还有 dylib/资源，挪走主程序等于装坏。找不到就报错并列出实际内容，
 * 让人一眼看出上游打包结构变了。
 */
function resolveBinaryPath(staging: string, binary: string, kind: 'zip' | 'tar.gz' | 'exe', archiveName: string): string {
  const direct = join(staging, binary)
  if (isFile(direct)) return direct

  if (kind === 'exe') {
    // exe 类型是按源文件名落地的（清单里就叫 miloco-mcp-server.exe）；
    // 用户给的本地包可能叫别的名字，同目录改名不会影响任何资源布局。
    const source = join(staging, basename(archiveName))
    if (source !== direct && isFile(source)) {
      renameSync(source, direct)
      return direct
    }
  }

  const top = readdirSync(staging)
  const nested = top
    .map((name) => join(staging, name, binary))
    .filter((candidate) => isFile(candidate))
  const hint =
    nested.length > 0
      ? `；在子目录里发现 ${nested.join(', ')}，但上层应把它上移一层（单顶层目录未被识别）`
      : ''
  throw new Error(`解压后没有找到可执行文件 ${binary}；顶层内容：${top.join(', ') || '(空)'}${hint}`)
}

/**
 * 按优先级依次尝试各来源，装出 `versions/<version>/<binary>`。
 *
 * 幂等：目标已存在且二进制在就直接返回；不做重复下载，也不去"修复"它
 * （修复是 repair 语义，由上层先删目录再调这里，或显式传 reinstall）。
 */
export async function installBinary(options: InstallBinaryOptions): Promise<InstallBinaryResult> {
  const { root, platform, version, binary, plans, signal, allowUnverified, onProgress, log } = options
  const targetDir = versionDir(root, version)
  const targetBinary = join(targetDir, binary)

  if (existsSync(targetBinary)) {
    if (options.reinstall !== true) {
      log.info(`版本 ${version} 已安装（${targetBinary}），跳过下载`)
      return {
        version,
        versionDir: targetDir,
        binaryPath: targetBinary,
        usedPlan: plans[0] ?? EXISTING_INSTALL_PLAN,
        sha256: null,
        attempts: [],
      }
    }
    // 重装：整棵目录要重下重铺。这里不动磁盘 —— 只有全部校验通过、staging 铺好
    // 之后才会在 activateVersion 里替换旧目录，所以重装中途失败仍留着重装前的版本。
    log.info(`按要求重装 v${version}：将重新下载并覆盖 ${targetDir}`)
  }

  if (plans.length === 0) {
    throw new Error('没有可用的下载来源：清单与本地配置里都没有有效的安装包地址')
  }

  const cache = ensureDir(cacheDir(root))
  // versions/ 是 rename 的父目录，必须先存在：Windows 上 rename 不会自动建父目录。
  ensureDir(versionsDir(root))
  const attempts: Array<{ label: string; error: string }> = []

  for (const plan of plans) {
    if (signal.aborted) throw cancelledError()

    if (plan.skipReason !== undefined || plan.url === null) {
      const reason = plan.skipReason ?? '来源不可用（没有下载地址）'
      log.warn(`跳过来源 ${plan.label}：${reason}`)
      attempts.push({ label: plan.label, error: reason })
      continue
    }

    const archiveName = archiveFileName(plan.url)
    const kind = plan.archiveKind ?? detectArchiveKind(archiveName)
    const cached = join(cache, archiveName)
    const staging = join(cache, `staging-${randomBytes(6).toString('hex')}`)
    let downloaded = false

    try {
      if (kind === null) {
        throw new Error(`无法识别的安装包格式：${archiveName}（只支持 .zip / .tar.gz / .exe）`)
      }

      log.info(`尝试来源 ${plan.label}：${plan.url}`)

      // ① 下载（或复用命中缓存的包 —— 无论复用与否，下面都会重新校验）
      const canReuseCache = plan.expectedSha256 !== null && existsSync(cached)
      if (canReuseCache) {
        log.info(`命中缓存 ${cached}，仍会重新校验`)
        onProgress({
          phase: 'downloading',
          percent: 100,
          bytesDone: null,
          bytesTotal: null,
          message: `复用已缓存的 ${archiveName}（将重新校验）`,
        })
      } else {
        onProgress({
          phase: 'downloading',
          percent: 0,
          bytesDone: 0,
          bytesTotal: null,
          message: `正在从 ${plan.label} 下载 ${archiveName}`,
        })
        await downloadToFile({
          url: plan.url,
          dest: cached,
          signal,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          onProgress: (progress) => {
            onProgress({
              phase: 'downloading',
              percent: percentOf(progress),
              bytesDone: progress.bytesDone,
              bytesTotal: progress.bytesTotal,
              message: `正在从 ${plan.label} 下载 ${archiveName}`,
            })
          },
        })
        downloaded = true
      }

      // ② 校验。失败必须删文件并抛出，绝不放行到解压。
      let actualSha256: string | null = null
      try {
        onProgress({
          phase: 'verifying',
          percent: null,
          bytesDone: null,
          bytesTotal: null,
          message: `正在校验 ${archiveName}`,
        })
        const sidecar = plan.expectedSha256 === null ? await readSidecarSha256(plan, log) : null
        const expectedSha256 = plan.expectedSha256 ?? sidecar
        const expectedMd5 = expectedSha256 === null ? plan.expectedMd5 : null

        if (expectedSha256 === null && expectedMd5 === null && !allowUnverified) {
          throw new Error(
            `来源 ${plan.label} 没有任何可用的校验值（sha256/md5 都缺失）；` +
              '出于安全考虑不会安装未校验的包，需要用户显式确认后才能继续',
          )
        }
        log.info(`${plan.label}：${describeVerification(expectedSha256, expectedMd5)}`)

        if (expectedSha256 !== null) {
          const actual = await sha256File(cached)
          if (actual !== expectedSha256) {
            throw new Error(`SHA-256 校验失败：期望 ${expectedSha256}，实际 ${actual}`)
          }
          actualSha256 = actual
        } else if (expectedMd5 !== null) {
          const actual = await md5File(cached)
          if (actual !== expectedMd5) {
            throw new Error(`MD5 校验失败：期望 ${expectedMd5}，实际 ${actual}`)
          }
          actualSha256 = await sha256File(cached)
        } else {
          // 用户已确认安装未校验的包：仍然算一次 sha256 记进结果，便于事后核对。
          actualSha256 = await sha256File(cached)
          log.warn(`按用户确认安装未校验的包 ${archiveName}（本地 sha256=${actualSha256}）`)
        }
      } catch (error) {
        rmSync(cached, { force: true })
        log.error(`校验未通过，已删除下载文件 ${archiveName}：${describe(error)}`)
        throw error
      }

      // ③ 解压到 staging
      onProgress({
        phase: 'extracting',
        percent: null,
        bytesDone: null,
        bytesTotal: null,
        message: `正在解压 ${archiveName}`,
      })
      const extracted = await extractArchive({
        archive: cached,
        kind,
        destDir: staging,
        onProgress: (progress) => {
          onProgress({
            phase: 'extracting',
            percent:
              progress.entriesTotal === null || progress.entriesTotal <= 0
                ? null
                : Math.min(100, Math.round((progress.entriesDone / progress.entriesTotal) * 100)),
            bytesDone: null,
            bytesTotal: null,
            message: progress.message,
          })
        },
      })
      log.info(
        `解压完成：写入 ${extracted.filesWritten} 个文件；顶层条目 ${
          extracted.topLevelEntries.join(', ') || '(无)'
        }`,
      )

      // ④ 归一化布局 → 权限 → macOS 隔离属性/签名
      if (await flattenSingleTopDir(staging)) {
        log.info('归档只有一个顶层目录，已把其内容上移一层')
      }
      resolveBinaryPath(staging, binary, kind, archiveName)
      await ensureExecutableMode(join(staging, binary))
      if (isMac(platform)) {
        const fix = await fixMacQuarantine(staging)
        if (fix.deQuarantined) log.info('已移除 macOS 隔离属性 com.apple.quarantine')
        for (const file of fix.signed) log.info(`已 ad-hoc 签名：${file}`)
        for (const warning of fix.warnings) log.warn(warning)
      }

      // ⑤ 原子就位
      activateVersion(staging, targetDir, log)
      // 走复制路径时权限位可能没被带上，补一次（幂等）。
      await ensureExecutableMode(targetBinary)
      log.info(`安装完成：${targetBinary}`)

      if (attempts.length > 0) {
        log.warn(`本次安装前有 ${attempts.length} 个来源失败：${attempts.map((item) => item.label).join('、')}`)
      }
      return {
        version,
        versionDir: targetDir,
        binaryPath: targetBinary,
        usedPlan: plan,
        sha256: actualSha256,
        attempts,
      }
    } catch (error) {
      // 任何失败都不留残骸：staging 一定删，下到一半的文件也删。
      rmSync(staging, { recursive: true, force: true })
      if (downloaded) rmSync(cached, { force: true })

      if (isAbortError(error) || signal.aborted) {
        log.warn(`安装已取消（来源 ${plan.label}）`)
        throw isAbortError(error) ? error : cancelledError()
      }

      const reason = describe(error)
      log.error(`来源 ${plan.label} 失败：${reason}`)
      attempts.push({ label: plan.label, error: reason })
    } finally {
      // 成功的路径上 staging 已经被 rename/复制走了，这里是幂等的兜底。
      rmSync(staging, { recursive: true, force: true })
    }
  }

  throw new Error(
    `全部 ${plans.length} 个下载来源都失败了：\n${attempts
      .map((item) => `  · ${item.label}：${item.error}`)
      .join('\n')}`,
  )
}
