/**
 * Minimal HTTP client for the running engine (JSON-RPC over `POST /mcp/http`
 * and its REST `/api/v1/*` endpoints). Loopback only.
 */

const TOOL_TIMEOUT_MS = 60_000

export class EngineClient {
  constructor(readonly port: number) {}

  get mcpUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp/http`
  }

  /** Call one MCP tool and return its parsed text payload (JSON when possible). */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = TOOL_TIMEOUT_MS): Promise<unknown> {
    const response = await fetch(this.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = (await response.json()) as {
      result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      error?: { message?: string }
    }
    if (payload.error !== undefined) throw new Error(payload.error.message ?? `工具 ${name} 调用失败`)
    const text = (payload.result?.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n')
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* plain text */
    }
    if (payload.result?.isError === true) throw new Error(typeof parsed === 'string' ? parsed : JSON.stringify(parsed))
    return parsed
  }

  async rest(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
}
