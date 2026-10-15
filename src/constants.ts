/**
 * Constants for the standalone FeyaGate CLI (`feyagate`).
 * Engine = miloco-mcp-server, downloaded from GitHub Releases and verified
 * against the sha256 values pinned in manifest/server-manifest.json.
 */
export const CLI_NAME = 'feyagate'
export const MCP_SERVER_NAME = 'feyagate'
/** Default install root under the home directory (independent of the legacy Python skill's ~/.feyagate). */
export const HOME_DIR_NAME = '.feyagate-mcp'

export const DEFAULT_SERVER_PORT = 38080
export const PORT_SCAN_RANGE = 20
export const DEFAULT_WS_PORT = 8765

export const HEALTH_INTERVAL_MS = 500
export const HEALTH_RETRIES = 40
export const HEALTH_REQUEST_TIMEOUT_MS = 1500

export const STOP_GRACE_MS = 5000

export const DOWNLOAD_TIMEOUT_MS = 120_000
export const DOWNLOAD_MAX_REDIRECTS = 5
export const DOWNLOAD_RETRIES = 2

export const TUYA_STATUS_LONG_POLL_MS = 35_000
export const TUYA_STATUS_POLL_INTERVAL_MS = 2_000

export const SERVER_HEALTH_PATH = '/health'
export const SERVER_MCP_PATH = '/mcp/http'

/** How often the stdio bridge re-probes an engine that is not up yet. */
export const BRIDGE_PROBE_INTERVAL_MS = 3000
/** Per-request timeout the stdio bridge applies to proxied MCP calls. */
export const BRIDGE_REQUEST_TIMEOUT_MS = 120_000
