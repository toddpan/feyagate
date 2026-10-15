/**
 * 归档解压。
 *
 * 解压是整条安装链路上唯一"把外部字节变成可执行文件"的一步，所以这里的安全
 * 检查不是锦上添花，而是必须自己一个字节一个字节地判：
 *
 *  1. **路径穿越（zip-slip / tar-slip）**：每个条目解出来的绝对路径必须仍在
 *     `destDir` 之内，否则跳过。绝对路径、盘符（`C:\`）、含 `..` 的条目一律
 *     拒绝 —— 上游包一旦被替换（仓库被接管、镜像被投毒），这几条是唯一的防线。
 *  2. **不创建符号链接/硬链接/设备节点**：链接可以把写入重定向到 destDir
 *     之外（先建一个指向 `/etc` 的链接，再往里写文件）。zip 侧我们从不调用
 *     symlink 而是自己写普通文件，tar 侧在 filter 里把非普通文件/目录的条目
 *     全部挡掉。
 *  3. **zip bomb**：单条目与总量都设上限，条目数也设上限。
 *  4. **目标目录必须全新**：不清空别人的目录，宁可报错让上层换个 staging。
 *
 * 「跳过并记警告」的警告走 `onProgress.message` —— 这个签名里没有 logger，
 * 而进度回调是唯一能把这些信息带回 UI 的通道（上层会把它写进任务日志）。
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { open as openZip, getFileNameLowLevel } from 'yauzl'
import * as tar from 'tar'
import type { Stats } from 'node:fs'
import type { Readable } from 'node:stream'
import type { Entry, ZipFile } from 'yauzl'

/** 单个条目解压后的大小上限（512MB）。 */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024

/** 一次解压的总量上限（2GB）。 */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/** 条目数上限：纯粹的放大攻击（百万条空文件）也会拖垮磁盘和 inode。 */
const MAX_ENTRIES = 100_000

/** 解压后的可执行文件权限：rwxr-xr-x。 */
const EXECUTABLE_MODE = 0o755

/** 外部命令（xattr / codesign）单次执行上限，避免卡住安装流程。 */
const EXEC_TIMEOUT_MS = 20_000

const ZIP_FILE_TYPE_MASK = 0o170000
const ZIP_TYPE_REGULAR = 0o100000
const ZIP_TYPE_DIRECTORY = 0o040000
const ZIP_TYPE_SYMLINK = 0o120000

/** 这些后缀天然是 Mach-O（原生插件/dylib），即使读魔术字节失败也要处理。 */
const MACHO_EXTENSIONS = ['.dylib', '.so', '.node']

/** Mach-O / universal binary 的魔术字节。 */
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaede, 0xcafebabe, 0xbebafeca, 0xcafebabf])

export interface ExtractProgress {
  entriesDone: number
  entriesTotal: number | null
  message: string
}

export interface ExtractResult {
  filesWritten: number
  topLevelEntries: string[]
}

/**
 * 按文件名判断归档类型。来源侧（清单/镜像/本地文件）的"类型"信息不一定可靠，
 * 而解压器必须选对，所以这个判断集中在一处，谁需要谁来用。
 */
export function detectArchiveKind(fileName: string): 'zip' | 'tar.gz' | 'exe' | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.exe')) return 'exe'
  return null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

async function assertUsableDir(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir)
    if (entries.length > 0) {
      throw new Error(`解压目标目录非空：${dir}（应当是一个全新的 staging 目录）`)
    }
  } catch (error) {
    if (isEnoent(error)) {
      await mkdir(dir, { recursive: true })
      return
    }
    throw error
  }
}

/**
 * 把归档内的相对路径映射成 destDir 内的绝对路径；不安全则返回 null。
 * 这是 zip-slip / tar-slip 的唯一防线，所以判得比较啰嗦：
 * 先否掉绝对路径与盘符，再否掉任何 `..` 段，最后用 resolve 后的前缀做兜底
 * （防止 `a/../../b` 这类只在 resolve 之后才显形的写法）。
 */
function safeTarget(destDir: string, rawName: string): string | null {
  const name = rawName.trim()
  if (name === '' || name.includes('\0')) return null
  // 反斜杠在 POSIX 上本是合法文件名字符，但归档里出现它通常意味着 Windows
  // 路径或有人故意构造歧义路径，一律拒绝比"猜他想干什么"安全。
  if (name.includes('\\')) return null
  if (isAbsolute(name)) return null
  if (/^[A-Za-z]:/.test(name)) return null

  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null

  const target = resolve(destDir, ...segments)
  if (target !== destDir && !target.startsWith(`${destDir}${sep}`)) return null
  return target
}

/** 记录条目所属的顶层名字，供调用方决定是否需要"去掉单层目录"。 */
function recordTopLevel(bucket: Set<string>, destDir: string, target: string): void {
  const rel = relative(destDir, target)
  if (rel === '' || rel.startsWith('..')) return
  const first = rel.split(sep)[0]
  if (first !== undefined && first !== '') bucket.add(first)
}

/** yauzl 全是回调 API，这里逐个包成 Promise。 */
function openZipFile(file: string): Promise<ZipFile> {
  return new Promise<ZipFile>((resolve_, reject) => {
    openZip(
      file,
      {
        lazyEntries: true,
        // autoClose 必须关掉：我们要先把中央目录全部读完做校验，
        // 再回来逐个条目开流（打开之后才能判断这个包能不能信）。
        autoClose: false,
        // 刻意关掉 yauzl 的字符串解码：它一旦解码就会顺带跑自己的
        // validateFileName，而那个检查只要发现一个 `..`/绝对路径条目就让
        // **整包**报错（与 strictFileNames 无关），契约要求的却是"跳过该条目
        // 并记警告"。改成自己解码 —— 复用 yauzl 导出的 getFileNameLowLevel，
        // 它同样处理 UTF-8 标志位与 0x7075 Unicode Path 扩展字段并校验 CRC，
        // 安全性判定则全部由下面的 safeTarget 负责。
        decodeStrings: false,
        validateEntrySizes: true,
      },
      (error, zipfile) => {
        if (error !== null) reject(error)
        else resolve_(zipfile)
      },
    )
  })
}

/** 按 yauzl 的规则把条目名解成字符串（顺带把反斜杠归一到 `/`）。 */
function zipEntryName(entry: Entry): string {
  return getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false)
}

function readAllEntries(zipfile: ZipFile): Promise<Entry[]> {
  return new Promise<Entry[]>((resolve_, reject) => {
    const entries: Entry[] = []
    zipfile.on('entry', (entry: Entry) => {
      entries.push(entry)
      zipfile.readEntry()
    })
    zipfile.once('end', () => resolve_(entries))
    zipfile.once('error', reject)
    zipfile.readEntry()
  })
}

function openEntryStream(zipfile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise<Readable>((resolve_, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error !== null) reject(error)
      else resolve_(stream)
    })
  })
}

/**
 * 流式写入并统计字节数。yauzl 的 `validateEntrySizes` 已经会核对声明的
 * uncompressedSize，这里再数一遍是为了兜住"声明值本身就在上限内、但实际
 * 数据更多"的情况。
 */
async function writeStreamCapped(source: Readable, target: string, cap: number): Promise<void> {
  let written = 0
  source.on('data', (chunk: string | Buffer) => {
    written += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (written > cap) source.destroy(new Error(`解压数据超过单条目上限 ${cap} 字节：${target}`))
  })
  await pipeline(source, createWriteStream(target))
}

interface ZipPlan {
  entry: Entry
  name: string
  target: string
  directory: boolean
}

async function extractZip(
  archive: string,
  destDir: string,
  onProgress: ((p: ExtractProgress) => void) | undefined,
): Promise<ExtractResult> {
  const zipfile = await openZipFile(archive)
  try {
    const entries = await readAllEntries(zipfile)
    if (entries.length > MAX_ENTRIES) {
      throw new Error(`归档条目数 ${entries.length} 超过上限 ${MAX_ENTRIES}`)
    }

    // 先整体校验，再动磁盘：一个被投毒的包不该在 destDir 里留下任何半成品。
    const plans: ZipPlan[] = []
    let declaredTotal = 0
    for (const entry of entries) {
      const name = zipEntryName(entry)
      const isDirectory = name.endsWith('/')
      const hostIsUnix = entry.versionMadeBy >>> 8 === 3
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
      const fileType = unixMode & ZIP_FILE_TYPE_MASK

      if (!isDirectory && hostIsUnix && fileType !== 0 && fileType !== ZIP_TYPE_REGULAR) {
        const kind = fileType === ZIP_TYPE_SYMLINK ? '符号链接' : '特殊文件'
        onProgress?.({ entriesDone: 0, entriesTotal: entries.length, message: `已跳过${kind}条目：${name}` })
        continue
      }
      if (!isDirectory && fileType === ZIP_TYPE_DIRECTORY) {
        // 少数打包器把目录写成不以 '/' 结尾；当目录处理即可。
        const target = safeTarget(destDir, name)
        if (target === null) {
          onProgress?.({ entriesDone: 0, entriesTotal: entries.length, message: `已跳过不安全路径条目：${name}` })
          continue
        }
        plans.push({ entry, name, target, directory: true })
        continue
      }

      const target = safeTarget(destDir, name)
      if (target === null) {
        onProgress?.({ entriesDone: 0, entriesTotal: entries.length, message: `已跳过不安全路径条目：${name}` })
        continue
      }
      if (isDirectory) {
        plans.push({ entry, name, target, directory: true })
        continue
      }

      if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
        throw new Error(`条目 ${name} 声明的解压后大小 ${entry.uncompressedSize} 超过上限 ${MAX_ENTRY_BYTES}`)
      }
      declaredTotal += entry.uncompressedSize
      if (declaredTotal > MAX_TOTAL_BYTES) {
        throw new Error(`归档声明的解压总量超过上限 ${MAX_TOTAL_BYTES} 字节，已中止`)
      }
      plans.push({ entry, name, target, directory: false })
    }

    const topLevel = new Set<string>()
    let filesWritten = 0
    let done = 0
    for (const plan of plans) {
      done += 1
      const { name } = plan
      onProgress?.(
        plan.directory
          ? { entriesDone: done, entriesTotal: plans.length, message: `正在创建目录 ${name}` }
          : { entriesDone: done, entriesTotal: plans.length, message: `正在解压 ${name}` },
      )
      if (plan.directory) {
        await mkdir(plan.target, { recursive: true })
        recordTopLevel(topLevel, destDir, plan.target)
        continue
      }
      await mkdir(dirname(plan.target), { recursive: true })
      const stream = await openEntryStream(zipfile, plan.entry)
      await writeStreamCapped(stream, plan.target, MAX_ENTRY_BYTES)
      filesWritten += 1
      recordTopLevel(topLevel, destDir, plan.target)
    }

    return { filesWritten, topLevelEntries: [...topLevel] }
  } finally {
    zipfile.close()
  }
}

interface TarEntryInfo {
  path: string
  type: string
  size: number
  meta: boolean
}

async function extractTar(
  archive: string,
  destDir: string,
  onProgress: ((p: ExtractProgress) => void) | undefined,
): Promise<ExtractResult> {
  // 第一遍只读"目录"（不写盘）：tar 的 filter 只能按条目路径放行，而我们想先
  // 知道整个包是否可信，再决定要不要产生任何字节。
  const listed: TarEntryInfo[] = []
  await tar.t({
    file: archive,
    onwarn: (code: string, message: string) => {
      onProgress?.({ entriesDone: 0, entriesTotal: null, message: `tar 警告 ${code}: ${message}` })
    },
    onentry: (entry: tar.ReadEntry) => {
      listed.push({ path: entry.path, type: entry.type, size: entry.size, meta: entry.meta })
    },
  })
  if (listed.length > MAX_ENTRIES) throw new Error(`归档条目数 ${listed.length} 超过上限 ${MAX_ENTRIES}`)

  const allowed = new Set<string>()
  const topLevel = new Set<string>()
  let declaredTotal = 0
  for (const item of listed) {
    // PaxHeader/ExtendedHeader 之类的元条目不是文件，tar 自己会消费掉。
    if (item.meta || item.path === '') continue
    const isDirectory = item.type === 'Directory'
    const isFile = item.type === 'File' || item.type === 'OldFile' || item.type === 'ContiguousFile'
    if (!isDirectory && !isFile) {
      onProgress?.({
        entriesDone: 0,
        entriesTotal: listed.length,
        message: `已跳过非普通文件条目（${item.type}）：${item.path}`,
      })
      continue
    }
    const target = safeTarget(destDir, item.path)
    if (target === null) {
      onProgress?.({ entriesDone: 0, entriesTotal: listed.length, message: `已跳过不安全路径条目：${item.path}` })
      continue
    }
    if (isFile) {
      if (item.size > MAX_ENTRY_BYTES) {
        throw new Error(`条目 ${item.path} 声明的解压后大小 ${item.size} 超过上限 ${MAX_ENTRY_BYTES}`)
      }
      declaredTotal += item.size
      if (declaredTotal > MAX_TOTAL_BYTES) {
        throw new Error(`归档声明的解压总量超过上限 ${MAX_TOTAL_BYTES} 字节，已中止`)
      }
    }
    allowed.add(item.path)
    recordTopLevel(topLevel, destDir, target)
  }

  let filesWritten = 0
  let done = 0
  await tar.x({
    file: archive,
    cwd: destDir,
    // 路径策略完全由上面的白名单决定：不让 tar 做任何"帮忙"的路径加工，
    // 也不让它按归档里的权限位 chmod（可执行位由 ensureExecutableMode 显式设置）。
    preservePaths: false,
    strict: false,
    chmod: false,
    filter: (path: string, entry: Stats | tar.ReadEntry): boolean => {
      if (!allowed.has(path)) return false
      done += 1
      const isDirectory = 'type' in entry && entry.type === 'Directory'
      if (!isDirectory) filesWritten += 1
      onProgress?.({
        entriesDone: done,
        entriesTotal: allowed.size,
        message: isDirectory ? `正在创建目录 ${path}` : `正在解压 ${path}`,
      })
      return true
    },
    onwarn: (code: string, message: string) => {
      onProgress?.({ entriesDone: done, entriesTotal: allowed.size, message: `tar 警告 ${code}: ${message}` })
    },
  })

  return { filesWritten, topLevelEntries: [...topLevel] }
}

/**
 * 裸可执行文件（个别 Windows 版本只发 `miloco-mcp-server.exe`，没有归档）。
 *
 * 这里用**源文件名**作为落地名：清单里的 exe 资产文件名本身就是
 * `miloco-mcp-server.exe`，落成同名即符合预期；若用户给的是别的名字，
 * 上层（`installBinary`）会在确认阶段把它改成平台约定的二进制名。
 */
async function extractExe(archive: string, destDir: string): Promise<ExtractResult> {
  const name = basename(archive)
  if (name === '') throw new Error(`无法从路径推断可执行文件名：${archive}`)
  const target = join(destDir, name)
  await copyFile(archive, target)
  await chmod(target, EXECUTABLE_MODE)
  return { filesWritten: 1, topLevelEntries: [name] }
}

export async function extractArchive(options: {
  archive: string
  kind: 'zip' | 'tar.gz' | 'exe'
  destDir: string
  onProgress?: (p: ExtractProgress) => void
}): Promise<ExtractResult> {
  const destDir = resolve(options.destDir)
  await assertUsableDir(destDir)

  switch (options.kind) {
    case 'zip':
      return extractZip(options.archive, destDir, options.onProgress)
    case 'tar.gz':
      return extractTar(options.archive, destDir, options.onProgress)
    case 'exe':
      return extractExe(options.archive, destDir)
  }
}

/**
 * 归档里只有一个顶层目录时，把它的内容上移一层。
 *
 * 上游两种打包方式并存：Windows 包有一个顶层目录（`miloco-mcp-server/`），
 * mac/Linux 包是平铺的。上移之后两种形态在磁盘上就一致了，调用方只需在
 * 固定位置找二进制。
 *
 * 两个细节是踩过的坑：
 *  * macOS 的 tar/zip 会写入 `._*`（AppleDouble）与 `.DS_Store` 这类纯元数据
 *    条目，它们会让"只有一个顶层目录"的判定失效 —— 必须无视。
 *  * 顶层目录名可能和它内部的条目同名（`miloco-mcp-server/miloco-mcp-server`），
 *    直接 rename 会撞到目录自身（EISDIR）。所以先把整个顶层目录改成一个随机
 *    临时名，再把内容搬上来，最后删掉空壳。
 */
export async function flattenSingleTopDir(destDir: string): Promise<boolean> {
  const root = resolve(destDir)
  const top = (await readdir(root)).filter((name) => !isMetadataEntry(name))
  if (top.length !== 1) return false
  const only = top[0]
  if (only === undefined) return false
  const nested = join(root, only)
  let info: Stats
  try {
    info = await stat(nested)
  } catch {
    return false
  }
  if (!info.isDirectory()) return false

  const holding = join(root, `.flatten-${randomBytes(6).toString('hex')}`)
  await rename(nested, holding)
  try {
    for (const child of await readdir(holding)) {
      await rename(join(holding, child), join(root, child))
    }
  } finally {
    await rm(holding, { recursive: true, force: true })
  }
  return true
}

/** macOS 元数据条目：它们不是包内容，判定布局时必须当它们不存在。 */
function isMetadataEntry(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._')
}

/** 给二进制补上可执行位。Windows 上 chmod 没有意义，失败也只是忽略。 */
export async function ensureExecutableMode(file: string): Promise<void> {
  try {
    await chmod(file, EXECUTABLE_MODE)
  } catch (error) {
    if (process.platform !== 'win32') {
      throw new Error(`设置可执行权限失败：${file}（${describe(error)}）`)
    }
  }
}

async function run(command: string, args: string[]): Promise<{ ok: boolean; error: string }> {
  // 一律 execFile：参数是数组，不经过 shell，所以路径里的空格/引号/分号
  // 都不可能变成命令注入。
  return new Promise<{ ok: boolean; error: string }>((resolve_) => {
    execFile(command, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve_({ ok: true, error: '' })
        return
      }
      const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : error.message
      resolve_({ ok: false, error: detail })
    })
  })
}

/** 递归列出普通文件（不跟随符号链接：跟着走会跑出 destDir 去改别的文件）。 */
async function listRegularFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const name of await readdir(current)) {
      const path = join(current, name)
      let info: Stats
      try {
        info = await lstat(path)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await walk(path)
      else if (info.isFile()) found.push(path)
    }
  }
  await walk(dir)
  return found
}

async function isMachO(file: string): Promise<boolean> {
  if (MACHO_EXTENSIONS.some((extension) => file.endsWith(extension))) return true
  try {
    const handle = await readFile(file)
    const head = handle.subarray(0, 4)
    if (head.length < 4) return false
    return MACHO_MAGICS.has(head.readUInt32BE(0)) || MACHO_MAGICS.has(head.readUInt32LE(0))
  } catch {
    return false
  }
}

/**
 * macOS 上的隔离属性与临时签名。
 *
 * 从浏览器/网盘下下来的 zip 会被打上 `com.apple.quarantine`，Gatekeeper 会
 * 直接拒绝运行（"已损坏"或"无法验证开发者"）；上游二进制又通常是 ad-hoc
 * 签名的，改动 dylib 后签名失效。所以：先对所有 Mach-O 去掉隔离属性，再做
 * 一次 ad-hoc 重签（`codesign --sign -`）——先 dylib 后主二进制，因为主
 * 二进制的签名会引用 dylib 的签名。
 *
 * 没装 Xcode 命令行工具的机器上 `codesign` 可能不存在，那样只记 warning：
 * 装不上比装不上还报错更糟。非 macOS 直接返回空结果。
 */
export async function fixMacQuarantine(
  dir: string,
): Promise<{ deQuarantined: boolean; signed: string[]; warnings: string[] }> {
  const result: { deQuarantined: boolean; signed: string[]; warnings: string[] } = {
    deQuarantined: false,
    signed: [],
    warnings: [],
  }
  if (process.platform !== 'darwin') return result

  const candidates: string[] = []
  for (const file of await listRegularFiles(resolve(dir))) {
    if (await isMachO(file)) candidates.push(file)
  }
  // 先 dylib/插件，再可执行文件。
  candidates.sort((left, right) => rankMachO(left) - rankMachO(right))

  for (const file of candidates) {
    const outcome = await run('xattr', ['-dr', 'com.apple.quarantine', file])
    if (outcome.ok) {
      result.deQuarantined = true
      continue
    }
    // 本来就没有这个属性时会报 "No such xattr"，这不是问题，不该刷屏。
    if (!outcome.error.includes('No such xattr')) {
      result.warnings.push(`去除隔离属性失败：${file}（${outcome.error}）`)
    }
  }

  for (const file of candidates) {
    const outcome = await run('codesign', ['--force', '--sign', '-', '--timestamp=none', file])
    if (outcome.ok) result.signed.push(file)
    else result.warnings.push(`ad-hoc 签名失败：${file}（${outcome.error}）`)
  }

  return result
}

function rankMachO(file: string): number {
  return MACHO_EXTENSIONS.some((extension) => file.endsWith(extension)) ? 0 : 1
}
