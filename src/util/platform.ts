/**
 * Platform detection and version comparison.
 *
 * Platform tags are the *manifest's* vocabulary, not Node's. The mapping is
 * deliberately explicit and narrow: a platform we cannot name here is a
 * platform we cannot install on, and saying so up front is better than
 * downloading the wrong binary.
 */

export type PlatformTag = 'mac-arm64' | 'mac-x64' | 'linux-x64' | 'linux-arm64' | 'win-x64'

export const PLATFORM_LABELS: Record<PlatformTag, string> = {
  'mac-arm64': 'macOS (Apple 芯片)',
  'mac-x64': 'macOS (Intel)',
  'linux-x64': 'Linux (x64)',
  'linux-arm64': 'Linux (arm64)',
  'win-x64': 'Windows (x64)',
}

/** Map the running Node platform/arch pair to a manifest platform tag. */
export function detectPlatformTag(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformTag | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'mac-arm64'
    if (arch === 'x64') return 'mac-x64'
    return null
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64'
    if (arch === 'arm64') return 'linux-arm64'
    return null
  }
  if (platform === 'win32') {
    // The upstream Windows build is x64 only; arm64 Windows runs it under
    // emulation, which is a supported (if slower) configuration.
    if (arch === 'x64' || arch === 'arm64') return 'win-x64'
    return null
  }
  return null
}

/** Executable name inside an installed version directory. */
export function binaryName(tag: PlatformTag): string {
  return tag === 'win-x64' ? 'miloco-mcp-server.exe' : 'miloco-mcp-server'
}

/** True when this platform needs the macOS quarantine/codesign fixup. */
export function isMac(tag: PlatformTag): boolean {
  return tag === 'mac-arm64' || tag === 'mac-x64'
}

/** Parse `1.2.20` / `1.2.20-rc.1` into comparable numeric segments. */
export function parseVersion(version: string): { parts: number[]; prerelease: string | null } | null {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version).trim())
  if (match === null) return null
  return { parts: match[1]!.split('.').map((part) => Number(part)), prerelease: match[2] ?? null }
}

/**
 * Compare two versions: negative when `a < b`, positive when `a > b`, 0 when
 * equal. A prerelease sorts below its release, and unparseable input sorts
 * below everything parseable (so a typo can never look like an upgrade).
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null && right === null) return 0
  if (left === null) return -1
  if (right === null) return 1
  const length = Math.max(left.parts.length, right.parts.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

/** True when `version` is not older than `minimum`. */
export function atLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0
}
