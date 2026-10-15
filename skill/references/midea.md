# Midea Platform Tools

> **Parent skill:** [SKILL.md](../SKILL.md) — provides cross-platform tools (`device/list`, `device/specs`, `auth/platforms`) and MCP endpoint config.

## Authorization

### Account Login

Midea uses account/password login via the Meiju (美居) app credentials.

**Login:**

```json
{
  "name": "auth/midea_login",
  "arguments": {
    "account": "YOUR_PHONE_OR_EMAIL",
    "password": "YOUR_PASSWORD",
    "cloud": "meiju"
  }
}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `account` | Yes | Meiju app phone number or email |
| `password` | Yes | Meiju app password |
| `cloud` | No | Cloud type: `meiju` (美居, default) or `msmart` (MSmartHome) |

Returns on success:
```json
{
  "success": true,
  "auth_status": { "...": "..." },
  "device_count": 0
}
```

After login the server auto-refreshes device list. Token validity is returned in `auth_status.token_remaining_seconds`. Re-login when expired.

**Refresh device list:**

```json
{
  "name": "midea/refresh",
  "arguments": {}
}
```

### Other Auth Tools

| Tool | Description |
|------|-------------|
| `auth/midea_logout` | Clear Midea authorization |
| `auth/platforms` | Check auth status for all platforms |

## Device Control

> **Parameter naming convention:** Midea device control tools use `deviceId` (camelCase), not `device_id`.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `get_midea_device_properties` | `deviceId` (string) | All property values |
| `set_midea_device_property` | `deviceId` (string), `property` (string), `value` (any) | Set result (free trial / licensed) |
| `midea/refresh` | — | Refresh device list from cloud |

**Common properties** (use `device/specs` to discover per-device names):
- `power`: `0` / `1` (off/on)
- `temperature`: number (e.g., `26`)
- `mode`: string (`cool`, `heat`, `auto`)
- `fan_speed`: string (`low`, `medium`, `high`)

**Workflow (steps 3–4 use parent skill tools):**
1. `auth/midea_login` → login with account/password
2. `midea/refresh` → refresh device list from cloud
3. `device/list` with `{"platform": "midea"}` → list devices
4. `device/specs` with `{"deviceId": "xxx"}` → get property/action definitions
5. `set_midea_device_property` → control (e.g., `property: "power"`, `value: 1`)

### Device Control Example

```json
{
  "name": "set_midea_device_property",
  "arguments": {
    "deviceId": "DEVICE_ID",
    "property": "power",
    "value": 1
  }
}
```

## License

`set_midea_device_property` requires a license. `get_midea_device_properties` works without license.
Activate via `license/set` tool.
