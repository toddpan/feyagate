# Hardware Extension & Integration Tools

> **Parent skill:** [SKILL.md](../SKILL.md) — provides cross-platform tools and MCP endpoint config.

## Xiaozhi AI Platform

> FeyaGate supports up to N parallel Xiaozhi AI WebSocket connections. The server acts as a WebSocket **client** — it connects *out* to Xiaozhi, not the other way around. All other registered MCP tools are automatically bridged to Xiaozhi clients (except a small exclusion list like `xiaomi/camera_snapshot`, internal config/stats tools, and auth tools).

| Tool | Arguments | Returns |
|------|-----------|---------|
| `xiaozhi/status` | — | Connection state for all clients (incl. bridged tool count) |
| `xiaozhi/list` | — | All configured endpoints with state |
| `xiaozhi/add` | `endpoint` (string, `ws://` or `wss://`) | New client index |
| `xiaozhi/remove` | `index` (int) | Remove result |
| `xiaozhi/set_endpoint` | `endpoint` (opt) | Set/disable the first client (legacy compat) |

**Example — add a Xiaozhi endpoint:**
```json
{
  "name": "xiaozhi/add",
  "arguments": { "endpoint": "wss://api.xiaozhi.example/mcp" }
}
```

**Example — disable (legacy single-endpoint):**
```json
{ "name": "xiaozhi/set_endpoint", "arguments": { "endpoint": "" } }
```

## System Tools

### License

| Tool | Arguments | Returns |
|------|-----------|---------|
| `license/status` | — | `edition` (`free`/`licensed`), `status`, `guidance` |
| `license/set` | `license_key` (string, `FG-XXXX-XXXX-XXXX`), `product` (opt) | Activation result |
| `license/clear` | — | Clear result |

### Gateway Info

| Tool | Arguments | Returns |
|------|-----------|---------|
| `gateway/info` | — | Version, platform, device ID, license state |

### Configuration

| Tool | Arguments | Returns |
|------|-----------|---------|
| `config/get_vision` | — | Vision AI settings (api key masked) |
| `config/set_vision` | `enabled`, `api_key`, `base_url`, `model`, `temperature`, `max_tokens`, `timeout_seconds` (all opt) | Update result |
| `config/get_trigger` | — | Trigger engine settings |
| `config/set_trigger` | `enabled`, `interval_seconds`, `vision_img_count`, `motion_threshold`, `log_ttl_days`, `min_trigger_interval` (all opt) | Update result |

### Statistics

| Tool | Arguments | Returns |
|------|-----------|---------|
| `stats/token_usage` | `days` (opt, default 30) | Token usage summary (daily / by-model / by-source) |
| `stats/token_records` | `limit` (opt, default 50) | Recent LLM call records |
| `stats/trigger_summary` | `days` (opt, default 30) | Trigger event aggregates (daily / by-rule / by-camera / heatmap) |
| `stats/dashboard` | — | Full dashboard summary (system + today) |
