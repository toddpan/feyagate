# eWeLink Platform Tools

> **Parent skill:** [SKILL.md](../SKILL.md) — provides cross-platform tools (`device/list`, `device/specs`, `auth/platforms`) and MCP endpoint config.

## Authorization

### Account Login

eWeLink uses email/phone and password login.

**Login:**

```json
{
  "name": "auth/ewelink_login",
  "arguments": {
    "email": "YOUR_EMAIL_OR_PHONE",
    "password": "YOUR_PASSWORD",
    "country_code": "+86"
  }
}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `email` | Yes | eWeLink account email or phone number |
| `password` | Yes | eWeLink account password |
| `country_code` | No | Country code (e.g., `+86` for China, `+1` for US). Default `+86` |

Returns on success:
```json
{
  "success": true,
  "auth_status": {
    "authenticated": true,
    "region": "cn",
    "token_remaining_seconds": 2592000,
    "ws_connected": true,
    "ws_handshaked": true
  },
  "device_count": 1
}
```

After login the server auto-refreshes device list and establishes a WebSocket for real-time updates. Token is valid for 30 days. Re-login when expired.

**Refresh device list:**

```json
{
  "name": "ewelink/refresh",
  "arguments": {}
}
```

### Other Auth Tools

| Tool | Description |
|------|-------------|
| `auth/ewelink_logout` | Clear eWeLink authorization |
| `auth/platforms` | Check auth status for all platforms |

## Device Control

> **Parameter naming convention:** eWeLink device control tools use `deviceId` (camelCase), not `device_id`.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `get_ewelink_device_properties` | `deviceId` (string) | All property values |
| `set_ewelink_device_property` | `deviceId` (string), `property` (string), `value` (any) | Set result (free trial / licensed) |
| `ewelink/refresh` | — | Refresh device list from cloud |

**Common properties** (use `device/specs` to discover per-device names):
- `switch`: `on` / `off` (single channel)
- `switches`: JSON array `[{"switch": "on", "outlet": 0}]` (multi-channel)

**Workflow (steps 3–4 use parent skill tools):**
1. `auth/ewelink_login` → login with email/phone and password
2. `ewelink/refresh` → refresh device list from cloud
3. `device/list` with `{"platform": "ewelink"}` → list devices
4. `device/specs` with `{"deviceId": "xxx"}` → get property definitions
5. `set_ewelink_device_property` → control (e.g., `property: "switch"`, `value: "on"`)

### Device Control Example

```json
{
  "name": "set_ewelink_device_property",
  "arguments": {
    "deviceId": "DEVICE_ID",
    "property": "switch",
    "value": "on"
  }
}
```

## License

`set_ewelink_device_property` requires a license. `get_ewelink_device_properties` works without license.
Activate via `license/set` tool.
