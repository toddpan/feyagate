#!/usr/bin/env node
/**
 * Regenerate manifest/server-manifest.json — the plugin's authoritative server
 * manifest.
 *
 * Why this file exists (and why the plugin must not guess URLs at runtime):
 * upstream asset names drift between releases. Observed so far, for the same
 * repository, in the same year:
 *
 *   miloco-mcp-server-mac-arm64-v1.2.20.zip      <- canonical form
 *   miloco-mcp-server-mac-x64-v1.2.20.tar.gz     <- no zip published at all
 *   miloco-mcp-server-1.2.19-windows-x64.zip     <- version-first, "windows"
 *   miloco-mcp-server.exe                        <- bare binary, no archive
 *
 * and v1.2.20 simply has no Windows asset. Reconstructing the URL from a
 * version + platform at runtime therefore fails, silently or loudly depending
 * on the release. Instead we record what actually exists, per platform, at
 * build/release time, and the plugin reads this file.
 *
 * Usage:
 *   node scripts/gen-manifest.mjs                     # fetch every release
 *   node scripts/gen-manifest.mjs --tag v1.2.20       # only this tag
 *   node scripts/gen-manifest.mjs --compute-missing   # also download assets
 *                                                     # that ship no .sha256
 *                                                     # sidecar and hash them
 *                                                     # locally (defaults only)
 *
 * Integrity policy: an asset entry with `sha256: null` cannot be verified
 * before install, so the plugin refuses to install it unless the user
 * explicitly opts in. `--compute-missing` closes that gap for the *default*
 * target of every platform by downloading the archive once and hashing it;
 * older pinned versions without a published sidecar stay unverifiable and
 * are therefore off the happy path.
 *
 * Requires network access to api.github.com (unauthenticated is fine; the
 * GITHUB_TOKEN env var is used when present to raise the rate limit).
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'toddpan/miloco-mcp-server-releases'
const OUT = join(ROOT, 'manifest', 'server-manifest.json')

/** Platforms the plugin knows how to install. Order matters only for output. */
const PLATFORMS = ['mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64', 'win-x64']

/** FOTA manifest `type` value per platform (the upstream OTA channel). */
const FOTA_TYPE = {
  'mac-arm64': null, // no FOTA entry published for apple silicon (verified 2026-09)
  'mac-x64': 'feyagate-skill-mac-x64',
  'linux-x64': 'feyagate-skill-linux-x64',
  'linux-arm64': null,
  'win-x64': 'feyagate-skill-win-x64',
}

/** Archive kinds we can unpack, best first. */
const KIND_RANK = { zip: 0, 'tar.gz': 1, exe: 2 }

/**
 * Classify one release asset by name.
 * Returns `{ platform, kind }`, or null when the asset is not a server build
 * (sidecars, source archives, checksums, ...).
 */
function classifyAsset(name) {
  if (name.endsWith('.sha256') || name.endsWith('.md5') || name.endsWith('.txt')) return null
  if (name.endsWith('.zip')) {
    const kind = 'zip'
    if (/mac-arm64/.test(name)) return { platform: 'mac-arm64', kind }
    if (/mac-x64/.test(name)) return { platform: 'mac-x64', kind }
    if (/linux-arm64/.test(name)) return { platform: 'linux-arm64', kind }
    if (/linux-x64/.test(name)) return { platform: 'linux-x64', kind }
    if (/win(dows)?-(x64|amd64)/.test(name)) return { platform: 'win-x64', kind }
    return null
  }
  if (name.endsWith('.tar.gz')) {
    if (/mac-arm64/.test(name)) return { platform: 'mac-arm64', kind: 'tar.gz' }
    if (/mac-x64/.test(name)) return { platform: 'mac-x64', kind: 'tar.gz' }
    if (/linux-arm64/.test(name)) return { platform: 'linux-arm64', kind: 'tar.gz' }
    if (/linux-x64/.test(name)) return { platform: 'linux-x64', kind: 'tar.gz' }
    return null
  }
  // Bare executable (published without an archive in some releases).
  if (/^miloco-mcp-server(\.exe)?$/.test(name)) {
    return { platform: name.endsWith('.exe') ? 'win-x64' : process.platform === 'win32' ? 'win-x64' : null, kind: 'exe' }
  }
  return null
}

function headers() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'feyagate-cli-manifest-gen' }
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return h
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers() })
  if (!res.ok) throw new Error(`GitHub ${path} -> HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

/** Fetch a `.sha256` sidecar and return the bare lowercase digest. */
async function fetchDigest(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'feyagate-cli-manifest-gen' } })
    if (!res.ok) return null
    const text = (await res.text()).trim()
    const match = /([0-9a-f]{64})/i.exec(text)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

const tagArgIndex = process.argv.indexOf('--tag')
const onlyTag = tagArgIndex >= 0 ? process.argv[tagArgIndex + 1] : null
const computeMissing = process.argv.includes('--compute-missing')

/** Download an asset to a temp file and return its sha256 (null on failure). */
async function computeDigest(url) {
  const dest = join(tmpdir(), `feyagate-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'feyagate-cli-manifest-gen' }, redirect: 'follow' })
    if (!res.ok || res.body === null) return null
    await pipeline(res.body, createWriteStream(dest))
    const { readFileSync, rmSync } = await import('node:fs')
    const digest = createHash('sha256').update(readFileSync(dest)).digest('hex')
    rmSync(dest, { force: true })
    return digest
  } catch {
    return null
  }
}

const releases = onlyTag
  ? [await gh(`/repos/${REPO}/releases/tags/${onlyTag}`)]
  : await gh(`/repos/${REPO}/releases?per_page=100`)

/** versions[version][platform] = [{file, kind, size, sha256, url}] */
const versions = {}
const skipped = []

for (const release of releases) {
  const raw = String(release.tag_name || '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+/.test(raw)) {
    skipped.push(`tag ${release.tag_name}: not a plain x.y.z version`)
    continue
  }
  const base = `https://github.com/${REPO}/releases/download/${release.tag_name}`
  const perPlatform = {}

  for (const asset of release.assets || []) {
    const classified = classifyAsset(asset.name)
    if (classified === null || classified.platform === null) {
      if (classified !== null) skipped.push(`${release.tag_name}/${asset.name}: platform not derivable`)
      continue
    }
    const { platform, kind } = classified
    const entry = {
      file: asset.name,
      kind,
      size: asset.size,
      url: `${base}/${asset.name}`,
      sha256: null,
    }
    if (kind !== 'exe') {
      entry.sha256 = await fetchDigest(`${base}/${asset.name}.sha256`)
    }
    perPlatform[platform] ??= []
    perPlatform[platform].push(entry)
  }

  for (const platform of Object.keys(perPlatform)) {
    perPlatform[platform].sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9))
  }
  if (Object.keys(perPlatform).length > 0) versions[raw] = { releaseTag: release.tag_name, publishedAt: release.published_at, assets: perPlatform }
}

/** Newest version per platform (drives the default "upgrade to" target). */
const latestByPlatform = {}
for (const platform of PLATFORMS) {
  const candidates = Object.keys(versions).filter((v) => (versions[v].assets[platform] || []).length > 0)
  candidates.sort(compareVersions)
  latestByPlatform[platform] = candidates.at(-1) ?? null
}

/** Version order for humans and for `channel` below. */
function compareVersions(a, b) {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

if (computeMissing) {
  for (const platform of PLATFORMS) {
    const version = latestByPlatform[platform]
    if (version === null) continue
    const entry = versions[version].assets[platform][0]
    if (entry.sha256 !== null) continue
    process.stdout.write(`hashing default ${platform} ${entry.file} (${(entry.size / 1048576).toFixed(1)} MB) ... `)
    const digest = await computeDigest(entry.url)
    entry.sha256 = digest
    console.log(digest ?? 'FAILED (entry stays unverified)')
  }
}

const allVersions = Object.keys(versions).sort(compareVersions)
const manifest = {
  manifestVersion: 1,
  generatedAt: new Date().toISOString(),
  server: {
    name: 'miloco-mcp-server',
    repo: `https://github.com/${REPO}`,
    /** MCP endpoint path on the child process; the plugin's facade mirrors it. */
    mcpPath: '/mcp/http',
    healthPath: '/health',
  },
  sources: {
    /** Highest priority source: exact file names recorded below. */
    github: `https://github.com/${REPO}/releases/download`,
    /** Fallback manifest with per-platform url + md5. */
    fota: 'https://oneapi.sooncore.com/ota/fota.json',
  },
  fotaType: FOTA_TYPE,
  pluginCompat: {
    /**
     * Lowest server version this plugin is willing to run. Below this the
     * plugin refuses to start the child process and asks the user to upgrade.
     */
    minSupportedServer: '1.2.17',
    /** Highest version smoke-tested with this plugin build. */
    maxTestedServer: allVersions.at(-1) ?? null,
  },
  /**
   * Default target version per platform. Windows has no 1.2.20 asset, so its
   * default stays on the newest release that actually shipped a Windows build.
   */
  channel: { stable: latestByPlatform },
  versions,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`wrote ${OUT}`)
console.log(`versions: ${allVersions.join(', ')}`)
let unverified = 0
for (const platform of PLATFORMS) {
  const v = latestByPlatform[platform]
  const file = v ? versions[v].assets[platform][0].file : '(none)'
  const digest = v && versions[v].assets[platform][0].sha256 ? 'sha256 ok' : 'sha256 MISSING'
  console.log(`  ${platform.padEnd(12)} -> ${v ?? '-'}  ${digest}  ${file}`)
}
for (const version of allVersions) {
  for (const assets of Object.values(versions[version].assets)) {
    for (const asset of assets) if (asset.sha256 === null) unverified += 1
  }
}
if (unverified > 0) {
  console.log(`note: ${unverified} asset(s) have no checksum; the plugin requires explicit confirmation to install them.`)
}
if (skipped.length > 0) {
  console.log('skipped:')
  for (const line of skipped) console.log(`  - ${line}`)
}
