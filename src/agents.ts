/**
 * `feyagate setup-agent <host>` — register the stdio MCP server and copy the
 * skill folder into an AI host's own directories.
 *
 * Every change is shown first. Without `--yes` nothing is written (exit 3),
 * so the agent can show the plan to the user. Existing config files are backed
 * up to `<file>.feyagate.bak` before the first edit, and only the
 * `feyagate` entry is touched; everything else in the file is preserved.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CliError, EXIT_NEEDS_CONFIRMATION } from './engine.js'
import { packageRoot } from './paths.js'
import { writeFileAtomic } from './util/atomic.js'

export const MCP_COMMAND = { command: 'npx', args: ['-y', 'feyagate', 'mcp'] }

export type HostId = 'claude' | 'cursor' | 'codex' | 'windsurf' | 'gemini' | 'dsh' | 'openclaw'
export const HOSTS: HostId[] = ['claude', 'cursor', 'codex', 'windsurf', 'gemini', 'dsh', 'openclaw']

interface HostSpec {
  label: string
  skillDir: string | null
  mcp: { kind: 'json'; file: string; key: string } | { kind: 'toml'; file: string } | { kind: 'manual'; hint: string } | null
}

function spec(host: HostId): HostSpec {
  const home = homedir()
  switch (host) {
    case 'claude':
      return { label: 'Claude Code', skillDir: join(home, '.claude', 'skills', 'feyagate'), mcp: { kind: 'json', file: join(home, '.claude.json'), key: 'mcpServers' } }
    case 'cursor':
      return { label: 'Cursor', skillDir: join(home, '.cursor', 'skills', 'feyagate'), mcp: { kind: 'json', file: join(home, '.cursor', 'mcp.json'), key: 'mcpServers' } }
    case 'codex':
      return { label: 'Codex CLI', skillDir: join(home, '.codex', 'skills', 'feyagate'), mcp: { kind: 'toml', file: join(home, '.codex', 'config.toml') } }
    case 'windsurf':
      return { label: 'Windsurf', skillDir: join(home, '.codeium', 'windsurf', 'skills', 'feyagate'), mcp: { kind: 'json', file: join(home, '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' } }
    case 'gemini':
      return { label: 'Gemini CLI', skillDir: join(home, '.gemini', 'skills', 'feyagate'), mcp: { kind: 'json', file: join(home, '.gemini', 'settings.json'), key: 'mcpServers' } }
    case 'dsh':
      return {
        label: 'DeepSeek Harness',
        skillDir: join(process.env.DSH_HOME?.trim() || join(home, '.dsh'), 'skills', 'feyagate'),
        mcp: { kind: 'manual', hint: '在 DSH 设置 › MCP 中添加 stdio 服务器：名称 feyagate，命令 npx，参数 -y feyagate mcp（或安装 dsh-feyagate 插件获得图形界面）' },
      }
    case 'openclaw':
      return { label: 'OpenClaw', skillDir: join(home, '.openclaw', 'skills', 'feyagate'), mcp: null }
  }
}

export interface AgentChange {
  target: string
  description: string
}

function backup(file: string): void {
  const bak = `${file}.feyagate.bak`
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak)
}

function editJson(file: string, key: string, apply: boolean): AgentChange {
  let document: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层不是对象')
      document = parsed as Record<string, unknown>
    } catch (error) {
      throw new CliError(`无法解析 ${file}（${(error as Error).message}），为避免损坏未做修改`)
    }
  }
  const servers = (document[key] !== null && typeof document[key] === 'object' ? document[key] : {}) as Record<string, unknown>
  servers.feyagate = { type: 'stdio', ...MCP_COMMAND }
  document[key] = servers
  if (apply) {
    backup(file)
    writeFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`)
  }
  return { target: file, description: `写入 ${key}.feyagate = npx -y feyagate mcp` }
}

const TOML_BEGIN = '# >>> feyagate (managed by \`feyagate setup-agent\`) >>>'
const TOML_END = '# <<< feyagate <<<'

function editToml(file: string, apply: boolean): AgentChange {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (/^\[mcp_servers\.feyagate\]/m.test(current.replace(new RegExp(`${escape(TOML_BEGIN)}[\\s\\S]*?${escape(TOML_END)}`), ''))) {
    throw new CliError(`${file} 里已有手写的 [mcp_servers.feyagate]，请手动确认后再运行`)
  }
  const block = `${TOML_BEGIN}\n[mcp_servers.feyagate]\ncommand = "npx"\nargs = ["-y", "feyagate", "mcp"]\n${TOML_END}\n`
  const pattern = new RegExp(`${escape(TOML_BEGIN)}[\\s\\S]*?${escape(TOML_END)}\\n?`)
  const next = pattern.test(current) ? current.replace(pattern, block) : `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}\n${block}`
  if (apply) {
    backup(file)
    writeFileAtomic(file, next)
  }
  return { target: file, description: '写入 [mcp_servers.feyagate] = npx -y feyagate mcp' }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Folder shipped in the npm package that hosts load as the skill. */
export function skillSource(): string {
  return join(packageRoot(), 'skill')
}

export function setupAgent(host: HostId, options: { apply: boolean; skillOnly?: boolean; mcpOnly?: boolean }) {
  const s = spec(host)
  const changes: AgentChange[] = []
  const manual: string[] = []
  if (options.mcpOnly !== true && s.skillDir !== null) {
    if (options.apply) {
      rmSync(s.skillDir, { recursive: true, force: true })
      mkdirSync(dirname(s.skillDir), { recursive: true })
      cpSync(skillSource(), s.skillDir, { recursive: true })
    }
    changes.push({ target: s.skillDir, description: '复制 SKILL.md 与 references/（覆盖旧版本的本技能目录）' })
  }
  if (options.skillOnly !== true && s.mcp !== null) {
    if (s.mcp.kind === 'json') changes.push(editJson(s.mcp.file, s.mcp.key, options.apply))
    else if (s.mcp.kind === 'toml') changes.push(editToml(s.mcp.file, options.apply))
    else manual.push(s.mcp.hint)
  }
  if (!options.apply) {
    throw new CliError(`将修改 ${s.label} 的配置（未执行）。征得用户同意后加 --yes 重新运行`, EXIT_NEEDS_CONFIRMATION, { host, changes, manual })
  }
  return { host, label: s.label, applied: true, changes, manual, next: '重启该 AI 工具（或重新加载 MCP 服务器）后生效' }
}

export function removeAgent(host: HostId, apply: boolean) {
  const s = spec(host)
  const changes: AgentChange[] = []
  if (s.skillDir !== null && existsSync(s.skillDir)) {
    if (apply) rmSync(s.skillDir, { recursive: true, force: true })
    changes.push({ target: s.skillDir, description: '删除本技能目录' })
  }
  if (s.mcp !== null && s.mcp.kind === 'json' && existsSync(s.mcp.file)) {
    const document = JSON.parse(readFileSync(s.mcp.file, 'utf8')) as Record<string, Record<string, unknown> | undefined>
    if (document[s.mcp.key]?.feyagate !== undefined) {
      if (apply) {
        delete document[s.mcp.key]!.feyagate
        backup(s.mcp.file)
        writeFileAtomic(s.mcp.file, `${JSON.stringify(document, null, 2)}\n`)
      }
      changes.push({ target: s.mcp.file, description: `删除 ${s.mcp.key}.feyagate` })
    }
  }
  if (s.mcp !== null && s.mcp.kind === 'toml' && existsSync(s.mcp.file)) {
    const current = readFileSync(s.mcp.file, 'utf8')
    const pattern = new RegExp(`\\n?${escape(TOML_BEGIN)}[\\s\\S]*?${escape(TOML_END)}\\n?`)
    if (pattern.test(current)) {
      if (apply) {
        backup(s.mcp.file)
        writeFileAtomic(s.mcp.file, current.replace(pattern, '\n'))
      }
      changes.push({ target: s.mcp.file, description: '删除 feyagate 托管块' })
    }
  }
  if (!apply) throw new CliError(`将移除 ${s.label} 中的 feyagate（未执行）。确认后加 --yes`, EXIT_NEEDS_CONFIRMATION, { host, changes })
  return { host, removed: true, changes }
}
