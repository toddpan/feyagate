/**
 * 装完二进制之后的最后一道静态检查：`otool -L` 读出 Mach-O 主程序声明的
 * `@executable_path` / `@loader_path` 依赖，逐一确认文件真的随包解压出来了。
 *
 * 上游 v1.2.20 的 mac-arm64 zip 一度只打包了 9 个动态库里的 1 个，dyld 在健康
 * 检查之前就 SIGABRT，用户看到的是一句 exit code 加一段汇编味的报错。这道检查
 * 让同类事故在启动之前就变成一句人话：「发布包缺少 lib/xxx.dylib」。它放在切
 * 版本之前：缺失时抛错走安装失败路径，正在运行的旧版本原样保留。
 *
 * 只在 darwin 上执行（otool 属于 macOS 工具链）；otool 不在（未装 Xcode CLT）
 * 时记一条日志就跳过——预检是加固，不能反过来变成新环境的启动门槛。Windows
 * 的 PE 依赖是另一套工具链（dumpbin），不在这里覆盖。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 布局参数能用到的最小日志面；调用方传插件的 LogBuffer 即可。 */
export interface MachODepsLog {
  warn(text: string): void
}

export interface MachODepsCheck {
  /** 实际核对的声明数；0 表示没检查（非 darwin 平台或 otool 不可用）。 */
  checked: number
}

/** otool -L 的依赖行：`→ @executable_path/lib/a.dylib (compatibility version …)`；括号里含空格，只锚定到 ` (` 为止。 */
const DEP_LINE = /^\s+(@executable_path|@loader_path)\/(\S+) \(/

/** 解析 otool -L 输出里本插件能核对的随包依赖声明（系统库路径一律不管）。 */
function parseDeclaredDeps(otoolOutput: string): Array<{ path: string }> {
  const deps: Array<{ path: string }> = []
  for (const line of otoolOutput.split(/\r?\n/)) {
    const match = DEP_LINE.exec(line)
    if (match === null) continue
    deps.push({ path: match[2]! })
  }
  return deps
}

/**
 * 校验 `<versionDir>/<binary>` 声明的每个随包动态库都真实存在，缺了就抛出一句
 * 可直接展示给用户的错误。返回核对的声明数，调用方可据此记一条通过日志。
 */
export async function verifyMachODeps(
  versionDir: string,
  binary: string,
  platform: string,
  log?: MachODepsLog,
): Promise<MachODepsCheck> {
  if (platform !== 'mac-arm64' && platform !== 'mac-x64') return { checked: 0 }
  const binaryPath = join(versionDir, binary)

  let output: string
  try {
    output = (await execFileAsync('otool', ['-L', binaryPath])).stdout
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      log?.warn('otool 不可用（未安装 Xcode 命令行工具），跳过动态库依赖预检')
      return { checked: 0 }
    }
    throw new Error(`动态库依赖预检失败：otool -L 无法读取 ${binary}（${(error as Error).message}）`)
  }

  const declared = parseDeclaredDeps(output)
  // @executable_path 相对可执行文件所在目录（版本目录根）；@loader_path 对主
  // 可执行文件指向同一位置。
  const missing = declared.filter((dep) => !existsSync(join(versionDir, dep.path))).map((dep) => dep.path)
  if (missing.length > 0) {
    throw new Error(
      `发布包不完整：二进制声明了 ${missing.length} 个随包动态库，但压缩包里没有 ${missing.join('、')}` +
        '（直接启动会被 dyld SIGABRT 杀掉；请让上游重新打包该版本，或换一个下载来源）',
    )
  }
  return { checked: declared.length }
}
