/**
 * Tuya QR login helpers.
 *
 * The engine answers `auth/tuya_qr` with a token; the scannable payload is
 * `tuyaSmart--qrLogin/?token=<token>` (what the Tuya / Smart Life app expects).
 */

export const TUYA_QR_PREFIX = 'tuyaSmart--qrLogin/?token='

/**
 * The status endpoint answers an *unscanned* token with
 * `error: "Login failed, please scan and try again!"` — that means "pending",
 * not "expired".
 */
export const TUYA_WAITING_MSG_RE = /scan\s*and\s*try\s*again/i

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,256}$/

export function isTuyaToken(token: string): boolean {
  return TOKEN_PATTERN.test(token)
}

export function tuyaQrPayload(token: string): string {
  return `${TUYA_QR_PREFIX}${token}`
}
