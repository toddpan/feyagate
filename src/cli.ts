#!/usr/bin/env node
/**
 * `feyagate` CLI — headless installer, upgrader, supervisor, and stdio MCP
 * server for the FeyaGate smart-home engine (miloco-mcp-server).
 *
 * Output contract (what SKILL.md relies on):
 *   * `--json` prints exactly one JSON object on stdout: { ok, command, ... }.
 *   * Progress and logs always go to stderr.
 *   * Exit codes: 0 ok · 1 error · 2 engine not installed ·
 *     3 needs user confirmation (re-run with --yes) · 4 needs an interactive terminal.
 */

import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { HOSTS, removeAgent, setupAgent, type HostId } from './agents.js'
import { PLATFORMS, authStatus, loginEwelink, loginHuawei, loginMidea, loginTuya, loginXiaomi, logout, type PlatformId } from './auth.js'
import { runStdioBridge } from './bridge.js'
import { EngineClient } from './client.js'
import {
  CliError,
  EXIT_NEEDS_CONFIRMATION,
  activate,
  checkUpdates,
  createContext,
  doctor,
  downloadVersion,
  ensureRunning,
  planInstall,
  prune,
  rollback,
  type Logger,
} from './engine.js'
import { defaultRoot, packageRoot, serverLogPath } from './paths.js'
import { inspect, stopEngine } from './supervise/process.js'

export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'y', 'check', 'offline', 'allow-unverified', 'no-start', 'keep-data', 'skill-only', 'mcp-only', 'help', 'h', 'reinstall'])

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length === 2 && !/^-\d/.test(arg))) {
      const raw = arg.replace(/^--?/, '')
      const eq = raw.indexOf('=')
      if (eq >= 0) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1)
      } else if (BOOLEAN_FLAGS.has(raw)) {
        flags[raw] = true
      } else {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('-')) flags[raw] = true
        else {
          flags[raw] = next
          i += 1
        }
      }
    } else positionals.push(arg)
  }
  if (flags.y === true) flags.yes = true
  if (flags.h === true) flags.help = true
  return { positionals, flags }
}

function cliVersion(): string {
  try {
    return String((JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown }).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

const HELP = `feyagate — FeyaGate 智能家居 MCP 引擎（米家/涂鸦/美的/易微联/华为）

引擎管理（只读命令从不联网下载）
  doctor [--json]                 体检：安装/运行/版本状态与下一步 nextAction
  install [--yes] [--version V]   下载并安装已校验的引擎（不带 --yes 只显示计划）
          [--local FILE] [--mirror URL] [--allow-unverified] [--no-start] [--reinstall]
  upgrade --check [--offline]     检查更新（不下载）
  upgrade [--yes] [--version V]   升级：新版本装到旁边，健康检查失败自动回滚
  rollback [--to V]               切回上一个（或指定）已安装版本
  versions                        已安装 / 可安装版本
  prune [--keep N]                清理旧版本（保留当前、上次可用与最新 N 个）
  start | stop | restart | status
  logs [-n 80]                    查看引擎日志末尾
  uninstall [--yes] [--keep-data] 停止并删除引擎（--keep-data 保留登录态与授权）

AI 工具接入
  mcp                             以 stdio MCP 服务器运行（供 AI 工具配置）
  setup-agent <host> [--yes]      注册到 ${HOSTS.join(' / ')}
  remove-agent <host> [--yes]
  tools [--json]                  列出引擎提供的 MCP 工具
  call <tool> ['{"json":"args"}'] 直接调用一个 MCP 工具

平台登录（需在用户自己的终端中运行，口令不经过 AI）
  auth status
  auth tuya --user-code CODE      扫码授权（无需口令）
  auth xiaomi [--region cn]       浏览器 OAuth，粘贴回调地址
  auth midea | auth ewelink | auth huawei
  auth logout <platform>

通用：--json 机器可读输出；--home DIR 或 FEYAGATE_HOME 指定安装目录（默认 ~/.feyagate-mcp）
退出码：0 成功 · 1 失败 · 2 未安装 · 3 需要用户确认(--yes) · 4 需要交互式终端`

interface Io {
  json: boolean
  out: (data: Record<string, unknown>, human?: string) => void
  say: (msg: string) => void
  log: Logger
}

function makeIo(json: boolean): Io {
  const say = (msg: string) => process.stderr.write(`${msg}\n`)
  return {
    json,
    say,
    out: (data, human) => {
      if (json) process.stdout.write(`${JSON.stringify({ ok: true, ...data }, null, 2)}\n`)
      else process.stdout.write(`${human ?? JSON.stringify(data, null, 2)}\n`)
    },
    log: {
      info: (m) => say(`  ${m}`),
      warn: (m) => say(`  ! ${m}`),
      error: (m) => say(`  ✗ ${m}`),
    },
  }
}

function flagStr(flags: ParsedArgs['flags'], name: string): string | null {
  const v = flags[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

async function runningClient(root: string): Promise<EngineClient> {
  const info = await inspect(root)
  if (info.healthy && info.port !== null) return new EngineClient(info.port)
  throw new CliError('引擎未运行：先运行 feyagate start（未安装时先 feyagate doctor）', 2, { nextAction: 'start' })
}

function formatBytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function cmdInstallOrUpgrade(cmd: 'install' | 'upgrade', root: string, a: ParsedArgs, io: Io): Promise<void> {
  const ctx = createContext(root, io.log)
  if (cmd === 'upgrade' && a.flags.check === true) {
    const report = await checkUpdates(ctx, cliVersion(), a.flags.offline !== true)
    io.out({ command: 'upgrade --check', ...report }, [
      `当前引擎：${report.current ?? '未安装'}   目标（已校验）：${report.target}`,
      report.updateAvailable ? `可升级 → 运行 feyagate upgrade --yes` : '已是本 CLI 收录的最新版本',
      report.belowMinimum ? '当前版本低于最低兼容版本，必须升级' : '',
      report.cliLatest !== null ? `npm 上有更新的 CLI：feyagate@${report.cliLatest}（npx -y feyagate@latest ...）` : '',
      ...report.notes,
    ].filter((l) => l !== '').join('\n'))
    return
  }
  const plan = planInstall(ctx, flagStr(a.flags, 'version'))
  const already = ctx.state.get().currentVersion === plan.toVersion && a.flags.reinstall !== true
  if (already) {
    const running = a.flags['no-start'] === true ? await inspect(root) : await ensureRunning(ctx)
    io.out({ command: cmd, changed: false, version: plan.toVersion, engine: running }, `引擎 v${plan.toVersion} 已安装${running.healthy ? `，运行于端口 ${running.port}` : ''}`)
    return
  }
  if (a.flags.yes !== true) {
    throw new CliError(
      `需要用户确认：将${plan.action === 'install' ? '安装' : `从 v${plan.fromVersion} 升级到`} FeyaGate 引擎 v${plan.toVersion}` +
        `（${plan.asset.file}，${formatBytes(plan.asset.size)}，来自 ${plan.hosts[0]}，sha256 ${plan.asset.sha256 === null ? '未发布' : '已固定在本 CLI 中'}）。确认后加 --yes 重新运行`,
      EXIT_NEEDS_CONFIRMATION,
      { plan },
    )
  }
  io.say(`→ 下载 FeyaGate 引擎 v${plan.toVersion}（${plan.asset.file}，${formatBytes(plan.asset.size)}）`)
  const got = await downloadVersion(ctx, plan.toVersion, {
    allowUnverified: a.flags['allow-unverified'] === true,
    localArchive: flagStr(a.flags, 'local'),
    mirror: flagStr(a.flags, 'mirror'),
    reinstall: a.flags.reinstall === true,
    onProgress: (m) => io.say(`  ${m}`),
  })
  io.say(`✓ 已校验并安装到 versions/${got.version}（来源：${got.source}）`)
  if (a.flags['no-start'] === true) {
    if (ctx.state.get().currentVersion === null) ctx.state.patch({ currentVersion: got.version })
    io.out({ command: cmd, changed: true, version: got.version, sha256: got.sha256, source: got.source, started: false }, `已安装 v${got.version}（未启动）`)
    return
  }
  const result = await activate(ctx, got.version)
  if (!result.ok) {
    throw new CliError(
      result.rolledBackTo !== null
        ? `v${got.version} 启动失败，已自动回滚到 v${result.rolledBackTo}：${result.error ?? ''}`
        : `v${got.version} 启动失败：${result.error ?? ''}`,
      1,
      { result },
    )
  }
  const removed = prune(ctx, 2)
  io.out(
    { command: cmd, changed: true, version: got.version, sha256: got.sha256, source: got.source, port: result.port, pruned: removed },
    `✓ FeyaGate 引擎 v${got.version} 已运行：http://127.0.0.1:${result.port}/mcp/http`,
  )
}

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv)
  const io = makeIo(a.flags.json === true)
  const root = flagStr(a.flags, 'home') ?? defaultRoot()
  const [cmd, sub, ...rest] = a.positionals
  try {
    switch (cmd) {
      case undefined:
      case 'help':
        process.stdout.write(`${HELP}\n`)
        return 0
      case '--version':
      case 'version':
        io.out({ command: 'version', version: cliVersion() }, cliVersion())
        return 0
      case 'doctor': {
        const report = await doctor(root, io.log)
        const lines = [
          `平台：${report.platform}    安装目录：${report.root}`,
          `引擎：${'currentVersion' in report ? (report.currentVersion ?? '未安装') : '-'}${'engine' in report && report.engine?.healthy === true ? `（运行中，端口 ${report.engine.port}）` : ''}`,
          `下一步：${report.nextAction}`,
        ]
        io.out({ command: 'doctor', ...report, cliVersion: cliVersion() }, lines.join('\n'))
        return 0
      }
      case 'install':
      case 'upgrade':
        await cmdInstallOrUpgrade(cmd, root, a, io)
        return 0
      case 'rollback': {
        const r = await rollback(createContext(root, io.log), flagStr(a.flags, 'to'))
        if (!r.ok) throw new CliError(`回滚到 v${r.version} 失败：${r.error ?? ''}`, 1, { result: r })
        io.out({ command: 'rollback', ...r }, `✓ 已切换到 v${r.version}（端口 ${r.port}）`)
        return 0
      }
      case 'versions': {
        const report = await doctor(root, io.log)
        io.out({ command: 'versions', ...report }, JSON.stringify(report, null, 2))
        return 0
      }
      case 'prune': {
        const keep = Number(flagStr(a.flags, 'keep') ?? 2)
        const removed = prune(createContext(root, io.log), Number.isInteger(keep) && keep > 0 ? keep : 2)
        io.out({ command: 'prune', removed }, removed.length === 0 ? '没有可清理的旧版本' : `已删除：${removed.join(', ')}`)
        return 0
      }
      case 'start': {
        const r = await ensureRunning(createContext(root, io.log))
        io.out({ command: 'start', ...r }, r.started ? `✓ 引擎 v${r.version} 已启动（端口 ${r.port}）` : `引擎 v${r.version} 已在运行（端口 ${r.port}）`)
        return 0
      }
      case 'stop': {
        const stopped = await stopEngine(root)
        io.out({ command: 'stop', stopped }, stopped ? '✓ 引擎已停止' : '引擎未在运行')
        return 0
      }
      case 'restart': {
        await stopEngine(root)
        const r = await ensureRunning(createContext(root, io.log))
        io.out({ command: 'restart', ...r }, `✓ 引擎 v${r.version} 已重启（端口 ${r.port}）`)
        return 0
      }
      case 'status': {
        const info = await inspect(root)
        io.out({ command: 'status', ...info }, info.healthy ? `RUNNING v${info.version} 端口 ${info.port}` : info.running ? `UNHEALTHY pid ${info.pid}` : 'STOPPED')
        return 0
      }
      case 'logs': {
        const n = Number(flagStr(a.flags, 'n') ?? 80)
        const file = serverLogPath(root)
        const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).slice(-(Number.isInteger(n) && n > 0 ? n : 80)) : []
        io.out({ command: 'logs', file, lines }, lines.join('\n') || '(无日志)')
        return 0
      }
      case 'uninstall': {
        if (a.flags.yes !== true) {
          throw new CliError(
            `需要用户确认：将停止引擎并删除 ${root}${a.flags['keep-data'] === true ? '（保留 data/ 与 config.yaml）' : '（包括平台登录态、授权与记忆数据）'}。确认后加 --yes`,
            EXIT_NEEDS_CONFIRMATION,
          )
        }
        await stopEngine(root)
        if (a.flags['keep-data'] === true) {
          for (const name of ['versions', 'cache', 'logs', 'state.json', 'current', 'server.pid']) rmSync(join(root, name), { recursive: true, force: true })
        } else {
          rmSync(root, { recursive: true, force: true })
        }
        io.out({ command: 'uninstall', root, keptData: a.flags['keep-data'] === true }, '✓ 已卸载')
        return 0
      }
      case 'mcp':
        await runStdioBridge(root)
        return 0
      case 'setup-agent':
      case 'remove-agent': {
        if (sub === undefined || !(HOSTS as string[]).includes(sub)) throw new CliError(`请指定 AI 工具：${HOSTS.join(' / ')}`)
        const r =
          cmd === 'setup-agent'
            ? setupAgent(sub as HostId, { apply: a.flags.yes === true, skillOnly: a.flags['skill-only'] === true, mcpOnly: a.flags['mcp-only'] === true })
            : removeAgent(sub as HostId, a.flags.yes === true)
        io.out({ command: cmd, ...r }, JSON.stringify(r, null, 2))
        return 0
      }
      case 'tools': {
        const client = await runningClient(root)
        const res = (await fetch(client.mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }).then((r) => r.json())) as { result?: { tools?: Array<{ name: string; description?: string }> } }
        const list = (res.result?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '' }))
        io.out({ command: 'tools', count: list.length, tools: list }, list.map((t) => `${t.name.padEnd(32)} ${t.description.split('\n')[0]?.slice(0, 80)}`).join('\n'))
        return 0
      }
      case 'call': {
        if (sub === undefined) throw new CliError('用法：feyagate call <tool> [\'{"json":"args"}\']')
        let args: Record<string, unknown> = {}
        if (rest[0] !== undefined) {
          try {
            args = JSON.parse(rest[0]) as Record<string, unknown>
          } catch {
            throw new CliError('参数必须是 JSON 对象字符串')
          }
        }
        if (/^auth\/(midea|ewelink|huawei)_(login|challenge)$/.test(sub)) {
          throw new CliError(`出于安全考虑不通过 call 提交口令，请让用户在终端运行 feyagate auth ${sub.split('/')[1]?.split('_')[0]}`)
        }
        const result = await (await runningClient(root)).callTool(sub, args)
        io.out({ command: 'call', tool: sub, result }, typeof result === 'string' ? result : JSON.stringify(result, null, 2))
        return 0
      }
      case 'auth': {
        const client = await runningClient(root)
        let result: unknown
        if (sub === undefined || sub === 'status') result = await authStatus(client)
        else if (sub === 'tuya') result = await loginTuya(client, flagStr(a.flags, 'user-code') ?? rest[0] ?? '', root, io.say)
        else if (sub === 'midea') result = await loginMidea(client)
        else if (sub === 'ewelink') result = await loginEwelink(client)
        else if (sub === 'huawei') result = await loginHuawei(client, io.say)
        else if (sub === 'xiaomi') result = await loginXiaomi(client, flagStr(a.flags, 'region'), io.say)
        else if (sub === 'logout') {
          const p = rest[0]
          if (p === undefined || !(PLATFORMS as readonly string[]).includes(p)) throw new CliError(`请指定平台：${PLATFORMS.join(' / ')}`)
          result = await logout(client, p as PlatformId)
        } else throw new CliError(`未知的 auth 子命令：${sub}`)
        io.out({ command: `auth ${sub ?? 'status'}`, result }, typeof result === 'string' ? result : JSON.stringify(result, null, 2))
        return 0
      }
      default:
        throw new CliError(`未知命令：${cmd}（运行 feyagate help 查看用法）`)
    }
  } catch (error) {
    const err = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error))
    if (io.json) process.stdout.write(`${JSON.stringify({ ok: false, command: cmd ?? null, exitCode: err.exitCode, error: err.message, ...err.data }, null, 2)}\n`)
    else {
      process.stderr.write(`✗ ${err.message}\n`)
      if (Object.keys(err.data).length > 0) process.stderr.write(`${JSON.stringify(err.data, null, 2)}\n`)
    }
    return err.exitCode
  }
}
