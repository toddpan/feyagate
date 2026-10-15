# Tuya Platform Tools

> **Parent skill:** [SKILL.md](../SKILL.md) — provides cross-platform tools (`device/list`, `device/specs`, `auth/platforms`) and MCP endpoint config.

## Authorization

### QR Code Authorization Flow

Tuya uses QR code scanning for authorization via the Smart Life / Tuya app.

**Step 1: Get user code**

Open the Smart Life (涂鸦智能) or Tuya app on your phone:
- Go to **My (我的) → Settings (设置) → Account & Security (账号与安全)**
- Find your **User Code (用户代码)**, e.g. `AxNmcp2`

**Step 2: Generate QR code**

```json
{
  "name": "auth/tuya_qr",
  "arguments": { "user_code": "YOUR_USER_CODE" }
}
```

Returns (the canonical fields):
```json
{
  "success": true,
  "qr_url": "tuyaSmart--qrLogin/?token=xxx",
  "token": "xxx",
  "expire_time": 300
}
```

**Step 3: Scan QR code**

Convert `qr_url` to a QR code image and scan it with the Smart Life / Tuya app.
Confirm the authorization on the app when prompted.

**Step 4: Check scan status**

Poll until authorized (within 5 minutes):
```json
{
  "name": "auth/tuya_qr_status",
  "arguments": {
    "token": "QR_TOKEN_FROM_STEP_2",
    "user_code": "YOUR_USER_CODE"
  }
}
```

Returns on success:
```json
{ "success": true, "status": "success" }
```

Other statuses: `"error"` (not scanned / expired), `"scanned"` (scanned but not confirmed).

**Step 5: Refresh device list**

```json
{
  "name": "tuya/refresh",
  "arguments": {}
}
```

### Other Auth Tools

| Tool | Description |
|------|-------------|
| `auth/tuya_logout` | Clear Tuya authorization |
| `auth/platforms` | Check auth status for all platforms |

## Device Control

> **Parameter naming convention:** Tuya device control tools use `deviceId` (camelCase), not `device_id`.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `get_tuya_device_properties` | `deviceId` (string) | All DP property values |
| `set_tuya_device_property` | `deviceId` (string), `code` (string), `value` (any) | Set result (free trial / licensed) |
| `tuya/refresh` | — | Refresh device list from cloud |

**DP `code` examples** (use `device/specs` to discover available codes per device):
- `switch_1`, `switch_2` — per-channel on/off (boolean)
- `bright_value` — brightness (0–1000)
- `temp_value` — color temperature (0–1000)
- `work_mode` — mode (string)
- `colour_data` — HSV color (JSON string)

**Workflow (steps 2–3 use parent skill tools):**
1. `auth/tuya_qr` → authorize (first time only)
2. `device/list` with `{"platform": "tuya"}` → list devices
3. `device/specs` with `{"deviceId": "xxx"}` → get DP definitions (codes)
4. `set_tuya_device_property` → control (e.g., `code: "switch_1"`, `value: true`)

### Device Control Example

```json
{
  "name": "set_tuya_device_property",
  "arguments": {
    "deviceId": "DEVICE_ID",
    "code": "switch_1",
    "value": true
  }
}
```

## License

`set_tuya_device_property` requires a license. `get_tuya_device_properties` works without license.
Activate via `license/set` tool.
