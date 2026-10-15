/**
 * 下载原语：流式写文件 + 拉取小文本（FOTA 清单）。
 *
 * 这里刻意不用 Node 的 http 模块，也不把响应体整块读进内存：安装包有
 * 10–60MB，而插件和 DSH 主进程在同一个进程里，一次 `arrayBuffer()` 就能让
 * 桌面上多出一个 60MB 的常驻 Buffer。所以一律流式落盘。
 *
 * 另一个刻意的选择是**手动处理重定向**（`redirect: 'manual'` 而不是
 * `'follow'`）：Node 自带的上限是 20 跳，而我们要求最多
 * `DOWNLOAD_MAX_REDIRECTS` 跳，并且每一跳都必须仍是 https —— 从 https 跳到
 * http 意味着后续字节可被中间人替换，配合 sha256 校验虽然能挡住，但没校验值
 * 的包就完全没有防线了，所以直接拒绝。
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { once } from 'node:events'
import { isAbsolute, resolve } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'

import { DOWNLOAD_MAX_REDIRECTS, DOWNLOAD_RETRIES, DOWNLOAD_TIMEOUT_MS } from '../constants.js'

export interface DownloadProgress {
  bytesDone: number
  bytesTotal: number | null
}

/** 重试退避基数：0.5s、1s、2s……（只对可重试的错误生效）。 */
const RETRY_BASE_MS = 500

/** `fetchText` 的响应体上限。清单只有几十 KB，超过就说明拿到的不是清单。 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024

const USER_AGENT = 'feyagate-cli-downloader'

/** HTTP 状态码错误：带上状态码和 URL，便于判断 404（换源）还是 5xx（重试）。 */
class HttpError extends Error {
  readonly status: number

  constructor(status: number, statusText: string, url: string) {
    super(`HTTP ${status}${statusText.trim() === '' ? '' : ` ${statusText.trim()}`} (${url})`)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 重试没有意义的错误（协议不允许、重定向超限、响应体过大……）。 */
class PermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentError'
  }
}

/** 判断一个异常是不是"用户取消"。上层据此区分取消与失败，不再继续换源。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

/** 网络错误、5xx、429 值得重试；4xx（除 429）说明换 URL 才有用，重试是浪费。 */
function isRetryable(error: unknown): boolean {
  if (error instanceof PermanentError) return false
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500
  return true
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError())
  return new Promise<void>((resolve_, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve_()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function withRetries<T>(retries: number, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted === true) throw abortError()
    try {
      return await run()
    } catch (error) {
      lastError = error
      if (isAbortError(error) || !isRetryable(error) || attempt === retries) break
      await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 把外部 signal 的中止传导到内部 controller；返回解绑函数（避免监听器泄漏）。 */
function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => {}
  if (parent.aborted) {
    child.abort()
    return () => {}
  }
  const onAbort = (): void => child.abort()
  parent.addEventListener('abort', onAbort, { once: true })
  return () => parent.removeEventListener('abort', onAbort)
}

interface StreamHandle {
  response: Response
  finalUrl: string
  /** 每收到数据就调用，重置"空闲超时"计时。 */
  touch: () => void
  timedOut: () => boolean
  cleanup: () => void
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* 丢弃失败不影响主流程 */
  }
}

/**
 * 发起请求并手动跟随重定向，返回一个未读完的响应。
 *
 * `timeoutMs` 是**空闲超时**：只要还在持续收到数据就一直续期。对 60MB 的包
 * 来说，"总时长上限"会把慢速但健康的下载误杀，而"无数据上限"才真正对应
 * 卡死的连接。
 */
async function fetchFollowing(
  url: string,
  options: { timeoutMs: number; signal: AbortSignal | undefined; accept: string },
): Promise<StreamHandle> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const touch = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
  }
  const unlink = linkAbort(options.signal, controller)
  const cleanup = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    unlink()
  }
  touch()

  let current = url
  try {
    for (let hop = 0; ; hop += 1) {
      let response: Response
      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': USER_AGENT, accept: options.accept },
        })
      } catch (error) {
        if (options.signal?.aborted === true) throw abortError()
        if (timedOut) throw new Error(`请求超时（${options.timeoutMs} 毫秒内没有响应）：${current}`)
        throw error
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get('location')
        await discardBody(response)
        if (location === null || location.trim() === '') {
          throw new PermanentError(`HTTP ${response.status} 重定向响应缺少 Location 头 (${current})`)
        }
        if (hop >= DOWNLOAD_MAX_REDIRECTS) {
          throw new PermanentError(`重定向次数超过上限 ${DOWNLOAD_MAX_REDIRECTS} 次 (${url})`)
        }
        const next = new URL(location, current)
        if (next.protocol !== 'https:') {
          throw new PermanentError(`重定向目标不是 https，已拒绝：${next.toString()}`)
        }
        current = next.toString()
        touch()
        continue
      }

      return { response, finalUrl: current, touch, timedOut: () => timedOut, cleanup }
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

/** 读取响应体时的异常翻译：区分"用户取消"、"空闲超时"和真正的传输错误。 */
function translateStreamError(
  error: unknown,
  handle: StreamHandle,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): unknown {
  if (signal?.aborted === true) return abortError()
  if (handle.timedOut()) return new Error(`下载超时（${timeoutMs} 毫秒内没有收到新数据）：${handle.finalUrl}`)
  return error
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** 只接受 https 网络地址；其它协议在源头就拒掉。 */
function requireHttps(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PermanentError(`下载地址不是合法 URL：${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new PermanentError(`只允许 https 下载地址，已拒绝 ${parsed.protocol}// (${url})`)
  }
  return parsed.toString()
}

/** 本地包伪装成的"URL"：`file://` 或绝对路径。返回 null 表示是网络地址。 */
function localPathFrom(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url)
    } catch (error) {
      throw new PermanentError(`file:// 地址无法解析为本地路径：${url}（${describe(error)}）`)
    }
  }
  if (url.startsWith('https://') || url.startsWith('http://')) return null
  if (isAbsolute(url)) return url
  throw new PermanentError(`不支持的下载地址：${url}（只允许 https 地址、file:// 或本地绝对路径）`)
}

/**
 * 下载到本地文件。成功返回写入的字节数。
 *
 * 失败时目标文件可能残留（半截文件），由调用方负责删除 —— 本函数不删，
 * 因为"谁决定重试/换源"只有调用方知道。
 */
export async function downloadToFile(options: {
  url: string
  dest: string
  signal: AbortSignal
  onProgress?: (p: DownloadProgress) => void
  timeoutMs?: number
  retries?: number
}): Promise<{ bytes: number }> {
  const { url, dest, signal } = options
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const retries = options.retries ?? DOWNLOAD_RETRIES

  const local = localPathFrom(url)
  if (local !== null) {
    // 本地文件没有"重试"语义：不存在就是不存在，复制失败就是复制失败。
    return copyLocalFile(local, dest, signal, options.onProgress)
  }

  const target = requireHttps(url)
  return withRetries(retries, signal, () => downloadOnce(target, dest, signal, timeoutMs, options.onProgress))
}

async function downloadOnce(
  url: string,
  dest: string,
  signal: AbortSignal,
  timeoutMs: number,
  onProgress: ((p: DownloadProgress) => void) | undefined,
): Promise<{ bytes: number }> {
  const handle = await fetchFollowing(url, { timeoutMs, signal, accept: '*/*' })
  try {
    if (!handle.response.ok) {
      throw new HttpError(handle.response.status, handle.response.statusText, handle.finalUrl)
    }
    const body = handle.response.body
    if (body === null) throw new Error(`响应没有内容 (${handle.finalUrl})`)

    const total = parseContentLength(handle.response.headers.get('content-length'))
    const out = createWriteStream(dest)
    // 写流出错（磁盘满等）是异步事件；不挂监听会变成未捕获异常直接崩进程，
    // 所以先兜住，再在循环里主动检查。
    let writeError: Error | null = null
    out.on('error', (error: Error) => {
      writeError = error
    })

    let bytesDone = 0
    onProgress?.({ bytesDone: 0, bytesTotal: total })

    const reader = body.getReader()
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done) break
        const chunk = step.value
        if (chunk === undefined || chunk.byteLength === 0) continue
        bytesDone += chunk.byteLength
        onProgress?.({ bytesDone, bytesTotal: total })
        handle.touch()
        if (!out.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
          await once(out, 'drain')
        }
        if (writeError !== null) throw writeError
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      out.destroy()
      throw translateStreamError(error, handle, signal, timeoutMs)
    }

    out.end()
    await finished(out)
    if (writeError !== null) throw writeError
    return { bytes: bytesDone }
  } finally {
    handle.cleanup()
  }
}

/** 本地包（file:// 或绝对路径）：复制到缓存目录，同样给出进度与取消支持。 */
async function copyLocalFile(
  source: string,
  dest: string,
  signal: AbortSignal,
  onProgress: ((p: DownloadProgress) => void) | undefined,
): Promise<{ bytes: number }> {
  if (resolve(source) === resolve(dest)) {
    // 同一个文件（用户直接点了缓存里的包）：不能自己覆盖自己。
    const self = await stat(source)
    return { bytes: self.size }
  }

  let size: number
  try {
    const info = await stat(source)
    if (!info.isFile()) throw new PermanentError(`本地安装包不是普通文件：${source}`)
    size = info.size
  } catch (error) {
    if (error instanceof PermanentError) throw error
    throw new PermanentError(`读取本地安装包失败：${source}（${describe(error)}）`)
  }

  onProgress?.({ bytesDone: 0, bytesTotal: size })
  let bytesDone = 0
  const input: Readable = createReadStream(source)
  input.on('data', (chunk: string | Buffer) => {
    bytesDone += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    onProgress?.({ bytesDone, bytesTotal: size })
  })

  try {
    await pipeline(input, createWriteStream(dest), { signal })
  } catch (error) {
    if (signal.aborted) throw abortError()
    throw new Error(`复制本地安装包失败：${source}（${describe(error)}）`)
  }
  return { bytes: bytesDone }
}

/**
 * 拉取一段小文本（用于 FOTA 清单）。有大小上限：拿到的要是别的东西
 * （比如一个 HTML 错误页），宁可直接失败，也不要拿它去解析。
 */
export async function fetchText(
  url: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const signal = options?.signal
  const target = requireHttps(url)
  return withRetries(DOWNLOAD_RETRIES, signal, () => readTextOnce(target, timeoutMs, signal))
}

async function readTextOnce(url: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<string> {
  const handle = await fetchFollowing(url, { timeoutMs, signal, accept: 'application/json, text/plain, */*' })
  try {
    if (!handle.response.ok) {
      throw new HttpError(handle.response.status, handle.response.statusText, handle.finalUrl)
    }
    const body = handle.response.body
    if (body === null) return ''

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done) break
        const chunk = step.value
        if (chunk === undefined || chunk.byteLength === 0) continue
        received += chunk.byteLength
        if (received > MAX_TEXT_BYTES) {
          throw new PermanentError(`响应体超过 ${MAX_TEXT_BYTES} 字节上限，已放弃 (${handle.finalUrl})`)
        }
        chunks.push(chunk)
        handle.touch()
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw translateStreamError(error, handle, signal, timeoutMs)
    }
    return new TextDecoder().decode(Buffer.concat(chunks, received))
  } finally {
    handle.cleanup()
  }
}
