/**
 * Shared types: the manifest contract (consumed by the downloader) and the
 * on-disk state contract (owned by the engine manager).
 */

import type { PlatformTag } from './util/platform.js'

export type { PlatformTag }

// ──────────────────────────────────────────────────────────────── manifest

/** One downloadable archive (or bare executable) for one platform. */
export interface ManifestAsset {
  /** Exact file name as published upstream. Never reconstructed at runtime. */
  file: string
  kind: 'zip' | 'tar.gz' | 'exe'
  /** Published size in bytes, used for progress and sanity checks. */
  size: number
  /** Absolute download URL on the primary (GitHub Releases) channel. */
  url: string
  /**
   * Lower-case hex sha256 from the published `.sha256` sidecar, or computed at
   * manifest-generation time when no sidecar exists. `null` means the asset
   * cannot be verified before install; the UI must ask the user explicitly.
   */
  sha256: string | null
}

export interface ManifestVersion {
  /** Upstream git tag, e.g. `v1.2.20`. */
  releaseTag: string
  publishedAt: string
  /** Only the platforms this release actually shipped. */
  assets: Partial<Record<PlatformTag, ManifestAsset[]>>
}

export interface ServerManifest {
  manifestVersion: number
  generatedAt: string
  server: {
    name: string
    repo: string
    /** MCP endpoint path on the child process, e.g. `/mcp/http`. */
    mcpPath: string
    /** Health endpoint path, e.g. `/health`. */
    healthPath: string
  }
  sources: {
    /** Base for `<base>/<tag>/<file>`. */
    github: string
    /** Fallback manifest URL carrying its own per-platform url + md5. */
    fota: string
  }
  /** FOTA `type` id per platform; null when the channel publishes none. */
  fotaType: Partial<Record<PlatformTag, string | null>>
  pluginCompat: {
    /** Refuse to run anything below this version. */
    minSupportedServer: string
    /** Highest version this plugin build was smoke-tested against. */
    maxTestedServer: string | null
  }
  /** Default target version per platform (newest that actually shipped there). */
  channel: { stable: Partial<Record<PlatformTag, string | null>> }
  /** All known versions, newest last when sorted with `compareVersions`. */
  versions: Record<string, ManifestVersion>
}

/** A resolved download target: one asset plus the version it belongs to. */
export interface ResolvedAsset {
  version: string
  platform: PlatformTag
  asset: ManifestAsset
  /** True when `asset.sha256 === null`: the user must opt in to install it. */
  unverified: boolean
}

// ──────────────────────────────────────────────────────────── persisted state

// ──────────────────────────────────────────────────────────── persisted state

/**
 * `<root>/state.json` — the one mutable bookkeeping file. Written atomically.
 *
 * `pending` is the activation handshake: it is recorded *before* a new version
 * is started and cleared only after `/health` answers. Finding it set later
 * means the activation never proved itself, so the CLI rolls back to
 * `lastKnownGood`.
 */
export interface PersistedState {
  schemaVersion: 1
  currentVersion: string | null
  lastKnownGood: string | null
  pending: { version: string; startedAt: number } | null
  /** Preferred engine HTTP port. */
  port: number
  /** Last time `upgrade --check` ran (ms epoch), for the doctor's hint. */
  lastUpdateCheck: number | null
}

/** Summary of the manifest's compatibility gates for one platform. */
export interface CompatSummary {
  minSupportedServer: string
  maxTestedServer: string | null
  latestVersion: string | null
  latestVersionMatches: PlatformTag
}
