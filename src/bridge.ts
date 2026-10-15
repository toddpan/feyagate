/**
 * `feyagate mcp` — stdio MCP server for Claude Code, Cursor, Codex, DSH, and
 * any other MCP host.
 *
 * Why stdio instead of pointing hosts at `http://127.0.0.1:38080/mcp/http`:
 *
 *  * the engine's port can drift (38080 busy → 38081…), but a host config file
 *    is static text; the bridge always reads the live port from the pid file;
 *  * the bridge starts an *installed* engine on demand, so the user never has
 *    to remember `feyagate start` after a reboot;
 *  * hosts give up on a server that fails its first handshake. The bridge
 *    answers `initialize` locally and immediately, lists zero tools while the
 *    engine is absent, and sends `notifications/tools/list_changed` once it
 *    comes up — the same pattern the DSH plugin's facade uses.
 *
 * It **never downloads**: when the engine is not installed it serves one
 * diagnostic tool, `feyagate_setup_status`, that tells the agent how to ask
 * the user for consent and install.
 *
 * Framing: newline-delimited JSON-RPC on stdin/stdout. Logs go to stderr only
 * (stdout belongs to the protocol).
 */

import { createInterface } from 'node:readline'

import { BRIDGE_PROBE_INTERVAL_MS, BRIDGE_REQUEST_TIMEOUT_MS } from './constants.js'
import { CliError, ensureRunning, createContext, type Logger } from './engine.js'
import { inspect } from './supervise/process.js'

const PROTOCOL_VERSION = '2024-11-05'
const SETUP_TOOL = 'feyagate_setup_status'

type Json = Record<string, unknown>

const stderrLog: Logger = {
  info: (m) => process.stderr.write(`[feyagate] ${m}\n`),
  warn: (m) => process.stderr.write(`[feyagate] WARN ${m}\n`),
  error: (m) => process.stderr.write(`[feyagate] ERROR ${m}\n`),
}

/** Upstream ships `{}` as inputSchema for zero-arg tools; strict clients reject the whole list. */
export function repairToolsList(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result
  const list = (result as { tools?: unknown }).tools
  if (!Array.isArray(list)) return result
  for (const tool of list) {
    if (tool === null || typeof tool !== 'object') continue
    const entry = tool as Json
    const schema = entry.inputSchema !== null && typeof entry.inputSchema === 'object' && !Array.isArray(entry.inputSchema) ? { ...(entry.inputSchema as Json) } : {}
    if (schema.type !== 'object') schema.type = 'object'
    if (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) schema.properties = {}
    entry.inputSchema = schema
  }
  return result
}

export class StdioBridge {
  private port: number | null = null
  private sessionId: string | null = null
  private engineError: string | null = null
  private notifiedReady = false
  private probing: NodeJS.Timeout | null = null

  constructor(private readonly root: string, private readonly write: (msg: Json) => void = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)) {}

  /** Try to bring the engine up (no downloads). Safe to call repeatedly. */
  async connect(): Promise<boolean> {
    try {
      const info = await inspect(this.root)
      if (info.healthy && info.port !== null) {
        this.port = info.port
      } else {
        const started = await ensureRunning(createContext(this.root, stderrLog))
        this.port = started.healthy ? started.port : null
      }
      this.engineError = this.port === null ? '引擎未通过健康检查' : null
    } catch (error) {
      this.port = null
      this.engineError = error instanceof CliError || error instanceof Error ? error.message : String(error)
    }
    return this.port !== null
  }

  startProbing(): void {
    if (this.probing !== null) return
    this.probing = setInterval(() => {
      void (async () => {
        const info = await inspect(this.root)
        if (info.healthy && info.port !== null) {
          const changed = this.port !== info.port
          this.port = info.port
          this.engineError = null
          if (changed || !this.notifiedReady) {
            this.notifiedReady = true
            this.sessionId = null
            this.write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
          }
        } else if (this.port !== null) {
          this.port = null
          this.engineError = '引擎已停止'
        }
      })()
    }, BRIDGE_PROBE_INTERVAL_MS)
    this.probing.unref()
  }

  private setupToolResult(): Json {
    const text = [
      `FeyaGate 引擎当前不可用：${this.engineError ?? '未知原因'}`,
      '处理步骤：',
      '1. 在终端运行 `npx -y feyagate doctor --json` 查看 nextAction。',
      '2. nextAction=install / upgrade_required：先向用户说明将从 github.com 下载约 30MB 的已校验引擎，征得同意后运行 `npx -y feyagate install --yes`。',
      '3. nextAction=start：运行 `npx -y feyagate start`。',
      '引擎就绪后本 MCP 服务器会发送 tools/list_changed，智能家居工具会自动出现。',
    ].join('\n')
    return { content: [{ type: 'text', text }], isError: false }
  }

  private local(message: Json): Json | null {
    const id = message.id
    switch (message.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: (message.params as Json | undefined)?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'feyagate', version: '1' },
          },
        }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: SETUP_TOOL,
                description: 'FeyaGate 引擎未就绪时调用：返回安装/启动步骤。引擎就绪后此工具消失，智能家居工具出现。',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        }
      case 'tools/call':
        if ((message.params as Json | undefined)?.name === SETUP_TOOL) return { jsonrpc: '2.0', id, result: this.setupToolResult() }
        return { jsonrpc: '2.0', id, error: { code: -32000, message: `FeyaGate 引擎不可用：${this.engineError ?? '未知原因'}。请先调用 ${SETUP_TOOL}` } }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } }
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } }
    }
  }

  private async forward(message: Json): Promise<Json | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (this.sessionId !== null) headers['Mcp-Session-Id'] = this.sessionId
    const response = await fetch(`http://127.0.0.1:${this.port}/mcp/http`, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(BRIDGE_REQUEST_TIMEOUT_MS),
    })
    const session = response.headers.get('mcp-session-id')
    if (session !== null) this.sessionId = session
    if (message.id === undefined) return null
    const text = await response.text()
    const body = text.trim().startsWith('event:') || text.trim().startsWith('data:') ? lastSseData(text) : text
    if (body.trim() === '') return null
    const parsed = JSON.parse(body) as Json
    if (message.method === 'tools/list' && parsed.result !== undefined) parsed.result = repairToolsList(parsed.result)
    if (message.method === 'initialize' && parsed.result !== null && typeof parsed.result === 'object') {
      const result = parsed.result as Json
      const caps = (result.capabilities ?? {}) as Json
      caps.tools = { ...((caps.tools as Json | undefined) ?? {}), listChanged: true }
      result.capabilities = caps
    }
    return parsed
  }

  async handle(message: Json): Promise<Json | null> {
    const isNotification = message.id === undefined
    if (this.port === null) return isNotification ? null : this.local(message)
    if (message.method === 'initialize') this.notifiedReady = true
    try {
      return await this.forward(message)
    } catch (error) {
      // Engine went away mid-session: degrade to the local answers.
      this.port = null
      this.engineError = `与引擎通信失败：${(error as Error).message}`
      return isNotification ? null : this.local(message)
    }
  }
}

function lastSseData(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith('data:'))
  return lines.length === 0 ? '' : (lines[lines.length - 1] ?? '').slice(5).trim()
}

export async function runStdioBridge(root: string): Promise<void> {
  const bridge = new StdioBridge(root)
  const ready = bridge.connect()
  bridge.startProbing()
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let chain: Promise<void> = ready.then(() => undefined)
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    chain = chain.then(async () => {
      let message: Json
      try {
        message = JSON.parse(trimmed) as Json
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
        return
      }
      const answer = await bridge.handle(message)
      if (answer !== null) process.stdout.write(`${JSON.stringify(answer)}\n`)
    })
  })
  await new Promise<void>((resolve) => rl.once('close', () => resolve()))
  await chain
}
