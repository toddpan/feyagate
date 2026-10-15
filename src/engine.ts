/**
 * Engine lifecycle for the headless skill: install, start, upgrade, rollback,
 * prune, uninstall, and the `doctor` report agents read before every session.
 *
 * Invariants (carried over from the DSH plugin, ADR-0004):
 *
 *  1. **Only pinned bits run.** Every asset's sha256 ships inside this npm
 *     package (`manifest/server-manifest.json`). A download that does not match
 *     is deleted before extraction. Unverified assets need `--allow-unverified`.
 *  2. **versions/<v>/ is immutable.** An upgrade installs next to the old
 *     version; nothing is overwritten in place, so rollback is a pointer flip.
 *  3. **pending handshake.** A new version is recorded as `pending` before it
 *     starts and becomes `current`/`lastKnownGood` only after `/health`. A
 *     failed start rolls back to the previous version immediately; a pending
 *     entry found later (crash, power loss) is rolled back on the next start.
 *  4. **No silent network or install.** Read-only commands never download.
 *     Installing or upgrading requires `--yes`; without it the CLI returns the
 *     plan and exits with code 3 so the agent can ask the user first.
 */

import { rmSync } from 'node:fs'

import { buildDownloadPlans } from './download/sources.js'
import { installBinary } from './download/index.js'
import { verifyMachODeps } from './download/mach-deps.js'
import { fetchText } from './download/fetch.js'
import { compatSummary, isVersionUsable, latestVersionForPlatform, listVersionsForPlatform, loadManifest, resolveAsset } from './manifest.js'
import { listInstalledVersions, versionDir } from './paths.js'
import { StateStore } from './state.js'
import { inspect, startEngine, stopEngine, type RunningInfo } from './supervise/process.js'
import { binaryName, compareVersions, detectPlatformTag, PLATFORM_LABELS, type PlatformTag } from './util/platform.js'

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1, readonly data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'CliError'
  }
}

/** Exit code meaning "this needs the user's consent; re-run with --yes". */
export const EXIT_NEEDS_CONFIRMATION = 3

export interface Logger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export function requirePlatform(): PlatformTag {
  const tag = detectPlatformTag()
  if (tag === null) throw new CliError(`不支持的平台：${process.platform}-${process.arch}（支持 macOS arm64/x64、Linux x64/arm64、Windows x64）`)
  return tag
}

export interface EngineContext {
  root: string
  platform: PlatformTag
  state: StateStore
  log: Logger
}

export function createContext(root: string, log: Logger): EngineContext {
  return { root, platform: requirePlatform(), state: new StateStore(root), log }
}

function installed(ctx: EngineContext): string[] {
  return listInstalledVersions(ctx.root, binaryName(ctx.platform)).sort(compareVersions)
}

/** Default target: the manifest's stable channel for this platform, else the newest asset. */
export function targetVersion(ctx: EngineContext, requested?: string | null): string {
  const manifest = loadManifest()
  const version = requested ?? manifest.channel.stable[ctx.platform] ?? latestVersionForPlatform(manifest, ctx.platform)
  if (version === null || version === undefined) throw new CliError(`清单里没有 ${PLATFORM_LABELS[ctx.platform]} 可用的引擎版本`)
  const usable = isVersionUsable(manifest, ctx.platform, version)
  if (!usable.ok) throw new CliError(usable.reason)
  return version
}

export interface InstallPlan {
  action: 'install' | 'upgrade'
  platform: PlatformTag
  fromVersion: string | null
  toVersion: string
  asset: { file: string; size: number; url: string; sha256: string | null }
  hosts: string[]
  installRoot: string
}

export function planInstall(ctx: EngineContext, requested?: string | null): InstallPlan {
  const manifest = loadManifest()
  const toVersion = targetVersion(ctx, requested)
  const resolved = resolveAsset(manifest, ctx.platform, toVersion)
  if (resolved === null) throw new CliError(`清单里没有 ${PLATFORM_LABELS[ctx.platform]} 的 ${toVersion} 安装包`)
  const current = ctx.state.get().currentVersion
  return {
    action: current === null ? 'install' : 'upgrade',
    platform: ctx.platform,
    fromVersion: current,
    toVersion,
    asset: { file: resolved.asset.file, size: resolved.asset.size, url: resolved.asset.url, sha256: resolved.asset.sha256 },
    hosts: ['github.com', 'objects.githubusercontent.com', 'oneapi.sooncore.com (仅在 GitHub 失败时作为备用源)'],
    installRoot: ctx.root,
  }
}

/** Download + verify + extract into versions/<v>/. Never touches the running engine. */
export async function downloadVersion(
  ctx: EngineContext,
  version: string,
  options: { allowUnverified?: boolean; localArchive?: string | null; mirror?: string | null; reinstall?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<{ version: string; sha256: string | null; source: string }> {
  const manifest = loadManifest()
  const resolved = resolveAsset(manifest, ctx.platform, version)
  if (resolved === null) throw new CliError(`清单里没有 ${PLATFORM_LABELS[ctx.platform]} 的 ${version} 安装包`)
  if (resolved.unverified && options.allowUnverified !== true) {
    throw new CliError(`${version} 的安装包没有发布 sha256，默认拒绝安装；确认来源可信后加 --allow-unverified`, EXIT_NEEDS_CONFIRMATION)
  }
  const plans = await buildDownloadPlans({
    manifest,
    platform: ctx.platform,
    version,
    asset: resolved.asset,
    mirrorBase: options.mirror ?? null,
    localArchive: options.localArchive ?? null,
  })
  // A local archive is the user's explicit choice: try it first.
  plans.sort((a, b) => (a.kind === 'local' && a.skipReason === undefined ? -1 : 0) - (b.kind === 'local' && b.skipReason === undefined ? -1 : 0))
  let lastPercent = -10
  const result = await installBinary({
    root: ctx.root,
    platform: ctx.platform,
    version,
    binary: binaryName(ctx.platform),
    plans,
    signal: new AbortController().signal,
    allowUnverified: options.allowUnverified === true,
    reinstall: options.reinstall === true,
    onProgress: (p) => {
      if (p.phase === 'downloading' && p.percent !== null) {
        if (p.percent - lastPercent < 10 && p.percent !== 100) return
        lastPercent = p.percent
        options.onProgress?.(`${p.message} ${p.percent}%`)
      } else if (p.phase !== 'downloading') {
        options.onProgress?.(p.message)
      }
    },
    log: ctx.log,
  })
  await verifyMachODeps(versionDir(ctx.root, version), binaryName(ctx.platform), ctx.platform, ctx.log)
  return { version, sha256: result.sha256, source: result.usedPlan.label }
}

export interface ActivateResult {
  ok: boolean
  version: string
  port: number | null
  rolledBackTo: string | null
  error: string | null
}

/**
 * Stop whatever runs, start `version` under the pending handshake, and roll
 * back to `lastKnownGood` when it does not become healthy.
 */
export async function activate(ctx: EngineContext, version: string): Promise<ActivateResult> {
  const before = ctx.state.get()
  await stopEngine(ctx.root)
  ctx.state.markPending(version)
  ctx.log.info(`启动引擎 v${version}…`)
  const started = await startEngine({ root: ctx.root, platform: ctx.platform, version, preferredPort: before.port })
  if (started.ok) {
    ctx.state.confirmHealthy(version)
    return { ok: true, version, port: started.port, rolledBackTo: null, error: null }
  }
  ctx.log.error(`v${version} 启动失败：${started.error ?? '未知原因'}`)
  const fallback = before.lastKnownGood !== null && before.lastKnownGood !== version ? before.lastKnownGood : null
  if (fallback === null || !installed(ctx).includes(fallback)) {
    ctx.state.patch({ pending: null, currentVersion: before.currentVersion === version ? null : before.currentVersion })
    return { ok: false, version, port: null, rolledBackTo: null, error: started.error }
  }
  ctx.log.warn(`回滚到上一个可用版本 v${fallback}`)
  ctx.state.patch({ pending: null, currentVersion: fallback })
  const again = await startEngine({ root: ctx.root, platform: ctx.platform, version: fallback, preferredPort: before.port })
  if (again.ok) ctx.state.confirmHealthy(fallback)
  return { ok: false, version, port: again.port, rolledBackTo: again.ok ? fallback : null, error: started.error }
}

/**
 * Ensure the engine is running. Never downloads. Resolves a leftover `pending`
 * (the previous activation never proved itself) by rolling back first.
 */
export async function ensureRunning(ctx: EngineContext): Promise<RunningInfo & { started: boolean; rolledBack: string | null }> {
  const now = await inspect(ctx.root)
  const state = ctx.state.get()
  if (now.running && now.healthy) {
    if (state.pending !== null && state.pending.version === now.version) ctx.state.confirmHealthy(now.version)
    return { ...now, started: false, rolledBack: null }
  }
  let version = state.currentVersion
  let rolledBack: string | null = null
  if (state.pending !== null && state.lastKnownGood !== null && state.pending.version !== state.lastKnownGood) {
    ctx.log.warn(`检测到未完成的激活 v${state.pending.version}，回滚到 v${state.lastKnownGood}`)
    version = state.lastKnownGood
    rolledBack = version
    ctx.state.patch({ pending: null, currentVersion: version })
  }
  if (version === null || !installed(ctx).includes(version)) {
    throw new CliError('FeyaGate 引擎尚未安装：请先征得用户同意后运行 `feyagate install --yes`', 2, { nextAction: 'install' })
  }
  const result = await activate(ctx, version)
  if (!result.ok && result.rolledBackTo === null) throw new CliError(`引擎启动失败：${result.error ?? '未知原因'}`)
  const after = await inspect(ctx.root)
  return { ...after, started: true, rolledBack: rolledBack ?? result.rolledBackTo }
}

export async function rollback(ctx: EngineContext, to?: string | null): Promise<ActivateResult> {
  const state = ctx.state.get()
  const versions = installed(ctx)
  const target = to ?? [...versions].reverse().find((v) => v !== state.currentVersion) ?? null
  if (target === null) throw new CliError('没有可回滚的其他已安装版本')
  if (!versions.includes(target)) throw new CliError(`版本 ${target} 未安装（已安装：${versions.join(', ') || '无'}）`)
  return activate(ctx, target)
}

/** Remove old versions, always keeping current, lastKnownGood, and the newest `keep`. */
export function prune(ctx: EngineContext, keep = 2): string[] {
  const state = ctx.state.get()
  const versions = installed(ctx)
  const protectedSet = new Set([state.currentVersion, state.lastKnownGood, ...versions.slice(-Math.max(1, keep))].filter((v): v is string => v !== null))
  const removed: string[] = []
  for (const version of versions) {
    if (protectedSet.has(version)) continue
    rmSync(versionDir(ctx.root, version), { recursive: true, force: true })
    removed.push(version)
  }
  return removed
}

// ─────────────────────────────────────────────────────────── update check

export interface UpdateReport {
  current: string | null
  target: string
  updateAvailable: boolean
  belowMinimum: boolean
  /** Newer engine tag published upstream but not yet pinned by this CLI build. */
  upstreamLatest: string | null
  /** Newer CLI on npm (pins newer engines). */
  cliLatest: string | null
  cliCurrent: string
  notes: string[]
}

async function fetchJson(url: string): Promise<unknown> {
  return JSON.parse(await fetchText(url, { timeoutMs: 8000 })) as unknown
}

export async function checkUpdates(ctx: EngineContext, cliVersion: string, online: boolean): Promise<UpdateReport> {
  const manifest = loadManifest()
  const state = ctx.state.get()
  const target = targetVersion(ctx)
  const current = state.currentVersion
  const notes: string[] = []
  const belowMinimum = current !== null && compareVersions(current, manifest.pluginCompat.minSupportedServer) < 0
  let upstreamLatest: string | null = null
  let cliLatest: string | null = null
  if (online) {
    try {
      const repo = new URL(manifest.server.repo).pathname.replace(/^\/+|\/+$/g, '')
      const latest = (await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`)) as { tag_name?: unknown }
      const tag = typeof latest.tag_name === 'string' ? latest.tag_name.replace(/^v/, '') : null
      if (tag !== null && compareVersions(tag, target) > 0) upstreamLatest = tag
    } catch (error) {
      notes.push(`无法查询上游最新版本：${(error as Error).message}`)
    }
    try {
      const meta = (await fetchJson('https://registry.npmjs.org/feyagate/latest')) as { version?: unknown }
      if (typeof meta.version === 'string' && compareVersions(meta.version, cliVersion) > 0) cliLatest = meta.version
    } catch (error) {
      notes.push(`无法查询 npm 最新版本：${(error as Error).message}`)
    }
    ctx.state.patch({ lastUpdateCheck: Date.now() })
  }
  if (upstreamLatest !== null) {
    notes.push(
      cliLatest !== null
        ? `上游已发布引擎 v${upstreamLatest}；升级 CLI 到 feyagate@${cliLatest} 后即可校验安装`
        : `上游已发布引擎 v${upstreamLatest}，但还没有收录它校验值的 CLI 版本；当前 CLI 只会安装已校验的 v${target}`,
    )
  }
  return {
    current,
    target,
    updateAvailable: current === null || compareVersions(target, current) > 0,
    belowMinimum,
    upstreamLatest,
    cliLatest,
    cliCurrent: cliVersion,
    notes,
  }
}

// ──────────────────────────────────────────────────────────────── doctor

export type NextAction = 'ready' | 'install' | 'start' | 'upgrade_required' | 'upgrade_available' | 'unsupported_platform'

export async function doctor(root: string, log: Logger) {
  const tag = detectPlatformTag()
  if (tag === null) {
    return { ready: false, nextAction: 'unsupported_platform' as NextAction, platform: `${process.platform}-${process.arch}`, root }
  }
  const ctx = createContext(root, log)
  const manifest = loadManifest()
  const state = ctx.state.get()
  const running = await inspect(root)
  const versions = installed(ctx)
  const target = targetVersion(ctx)
  const belowMinimum = state.currentVersion !== null && compareVersions(state.currentVersion, manifest.pluginCompat.minSupportedServer) < 0
  let nextAction: NextAction
  if (state.currentVersion === null || !versions.includes(state.currentVersion)) nextAction = 'install'
  else if (belowMinimum) nextAction = 'upgrade_required'
  else if (!running.healthy) nextAction = 'start'
  else if (compareVersions(target, state.currentVersion) > 0) nextAction = 'upgrade_available'
  else nextAction = 'ready'
  return {
    ready: nextAction === 'ready' || nextAction === 'upgrade_available',
    nextAction,
    platform: tag,
    root,
    currentVersion: state.currentVersion,
    lastKnownGood: state.lastKnownGood,
    pending: state.pending,
    installedVersions: versions,
    targetVersion: target,
    availableVersions: listVersionsForPlatform(manifest, tag),
    compat: compatSummary(manifest, tag),
    engine: { running: running.running, healthy: running.healthy, pid: running.pid, port: running.port, version: running.version },
    mcpUrl: running.port === null ? null : `http://127.0.0.1:${running.port}${manifest.server.mcpPath}`,
  }
}
