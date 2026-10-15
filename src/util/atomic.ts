/**
 * Atomic small-file writes.
 *
 * `state.json` and `current` are read on every boot and written during
 * installs, so a half-written file is a real failure mode: a truncated
 * `state.json` loses the rollback target, and a truncated `current` makes the
 * plugin believe nothing is installed. Both are written to a sibling temp file
 * and renamed, which is atomic on the same filesystem.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Write UTF-8 text so readers see either the old file or the complete new one. */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(temp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Write a JSON document, pretty-printed and newline-terminated. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/**
 * Read and parse JSON, returning `fallback` for a missing, unreadable, or
 * malformed file. Callers that must distinguish "absent" from "broken" should
 * pass `undefined` and check, which is what the state store does.
 */
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
