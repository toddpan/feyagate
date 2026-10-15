/**
 * `<root>/state.json` store. One file, written atomically, read fresh on every
 * CLI invocation (the CLI is short-lived, so there is no in-memory cache to go
 * stale between two concurrent invocations).
 */

import { existsSync } from 'node:fs'

import { DEFAULT_SERVER_PORT } from './constants.js'
import { clearCurrentPointer, ensureLayout, readCurrentPointer, stateFile, writeCurrentPointer } from './paths.js'
import { readJson, writeJsonAtomic } from './util/atomic.js'
import type { PersistedState } from './types.js'

function defaults(): PersistedState {
  return { schemaVersion: 1, currentVersion: null, lastKnownGood: null, pending: null, port: DEFAULT_SERVER_PORT, lastUpdateCheck: null }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Merge a possibly hand-edited file onto the defaults, validating each field. */
export function normalizeState(raw: unknown): PersistedState {
  const base = defaults()
  if (raw === null || typeof raw !== 'object') return base
  const input = raw as Record<string, unknown>
  const port = typeof input.port === 'number' && Number.isInteger(input.port) && input.port > 0 && input.port < 65536 ? input.port : base.port
  const pendingRaw = input.pending as Record<string, unknown> | null | undefined
  const pending =
    pendingRaw !== null && typeof pendingRaw === 'object' && typeof pendingRaw.version === 'string'
      ? { version: pendingRaw.version, startedAt: Number(pendingRaw.startedAt) || Date.now() }
      : null
  return {
    schemaVersion: 1,
    currentVersion: str(input.currentVersion),
    lastKnownGood: str(input.lastKnownGood),
    pending,
    port,
    lastUpdateCheck: typeof input.lastUpdateCheck === 'number' ? input.lastUpdateCheck : null,
  }
}

export class StateStore {
  constructor(readonly root: string) {}

  get(): PersistedState {
    const state = normalizeState(readJson<unknown>(stateFile(this.root), null))
    // The pointer file is the tiebreaker: it is written in the same step as the
    // activation, so a state.json lost or corrupted mid-write can be recovered.
    if (state.currentVersion === null && existsSync(stateFile(this.root)) === false) {
      state.currentVersion = readCurrentPointer(this.root)
    }
    return state
  }

  patch(update: Partial<PersistedState>): PersistedState {
    ensureLayout(this.root)
    const next = { ...this.get(), ...update, schemaVersion: 1 as const }
    writeJsonAtomic(stateFile(this.root), next)
    if (next.currentVersion === null) clearCurrentPointer(this.root)
    else writeCurrentPointer(this.root, next.currentVersion)
    return next
  }

  /** Record an activation that has not proven itself yet. */
  markPending(version: string): void {
    this.patch({ pending: { version, startedAt: Date.now() } })
  }

  /** The pending version answered /health: it becomes current and known-good. */
  confirmHealthy(version: string): void {
    this.patch({ pending: null, currentVersion: version, lastKnownGood: version })
  }
}
