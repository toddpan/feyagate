/**
 * Engine process supervision for a short-lived CLI.
 *
 * Unlike the DSH plugin (a long-running host that owns its child), each CLI
 * invocation starts, inspects, or stops a *detached* engine and exits. So the
 * pid file is the source of truth, and every reader re-validates it: a pid is
 * only "ours" while that process is alive **and** its recorded port answers
 * `/health`. A stale pid file is never trusted (pids get reused).
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, rmSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { PORT_SCAN_RANGE, STOP_GRACE_MS } from '../constants.js'
import { applyEffectivePort, applyWebuiDir, generateConfig } from '../config-gen.js'
import { configPath, ensureLayout, logsDir, pidFile, serverLogPath, versionDir } from '../paths.js'
import { readJson, writeJsonAtomic } from '../util/atomic.js'
import { binaryName, type PlatformTag } from '../util/platform.js'
import { findFreePort, probeHealth, waitForHealthy } from './health.js'

export interface PidRecord {
  pid: number
  port: number
  version: string
  startedAt: number
}

const LOG_ROTATE_BYTES = 5 * 1024 * 1024

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readPid(root: string): PidRecord | null {
  const record = readJson<PidRecord | null>(pidFile(root), null)
  if (record === null || typeof record.pid !== 'number' || typeof record.port !== 'number') return null
  return record
}

export interface RunningInfo {
  running: boolean
  healthy: boolean
  pid: number | null
  port: number | null
  version: string | null
}

/** What is running right now, re-validated (stale pid files are cleaned up). */
export async function inspect(root: string): Promise<RunningInfo> {
  const record = readPid(root)
  if (record === null) return { running: false, healthy: false, pid: null, port: null, version: null }
  if (!isAlive(record.pid)) {
    rmSync(pidFile(root), { force: true })
    return { running: false, healthy: false, pid: null, port: null, version: null }
  }
  const healthy = await probeHealth(record.port)
  return { running: true, healthy, pid: record.pid, port: record.port, version: record.version }
}

function rotateLog(root: string): void {
  const file = serverLogPath(root)
  try {
    if (existsSync(file) && statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
  } catch {
    /* best effort */
  }
}

export interface StartOutcome {
  ok: boolean
  port: number | null
  pid: number | null
  error: string | null
}

/**
 * Spawn `versions/<version>/miloco-mcp-server --config <root>/config.yaml`
 * detached, then wait for `/health`. Does **not** touch state.json; the caller
 * owns the pending/confirm handshake.
 */
export async function startEngine(options: {
  root: string
  platform: PlatformTag
  version: string
  preferredPort: number
}): Promise<StartOutcome> {
  const { root, platform, version, preferredPort } = options
  const binary = join(versionDir(root, version), binaryName(platform))
  if (!existsSync(binary)) return { ok: false, port: null, pid: null, error: `未找到引擎可执行文件：${binary}` }

  const port = await findFreePort(preferredPort, PORT_SCAN_RANGE)
  if (port === null) {
    return { ok: false, port: null, pid: null, error: `端口 ${preferredPort}–${preferredPort + PORT_SCAN_RANGE} 均被占用` }
  }
  ensureLayout(root)
  generateConfig({ root, port })
  if (port !== preferredPort) applyEffectivePort(root, port)
  applyWebuiDir(root, version)

  rotateLog(root)
  const out = openSync(serverLogPath(root), 'a')
  let child
  try {
    // Argument array, no shell: paths with spaces cannot become injection.
    child = spawn(binary, ['--config', configPath(root)], {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    })
  } finally {
    closeSync(out)
  }
  const pid = child.pid
  if (pid === undefined) return { ok: false, port, pid: null, error: '无法启动引擎进程' }
  let exited: string | null = null
  child.once('exit', (code, signal) => {
    exited = `引擎进程启动后立即退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}），详见日志 ${serverLogPath(root)}`
  })
  child.unref()
  writeJsonAtomic(pidFile(root), { pid, port, version, startedAt: Date.now() } satisfies PidRecord)

  const abort = new AbortController()
  const timer = setInterval(() => {
    if (exited !== null) abort.abort()
  }, 100)
  const healthy = await waitForHealthy(port, { signal: abort.signal })
  clearInterval(timer)
  if (healthy) return { ok: true, port, pid, error: null }

  await stopPid(pid)
  rmSync(pidFile(root), { force: true })
  return { ok: false, port, pid, error: exited ?? `引擎在端口 ${port} 上未通过健康检查（约 20 秒），详见日志 ${serverLogPath(root)}` }
}

async function stopPid(pid: number): Promise<void> {
  if (!isAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + STOP_GRACE_MS
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/** Stop the engine recorded in the pid file. Returns false when nothing was running. */
export async function stopEngine(root: string): Promise<boolean> {
  const record = readPid(root)
  if (record === null) return false
  const wasAlive = isAlive(record.pid)
  await stopPid(record.pid)
  rmSync(pidFile(root), { force: true })
  return wasAlive
}

export { logsDir }
