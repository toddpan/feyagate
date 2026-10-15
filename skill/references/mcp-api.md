# FeyaGate MCP API Documentation

> Examples below show raw HTTP for reference. In practice call MCP tools, or run `npx -y feyagate call <tool> '<json>'`. The engine port may differ from 38080 (see `npx -y feyagate status`).


> **Applicable product**: miloco-mcp-server (desktop virtual gateway)
> **Protocol**: MCP (Model Context Protocol) JSON-RPC 2.0
> **MCP endpoint**: `POST http://<gateway-IP>:38080/mcp/http`
> **Protocol version**: `2025-03-26`

---

## Table of Contents

- [1. Connection Guide](#1-connection-guide)
- [2. JSON-RPC 2.0 Specification](#2-json-rpc-20-specification)
- [3. Protocol Methods](#3-protocol-methods)
- [4. MCP Tools Overview (76)](#4-mcp-tools-overview-76)
- [5. Common Device Tools](#5-common-device-tools)
- [6. 小米 (Xiaomi) Platform](#6-小米-xiaomi-platform)
- [7. 涂鸦 (Tuya) Platform](#7-涂鸦-tuya-platform)
- [8. 美的 (Midea) Platform](#8-美的-midea-platform)
- [9. 易微联 (eWeLink) Platform](#9-易微联-ewelink-platform)
- [10. Xiaoai Speaker Control](#10-xiaoai-speaker-control)
- [11. Xiaozhi Platform](#11-xiaozhi-platform)
- [12. Authentication and Platform Management](#12-authentication-and-platform-management)
- [13. Vision AI](#13-vision-ai)
- [14. Trigger Rules](#14-trigger-rules)
- [15. Scheduled Tasks](#15-scheduled-tasks)
- [16. Skill System](#16-skill-system)
- [17. Configuration Management](#17-configuration-management)
- [18. Statistics](#18-statistics)
- [19. License Key Management](#19-license-key-management)
- [20. Gateway Information](#20-gateway-information)
- [21. Error Codes](#21-error-codes)
- [Appendix: Quick Examples](#appendix-quick-examples)

---

## 1. Connection Guide

All MCP calls are sent to `POST /mcp/http` in JSON-RPC 2.0 format; no prior handshake is required.

```bash
# 初始化
curl -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"MyClient","version":"1.0.0"}}}'

# 列出所有工具
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

> **Stateless**: the server keeps no HTTP session state and returns no `Mcp-Session-Id` header; every request is a stateless call.
>
> **No WebSocket**: the server provides no inbound WebSocket endpoint. The `/mcp` WebSocket path does not exist. The server actively connects to the Xiaozhi platform as a WebSocket **client**, managed through the `xiaozhi/*` tools.

---

## 2. JSON-RPC 2.0 Specification

### Request Structure

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "<工具名>",
    "arguments": { ... }
  }
}
```

### Success Response

The tool return value is wrapped in the MCP content format:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "{\"success\":true,...}" }
    ]
  }
}
```

> The JSON object returned by the tool is serialized into a string placed in `content[0].text`.

### Image Response

When a tool returns a result containing an `images` array (with a `data_url` field), the server automatically extracts the images into standalone MCP image content:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "{\"camera_id\":\"xxx\",\"images\":[...]}" },
      { "type": "image", "data": "<base64>", "mimeType": "image/jpeg" }
    ]
  }
}
```

### Error Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32601, "message": "Tool not found: unknown/tool" }
}
```

### Tool Execution Exception

When a tool handler throws an exception, `isError: true` is returned:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "{\"error\":\"exception message\"}" }
    ],
    "isError": true
  }
}
```

---

## 3. Protocol Methods

| Method | Description |
|--------|-------------|
| `initialize` | MCP protocol handshake |
| `ping` | Keep-alive heartbeat |
| `tools/list` | List all registered tools |
| `tools/call` | Invoke the specified tool |
| `notifications/initialized` | Initialization-complete notification (no response) |

### initialize

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": { "name": "MyClient", "version": "1.0.0" }
  }
}
```

**Response**:
```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": { "tools": {}, "resources": {} },
    "serverInfo": { "name": "miloco-mcp-server", "version": "1.0.0" }
  }
}
```

### ping

```json
{ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": {} }
```

**Response**:
```json
{ "jsonrpc": "2.0", "id": 1, "result": {} }
```

### tools/list

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }
```

**Response**:
```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "tools": [
      {
        "name": "device/list",
        "description": "获取所有已认证平台的设备列表...",
        "inputSchema": { "type": "object", "properties": { ... } }
      }
    ]
  }
}
```

### tools/call

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "tools/call",
  "params": {
    "name": "device/list",
    "arguments": { "filter": ["客厅", "灯"], "platform": "xiaomi" }
  }
}
```

---

## 4. MCP Tools Overview (76)

> **Parameter naming rules**:
> - Device control tools (`device/specs`, `set_*`, `get_*`, `execute_*`) uniformly use `deviceId` (camelCase); only `xiaoai/*` (tts/control/play_music) uses `device_id` (snake_case)
> - Platform-specific tools use `camelCase` (e.g. `deviceId`, `siid`, `piids`)

| # | Tool Name | Category | Required Parameters |
|---|-----------|---------|---------------------|
| 1 | `device/list` | Common Device | — |
| 2 | `device/specs` | Common Device | `deviceId` |
| 3 | `xiaomi/auth_status` | 小米 (Xiaomi) Auth | — |
| 4 | `xiaomi/auth_url` | Xiaomi Auth | — |
| 5 | `xiaomi/auth_callback` | Xiaomi Auth | `code` |
| 6 | `xiaomi/refresh` | Xiaomi Device | — |
| 7 | `xiaomi/get_devices` | Xiaomi Device | — |
| 8 | `xiaomi/get_area_info` | Xiaomi Device | — |
| 9 | `xiaomi/get_device_classes` | Xiaomi Device | — |
| 10 | `get_xiaomi_device_properties` | Xiaomi Control | `deviceId`, `siid`, `piids` |
| 11 | `set_xiaomi_device_property` | Xiaomi Control | `deviceId`, `siid`, `piid`, `value` |
| 12 | `execute_xiaomi_device_action` | Xiaomi Control | `deviceId`, `siid`, `aiid` |
| 13 | `xiaomi/scene_list` | Xiaomi Scene | — |
| 14 | `xiaomi/scene_trigger` | Xiaomi Scene | `sceneId` |
| 15 | `xiaomi/camera_list` | Camera | — |
| 16 | `xiaomi/camera_status` | Camera | — |
| 17 | `xiaomi/camera_connect` | Camera | `camera_id` |
| 18 | `xiaomi/camera_disconnect` | Camera | `camera_id` |
| 19 | `xiaomi/camera_snapshot` | Camera | `camera_id` |
| 20 | `xiaomi/camera_vision_chat` | Vision AI | `camera_id`, `query` |
| 21 | `xiaoai/play_music` | Xiaoai Speaker | `device_id` |
| 22 | `xiaoai/tts` | Xiaoai Speaker | `device_id`, `text` |
| 23 | `xiaoai/control` | Xiaoai Speaker | `device_id`, `command` |
| 24 | `xiaozhi/status` | Xiaozhi Platform | — |
| 25 | `xiaozhi/list` | Xiaozhi Platform | — |
| 26 | `xiaozhi/add` | Xiaozhi Platform | `endpoint` |
| 27 | `xiaozhi/remove` | Xiaozhi Platform | `index` |
| 28 | `xiaozhi/set_endpoint` | Xiaozhi Platform | — |
| 29 | `auth/platforms` | Platform Auth | — |
| 30 | `auth/tuya_qr` | 涂鸦 (Tuya) Auth | `user_code` |
| 31 | `auth/tuya_qr_status` | Tuya Auth | `token`, `user_code` |
| 32 | `auth/tuya_logout` | Tuya Auth | — |
| 33 | `tuya/refresh` | Tuya Device | — |
| 34 | `get_tuya_device_properties` | Tuya Control | `deviceId` |
| 35 | `set_tuya_device_property` | Tuya Control | `deviceId`, `code`, `value` |
| 36 | `auth/midea_login` | 美的 (Midea) Auth | `account`, `password` |
| 37 | `auth/midea_logout` | Midea Auth | — |
| 38 | `midea/refresh` | Midea Device | — |
| 39 | `get_midea_device_properties` | Midea Control | `deviceId` |
| 40 | `set_midea_device_property` | Midea Control | `deviceId`, `property`, `value` |
| 41 | `auth/ewelink_login` | 易微联 (eWeLink) Auth | `email`, `password` |
| 42 | `auth/ewelink_logout` | eWeLink Auth | — |
| 43 | `ewelink/refresh` | eWeLink Device | — |
| 44 | `get_ewelink_device_properties` | eWeLink Control | `deviceId` |
| 45 | `set_ewelink_device_property` | eWeLink Control | `deviceId`, `property`, `value` |
| 46 | `trigger/create` | Trigger Rule | `name`, `cameras`, `condition` |
| 47 | `trigger/list` | Trigger Rule | — |
| 48 | `trigger/update` | Trigger Rule | `id` |
| 49 | `trigger/delete` | Trigger Rule | `id` |
| 50 | `trigger/toggle` | Trigger Rule | `id`, `enabled` |
| 51 | `trigger/logs` | Trigger Rule | — |
| 52 | `schedule/add` | Scheduled Task | `name`, `scheduled_time`, `tool_name`, `tool_args` |
| 53 | `schedule/list` | Scheduled Task | — |
| 54 | `schedule/get` | Scheduled Task | `id` |
| 55 | `schedule/update` | Scheduled Task | `id` |
| 56 | `schedule/delete` | Scheduled Task | `id` |
| 57 | `schedule/cancel` | Scheduled Task | `id` |
| 58 | `skill/list` | Skill System | — |
| 59 | `skill/read` | Skill System | `name` |
| 60 | `skill/create` | Skill System | `name`, `content` |
| 61 | `skill/update` | Skill System | `name`, `content` |
| 62 | `skill/delete` | Skill System | `name` |
| 63 | `skill/context` | Skill System | — |
| 64 | `skill/reload` | Skill System | — |
| 65 | `config/get_vision` | Configuration | — |
| 66 | `config/set_vision` | Configuration | — |
| 67 | `config/get_trigger` | Configuration | — |
| 68 | `config/set_trigger` | Configuration | — |
| 69 | `stats/token_usage` | Statistics | — |
| 70 | `stats/token_records` | Statistics | — |
| 71 | `stats/trigger_summary` | Statistics | — |
| 72 | `stats/dashboard` | Statistics | — |
| 73 | `license/status` | License | — |
| 74 | `license/set` | License | `license_key` |
| 75 | `license/clear` | License | — |
| 76 | `gateway/info` | Gateway Info | — |

---

## 5. Common Device Tools

### `device/list`

Get the device list of all authenticated platforms (米家 (Mi Home) / 涂鸦 (Tuya) / 美的 (Midea) / 易微联 (eWeLink)), with keyword and platform filtering.

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `platform` | `string` | ❌ | Platform filter: `xiaomi` / `tuya` / `midea` / `ewelink` |
| `filter` | `string[]` | ❌ | Keyword filter array, matching device name, model, room name, and home name |

**Response example**:
```json
{
  "total": 24,
  "devices": [
    {
      "id": "102838844",
      "name": "客厅灯",
      "model": "yeelink.light.lamp22",
      "platform": "xiaomi",
      "online": true,
      "category": "light",
      "home_name": "我的家",
      "room_name": "客厅"
    }
  ]
}
```

```bash
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"device/list","arguments":{"filter":["客厅","灯"],"platform":"xiaomi"}}}'
```

### `device/specs`

Get the functional specification definition of a device (unified across platforms). The system automatically identifies which platform the device belongs to and routes the request, returning the property list, action definitions, and parameter formats.

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | Device ID |

**Response example**:
```json
{
  "success": true,
  "properties": [...],
  "actions": [...]
}
```

---

## 6. 小米 (Xiaomi) Platform

**Control flow**: `device/list` → `device/specs` (obtain siid/piid/aiid) → `set_xiaomi_device_property` or `execute_xiaomi_device_action`

### 6.1 Authentication

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `xiaomi/auth_status` | Check the Mi Home (米家) OAuth authorization status and remaining token lifetime | — |
| `xiaomi/auth_url` | Get the Mi Home OAuth authorization URL | — |
| `xiaomi/auth_callback` | Process the Mi Home OAuth authorization callback code | `code` |

**`xiaomi/auth_status` response**:
```json
{
  "authorized": true,
  "remaining_seconds": 86400,
  "cloud_server": "cn"
}
```

**`xiaomi/auth_url` response**:
```json
{
  "url": "https://account.xiaomi.com/oauth2/authorize?...",
  "message": "请在浏览器中打开此 URL 完成米家账号授权。"
}
```

**`xiaomi/auth_callback` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `code` | `string` | ✅ | OAuth authorization code |

**Mi Home (米家) OAuth flow**:

```bash
# 1. 获取授权 URL
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xiaomi/auth_url","arguments":{}}}'

# 2. 用户在浏览器打开 URL 完成授权，从回调 URL 获取 code

# 3. 提交 code
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"xiaomi/auth_callback","arguments":{"code":"CALLBACK_CODE"}}}'
```

### 6.2 Device Query

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `xiaomi/refresh` | Re-pull the Mi Home device list from the cloud | — |
| `xiaomi/get_devices` | Get the Xiaomi device list, with filtering by area and category | — |
| `xiaomi/get_area_info` | Get the Xiaomi Smart Home room/area list | — |
| `xiaomi/get_device_classes` | Get the list of Xiaomi device categories currently imported | — |

**`xiaomi/refresh` response**:
```json
{
  "success": true,
  "device_count": 42,
  "camera_count": 3
}
```

**`xiaomi/get_devices` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `area_id` | `string` | ❌ | Area ID, obtained from `xiaomi/get_area_info` |
| `device_class` | `string` | ❌ | Device category, e.g. `light`, `switch`, `curtain` |

**`xiaomi/get_devices` response**:
```json
{
  "devices": [
    {
      "did": "102838844",
      "name": "客厅灯",
      "online": true,
      "home_info": "客厅",
      "device_class": "light",
      "model": "yeelink.light.lamp22"
    }
  ],
  "count": 1
}
```

### 6.3 Property Read/Write

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `get_xiaomi_device_properties` | Get the current values of a Xiaomi device's properties | `deviceId`, `siid`, `piids` |
| `set_xiaomi_device_property` | Set a Xiaomi device property value | `deviceId`, `siid`, `piid`, `value` |
| `execute_xiaomi_device_action` | Execute a Xiaomi device action | `deviceId`, `siid`, `aiid` |

**`get_xiaomi_device_properties` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | Device ID (did) |
| `siid` | `integer` | ✅ | Service ID |
| `piids` | `integer[]` | ✅ | Property ID list, e.g. `[1, 2]` |

**`set_xiaomi_device_property` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | Device ID |
| `siid` | `integer` | ✅ | Service ID |
| `piid` | `integer` | ✅ | Property ID |
| `value` | `any` | ✅ | Property value (boolean/number/string) |

**Response**: `{"success": true, "data": {...}}`

**`execute_xiaomi_device_action` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | Device ID |
| `siid` | `integer` | ✅ | Service ID |
| `aiid` | `integer` | ✅ | Action ID |
| `params` | `array` | ❌ | Action parameter list |

**Example — turn on the light**:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "set_xiaomi_device_property",
    "arguments": { "deviceId": "YOUR_DID", "siid": 2, "piid": 1, "value": true }
  }
}
```

### 6.4 Scenes

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `xiaomi/scene_list` | Get the list of Xiaomi manual scenes, returning sceneId and name | — |
| `xiaomi/scene_trigger` | Trigger execution of a Xiaomi manual scene | `sceneId` |

**`xiaomi/scene_trigger` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `sceneId` | `string` | ✅ | Scene ID, obtained from `xiaomi/scene_list` |

### 6.5 Camera

> Only macOS and Linux are supported. The Windows build returns `{"error": "当前平台不支持摄像头功能"}`.

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `xiaomi/camera_list` | Get all discovered Mi Home cameras | — |
| `xiaomi/camera_status` | Get the camera stream connection status | — |
| `xiaomi/camera_connect` | Connect a camera and start receiving the video stream | `camera_id` |
| `xiaomi/camera_disconnect` | Stop the stream and disconnect | `camera_id` |
| `xiaomi/camera_snapshot` | Capture a JPEG snapshot from the camera | `camera_id` |

**`xiaomi/camera_list` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `filter` | `string[]` | ❌ | Keyword filter array (matches name/model/room) |

**`xiaomi/camera_list` response**:
```json
{
  "cameras": [
    {
      "did": "102838844",
      "name": "客厅摄像头",
      "model": "chuangmi.camera.ipc019",
      "home": "我的家",
      "room": "客厅",
      "online": true,
      "channel_count": 1,
      "camera_status": "connected"
    }
  ],
  "count": 1
}
```

**`xiaomi/camera_status` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `camera_id` | `string` | ❌ | Camera DID; when omitted, returns the status of all connected cameras |

**`xiaomi/camera_status` response** (with camera_id specified):
```json
{
  "did": "102838844",
  "camera_id": "102838844",
  "status": "connected",
  "buffered_frames": 5
}
```

**`xiaomi/camera_connect` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `camera_id` | `string` | ✅ | Camera device ID |

**`xiaomi/camera_connect` response**:
```json
{
  "camera_id": "102838844",
  "success": true,
  "status": "connected",
  "message": "Camera connected, streaming started"
}
```

> Connecting is asynchronous: the server polls the connection status for up to 3 seconds. On timeout it returns `"Connection initiated, current status: connecting. Status will update via polling."`.

**`xiaomi/camera_disconnect` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `camera_id` | `string` | ✅ | Camera device ID |

**`xiaomi/camera_snapshot` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `camera_id` | `string` | ✅ | Camera device ID |
| `channel` | `integer` | ❌ | Channel number, default `0` |
| `count` | `integer` | ❌ | Number of snapshot frames, default `1`, max `10` |
| `use_subprocess` | `boolean` | ❌ | Force subprocess mode (process isolation to prevent hangs), default `false` |

**`xiaomi/camera_snapshot` response** (buffered mode):
```json
{
  "camera_id": "102838844",
  "channel": 0,
  "images": [
    {
      "data_url": "data:image/jpeg;base64,/9j/4AAQ...",
      "timestamp": 1716518400000,
      "size_bytes": 45678
    }
  ],
  "count": 1,
  "mode": "buffered"
}
```

**`xiaomi/camera_snapshot` response** (subprocess mode):
```json
{
  "camera_id": "102838844",
  "channel": 0,
  "images": [
    {
      "data_url": "data:image/jpeg;base64,/9j/4AAQ...",
      "timestamp": 1716518400000,
      "size_bytes": 45678
    }
  ],
  "count": 1,
  "mode": "subprocess"
}
```

> **Mode notes**: by default it reads from the connected frame buffer first; if the buffer is empty or `use_subprocess=true` is specified, it launches a separate subprocess that connects to the camera and captures the snapshot, so that a hang in the native library cannot affect the main service.

**Camera usage flow**:

```bash
# 1. 查找摄像头
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xiaomi/camera_list","arguments":{}}}'

# 2. 连接摄像头（建立 P2P 流）
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"xiaomi/camera_connect","arguments":{"camera_id":"CAMERA_DID"}}}'

# 3. 等待 3-5 秒后截图
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"xiaomi/camera_snapshot","arguments":{"camera_id":"CAMERA_DID","count":1}}}'

# 4. 断开连接
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"xiaomi/camera_disconnect","arguments":{"camera_id":"CAMERA_DID"}}}'
```

---

## 7. 涂鸦 (Tuya) Platform

> Setting a device property (`set_tuya_device_property`) requires the platform account to be authorized and logged in (available within the free edition's 90-day trial; a licensed edition is required once it expires).

### Authorization (QR code scan)

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `auth/tuya_qr` | Get the Tuya QR code authorization, returning qr_url and token | `user_code` |
| `auth/tuya_qr_status` | Query the QR code scan authorization status | `token`, `user_code` |
| `auth/tuya_logout` | Log out of the Tuya platform authorization | — |
| `tuya/refresh` | Refresh the Tuya device list (call after authorization) | — |

**QR code authorization flow**:

1. In the 涂鸦智能 (Smart Life) app, obtain the user code: **My → Settings → Account and Security**
2. Call `auth/tuya_qr` with `user_code` to obtain `qr_url` and `token` (valid for 5 minutes)
3. Turn `qr_url` into a QR code, scan it with the Tuya app, and confirm
4. Poll `auth/tuya_qr_status`; a result of `"status": "success"` means the authorization succeeded
5. Call `tuya/refresh` to sync the devices

**`auth/tuya_qr` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `user_code` | `string` | ✅ | User code from the Tuya app |

**`auth/tuya_qr_status` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `token` | `string` | ✅ | The token returned by `auth/tuya_qr` |
| `user_code` | `string` | ✅ | Tuya user code |

**`tuya/refresh` response**:
```json
{
  "success": true,
  "device_count": 12
}
```

### Device Control

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `get_tuya_device_properties` | Get all DP property values of a Tuya device | `deviceId` |
| `set_tuya_device_property` | Set a Tuya device DP property value (requires authorization) | `deviceId`, `code`, `value` |

**`get_tuya_device_properties` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | Tuya device ID |

**`set_tuya_device_property` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | Tuya device ID |
| `code` | `string` | ✅ | DP function point code (e.g. `switch_1`, `bright_value`) |
| `value` | `any` | ✅ | Property value (boolean/number/string) |

**`set_tuya_device_property` response**:
```json
{
  "success": true,
  "message": "...",
  "data": { ... }
}
```

---

## 8. 美的 (Midea) Platform

> Setting a device property (`set_midea_device_property`) requires the platform account to be authorized and logged in (available within the free edition's 90-day trial; a licensed edition is required once it expires).

### Authorization (account and password)

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `auth/midea_login` | Midea account/password login (美居 (Midea Smart Home) / MSmartHome) | `account`, `password` |
| `auth/midea_logout` | Log out of the Midea platform authorization | — |
| `midea/refresh` | Refresh the Midea device list | — |

**`auth/midea_login` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `account` | `string` | ✅ | Mobile number or email address |
| `password` | `string` | ✅ | Account password |
| `cloud` | `string` | ❌ | Cloud type: `meiju` (Midea Smart Home, default) or `msmart` (MSmartHome) |

**`auth/midea_login` response**:
```json
{
  "success": true,
  "device_count": 8,
  "auth_status": { ... }
}
```

**`midea/refresh` response**:
```json
{
  "success": true,
  "device_count": 8
}
```

### Device Control

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `get_midea_device_properties` | Get all property values of a Midea device | `deviceId` |
| `set_midea_device_property` | Set a Midea device property value (requires authorization) | `deviceId`, `property`, `value` |

**`get_midea_device_properties` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | Midea device ID (applianceCode) |

**`set_midea_device_property` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | Midea device ID (applianceCode) |
| `property` | `string` | ✅ | Property name (e.g. `power`, `temperature`, `mode`, `fan_speed`) |
| `value` | `any` | ✅ | Property value |

**`set_midea_device_property` response**:
```json
{
  "success": true,
  "message": "...",
  "data": { ... }
}
```

**Common property values**:
- `power`: `0` / `1` (off/on)
- `temperature`: integer (e.g. `26`)
- `mode`: `cool` / `heat` / `auto`
- `fan_speed`: `low` / `medium` / `high`

---

## 9. 易微联 (eWeLink) Platform

> Setting a device property (`set_ewelink_device_property`) requires the platform account to be authorized and logged in (available within the free edition's 90-day trial; a licensed edition is required once it expires).

### Authorization (account and password)

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `auth/ewelink_login` | eWeLink account/password login | `email`, `password` |
| `auth/ewelink_logout` | Log out of the eWeLink platform authorization | — |
| `ewelink/refresh` | Refresh the eWeLink device list | — |

**`auth/ewelink_login` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `email` | `string` | ✅ | Email address or mobile number |
| `password` | `string` | ✅ | Account password |
| `country_code` | `string` | ❌ | Country code, default `+86` |

**`auth/ewelink_login` response**:
```json
{
  "success": true,
  "device_count": 5,
  "auth_status": { ... }
}
```

### Device Control

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `get_ewelink_device_properties` | Get all property values of an eWeLink device | `deviceId` |
| `set_ewelink_device_property` | Set an eWeLink device property value (requires authorization) | `deviceId`, `property`, `value` |

**`set_ewelink_device_property` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `deviceId` | `string` | ✅ | eWeLink device ID |
| `property` | `string` | ✅ | Property name (e.g. `switch`, `switches`) |
| `value` | `any` | ✅ | Property value (boolean/string/array) |

**Common properties**:
- `switch`: `on` / `off`
- `switches`: JSON array, e.g. `[{"switch": "on", "outlet": 0}]` (multi-channel switch)

---

## 10. Xiaoai Speaker Control

> Before use, obtain the speaker's `device_id` via `device/list` (the model starts with `xiaomi.wifispeaker`).

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `xiaoai/play_music` | Control a Xiaoai speaker to play music/stories or adjust the volume | `device_id` |
| `xiaoai/tts` | Read text aloud through the Xiaoai speaker (TTS speech broadcast) | `device_id`, `text` |
| `xiaoai/control` | Indirectly control devices via Xiaoai speaker voice commands | `device_id`, `command` |

**`xiaoai/play_music` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `device_id` | `string` | ✅ | Speaker device ID |
| `text` | `string` | ⚠️ | Natural-language instruction (e.g. "播放刘德华的歌" = play a Andy Lau song, "讲个笑话" = tell a joke, "音量调到50" = set the volume to 50) |
| `command` | `string` | ⚠️ | An alias for `text`; the two are equivalent. At least one of `text` and `command` must be passed |

**`xiaoai/tts` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `device_id` | `string` | ✅ | Speaker device ID |
| `text` | `string` | ✅ | Text content to broadcast |

**`xiaoai/control` parameters**:

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `device_id` | `string` | ✅ | Speaker device ID |
| `command` | `string` | ✅ | Voice command (e.g. "打开客厅灯" = turn on the living room light, "调高空调温度" = raise the air conditioner temperature) |
| `silence` | `boolean` | ❌ | Execute silently (the speaker gives no spoken reply), default `true` |

---

## 11. Xiaozhi Platform

FeyaGate supports multiple parallel Xiaozhi AI WebSocket connections.

### `xiaozhi/status`

Get the connection status of all Xiaozhi platform endpoints.

**Parameters**: none

**Response example**:
```json
{
  "state": "connected",
  "endpoint": "wss://xxx",
  "connected": true,
  "initialized": true,
  "bridged_tools": 42,
  "enabled": true,
  "clients": [
    {
      "index": 0,
      "endpoint": "wss://xxx",
      "state": "connected",
      "connected": true,
      "initialized": true,
      "bridged_tools": 42
    }
  ],
  "count": 1,
  "max_count": 10
}
```

### `xiaozhi/list`

List all configured Xiaozhi connection endpoints and their status.

**Parameters**: none

### `xiaozhi/add`

Add a new Xiaozhi platform WebSocket connection.

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `endpoint` | `string` | ✅ | WebSocket URL (`ws://` or `wss://`) |

**Response example**:
```json
{
  "success": true,
  "endpoint": "wss://xxx",
  "index": 0,
  "count": 1
}
```

### `xiaozhi/remove`

Delete the Xiaozhi connection at the specified index.

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `index` | `integer` | ✅ | Connection index (obtained from `xiaozhi/list`) |

### `xiaozhi/set_endpoint`

Set the first Xiaozhi endpoint (backward-compatible interface).

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `endpoint` | `string` | ❌ | WebSocket URL; leave empty to disable and delete it |

---

## 12. Authentication and Platform Management

### `auth/platforms`

List all registered smart home platforms and their authentication status.

**Parameters**: none

**Response example**:
```json
[
  { "platform_id": "xiaomi", "platform_name": "米家", "authenticated": true, "auth_status": { "authorized": true, "cloud_server": "cn", "token_remaining_seconds": 233266 } },
  { "platform_id": "tuya", "platform_name": "涂鸦", "authenticated": false, "auth_status": { "authenticated": false } },
  { "platform_id": "midea", "platform_name": "美的", "authenticated": false, "auth_status": { "authenticated": false } },
  { "platform_id": "ewelink", "platform_name": "易微联", "authenticated": false, "auth_status": { "authenticated": false } }
]
```

---

## 13. Vision AI

### `xiaomi/camera_vision_chat`

Ask Vision AI a question about the camera feed. Sends the camera's most recent frames together with the user's question to the LLM and returns the AI analysis result.

> You must first configure `vision.enabled=true` and `api_key` in `config.yaml`.

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `camera_id` | `string` | ✅ | Camera device DID |
| `query` | `string` | ✅ | The question asked of the AI (e.g. "How many people are there right now?") |
| `channel` | `integer` | ❌ | Camera channel, default `0` |
| `count` | `integer` | ❌ | Number of most recent frames to send, default `3`, max `10` |

**Response example**:
```json
{
  "camera_id": "102838844",
  "camera_name": "客厅摄像头",
  "channel": 0,
  "images_used": 3,
  "model": "configured",
  "content": "画面中有2个人，正在客厅看电视...",
  "tokens": {
    "prompt": 1500,
    "completion": 200
  }
}
```

---

## 14. Trigger Rules

The trigger engine monitors camera feeds and automatically executes smart home actions when a condition described in natural language is met.

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `trigger/create` | Create a camera trigger rule | `name`, `cameras`, `condition` |
| `trigger/list` | List all trigger rules | — |
| `trigger/update` | Update a trigger rule | `id` |
| `trigger/delete` | Delete a trigger rule | `id` |
| `trigger/toggle` | Enable or disable a trigger rule | `id`, `enabled` |
| `trigger/logs` | View the execution log of trigger rules | — |

### `trigger/create`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | ✅ | Rule name |
| `cameras` | `string[]` | ✅ | List of associated camera DIDs |
| `condition` | `string` | ✅ | Natural-language trigger condition (e.g. "someone enters the living room") |
| `actions` | `array` | ❌ | List of actions to execute when triggered |
| `notify` | `object` | ❌ | Notification configuration `{title, body}` |
| `filter` | `object` | ❌ | Filter `{interval, period}` |

**Response example**:
```json
{
  "id": "rule_001",
  "message": "触发规则已创建",
  "rule": { ... }
}
```

### `trigger/update`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `id` | `string` | ✅ | Rule ID |
| `name` | `string` | ❌ | New name |
| `cameras` | `string[]` | ❌ | New camera list |
| `condition` | `string` | ❌ | New trigger condition |
| `actions` | `array` | ❌ | New action list |
| `notify` | `object` | ❌ | New notification configuration |
| `filter` | `object` | ❌ | New filter |
| `enabled` | `boolean` | ❌ | Enable/disable |

### `trigger/toggle`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `id` | `string` | ✅ | Rule ID |
| `enabled` | `boolean` | ✅ | `true` enables, `false` disables |

### `trigger/logs`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `limit` | `integer` | ❌ | Maximum number of entries returned, default `50` |
| `rule_id` | `string` | ❌ | Filter by rule ID |

---

## 15. Scheduled Tasks

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `schedule/add` | Create a scheduled task that automatically runs a given MCP tool when its time arrives | `name`, `scheduled_time`, `tool_name`, `tool_args` |
| `schedule/list` | List scheduled tasks, optionally filtered by status | — |
| `schedule/get` | Get the details of a scheduled task | `id` |
| `schedule/update` | Modify a task (only tasks in the pending state can be modified) | `id` |
| `schedule/delete` | Delete a scheduled task | `id` |
| `schedule/cancel` | Cancel a task that has not run yet (the record is kept and its state becomes cancelled) | `id` |

### `schedule/add`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | ✅ | Task name |
| `scheduled_time` | `string` | ✅ | Execution time in ISO 8601 format (e.g. `2026-05-24T22:00:00+08:00`) |
| `tool_name` | `string` | ✅ | Name of the MCP tool to execute (e.g. `set_xiaomi_device_property`) |
| `tool_args` | `string` | ✅ | Tool arguments as a JSON string |
| `repeat` | `string` | ❌ | Repeat type: `none` / `daily` / `weekdays` / `weekends` / `weekly` / `custom` |
| `repeat_days` | `string` | ❌ | Custom repeat days as a JSON array string, e.g. `"[1,2,3,4,5]"` (0 = Sunday) |

**Example — turn the lights off at 10 p.m. every day**:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "schedule/add",
    "arguments": {
      "name": "晚上关灯",
      "scheduled_time": "2026-05-24T22:00:00+08:00",
      "tool_name": "set_xiaomi_device_property",
      "tool_args": "{\"deviceId\":\"YOUR_DID\",\"siid\":2,\"piid\":1,\"value\":false}",
      "repeat": "daily"
    }
  }
}
```

### `schedule/list`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `status` | `string` | ❌ | Status filter: `pending` / `completed` / `cancelled`; leave empty to return all |

### `schedule/get` / `schedule/delete` / `schedule/cancel`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `id` | `integer` | ✅ | Task ID (integer) |

### `schedule/update`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `id` | `integer` | ✅ | Task ID (integer) |
| `scheduled_time` | `string` | ❌ | New execution time in ISO 8601 |
| `repeat` | `string` | ❌ | New repeat type |
| `repeat_days` | `string` | ❌ | Custom repeat days as a JSON array string |

---

## 16. Skill System

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `skill/list` | List all skills, optionally filtered by source | — |
| `skill/read` | Read the full content of a given skill (including frontmatter) | `name` |
| `skill/create` | Create a new custom skill | `name`, `content` |
| `skill/update` | Update the content of an existing custom skill | `name`, `content` |
| `skill/delete` | Delete a given custom skill (built-in skills cannot be deleted) | `name` |
| `skill/context` | Get the context content and summaries of all always-on skills | — |
| `skill/reload` | Rescan the skill directory and refresh the cache | — |

### `skill/list`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `source` | `string` | ❌ | Source filter: `all` (default) / `builtin` / `user` |

**Response example**:
```json
{
  "skills": [
    {
      "name": "smart_light",
      "description": "智能灯光控制技能",
      "source": "builtin",
      "always": false,
      "tags": ["light", "control"],
      "path": "/path/to/skill.md"
    }
  ],
  "count": 1
}
```

### `skill/read`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | ✅ | Skill name |

**Response example**:
```json
{
  "name": "smart_light",
  "description": "智能灯光控制技能",
  "source": "builtin",
  "always": false,
  "tags": ["light"],
  "path": "/path/to/skill.md",
  "content": "---\nname: smart_light\n---\n# 技能正文",
  "body": "# 技能正文"
}
```

### `skill/create` / `skill/update`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | ✅ | Skill name (letters, digits, and hyphens) |
| `content` | `string` | ✅ | Skill content (Markdown + YAML frontmatter format) |

### `skill/delete`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | ✅ | Skill name (built-in skills cannot be deleted) |

### `skill/context`

**Parameters**: none

**Response example**:
```json
{
  "context": "...",
  "skill_count": 5
}
```

### `skill/reload`

**Parameters**: none

**Response example**:
```json
{
  "success": true,
  "skill_count": 5
}
```

---

## 17. Configuration Management

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `config/get_vision` | Get the current Vision AI configuration (the API Key is shown masked) | — |
| `config/set_vision` | Update the Vision AI configuration and save it to `config.yaml`; changes take effect immediately | — |
| `config/get_trigger` | Get the current trigger engine configuration | — |
| `config/set_trigger` | Update the trigger engine configuration and save it to `config.yaml`; changes take effect immediately | — |

### `config/get_vision`

**Response example**:
```json
{
  "enabled": true,
  "api_key_masked": "sk-x****1234",
  "has_api_key": true,
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4o",
  "temperature": 0.7,
  "max_tokens": 4096,
  "timeout_seconds": 30
}
```

### `config/set_vision`

All parameters are optional; pass only the fields you want to change.

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `enabled` | `boolean` | ❌ | Whether Vision AI is enabled |
| `api_key` | `string` | ❌ | Vision AI API key |
| `base_url` | `string` | ❌ | OpenAI-compatible API endpoint |
| `model` | `string` | ❌ | Model name |
| `temperature` | `number` | ❌ | Temperature parameter (0-2) |
| `max_tokens` | `integer` | ❌ | Maximum number of response tokens |
| `timeout_seconds` | `integer` | ❌ | HTTP timeout in seconds |

**Response example**:
```json
{
  "success": true,
  "config_saved": true,
  "message": "Vision AI 配置已保存并生效",
  "enabled": true,
  "api_key_masked": "sk-x****1234",
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4o",
  "temperature": 0.7,
  "max_tokens": 4096,
  "timeout_seconds": 30
}
```

### `config/get_trigger`

**Response example**:
```json
{
  "enabled": true,
  "interval_seconds": 30,
  "vision_img_count": 3,
  "motion_threshold": 10,
  "log_ttl_days": 30,
  "min_trigger_interval": 300
}
```

### `config/set_trigger`

All parameters are optional; pass only the fields you want to change. Enabling/disabling automatically starts or stops the engine.

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `enabled` | `boolean` | ❌ | Whether the trigger engine is enabled |
| `interval_seconds` | `integer` | ❌ | Rule check interval (seconds) |
| `vision_img_count` | `integer` | ❌ | Number of frames used per LLM call |
| `motion_threshold` | `integer` | ❌ | dHash motion detection threshold |
| `log_ttl_days` | `integer` | ❌ | Number of days logs are kept |
| `min_trigger_interval` | `integer` | ❌ | Minimum trigger interval for a single rule (seconds, debounce) |

---

## 18. Statistics

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `stats/token_usage` | Get token consumption statistics (by day / by model / by source / overall) | — |
| `stats/token_records` | Get recent LLM API call records | — |
| `stats/trigger_summary` | Get aggregated trigger event statistics (daily trend, rule ranking, camera distribution, heatmap) | — |
| `stats/dashboard` | Get the overall dashboard summary (system status, today's overview) | — |

### `stats/token_usage`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `days` | `integer` | ❌ | Number of recent days to include in the statistics, default `30` |

**Response example**:
```json
{
  "summary": { "total_tokens": 150000, "total_calls": 300 },
  "daily": [ {"date": "2026-05-20", "tokens": 5000, "calls": 10} ],
  "by_model": [ {"model": "gpt-4o", "tokens": 100000} ],
  "by_source": [ {"source": "vision", "tokens": 80000} ]
}
```

### `stats/token_records`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `limit` | `integer` | ❌ | Number of records returned, default `50` |

**Response example**:
```json
{
  "records": [ ... ]
}
```

### `stats/trigger_summary`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `days` | `integer` | ❌ | Number of recent days to include in the statistics, default `30` |

**Response example**:
```json
{
  "overview": {
    "today": 5,
    "this_week": 32,
    "total": 150,
    "enabled_rules": 3,
    "total_rules": 5
  },
  "daily": [ {"date": "2026-05-20", "count": 8} ],
  "by_rule": [ {"rule_id": "rule_001", "rule_name": "有人进入", "count": 20} ],
  "by_camera": [ {"camera_id": "102838844", "count": 45} ],
  "heatmap": [ {"weekday": "Mon", "weekday_idx": 0, "hour": 9, "count": 3} ]
}
```

### `stats/dashboard`

**Parameters**: none

**Response example**:
```json
{
  "trigger_engine": {
    "enabled": true,
    "enabled_rules": 3,
    "total_rules": 5
  },
  "today": {
    "ai_calls": 42,
    "triggers": 5,
    "actions_executed": 8,
    "tokens_used": 12000
  },
  "token_summary": { ... },
  "action_ranking": [ {"action": "turn_off_light", "count": 3} ],
  "recent_events": [
    {"time": "2026-05-24T10:30:00", "rule_name": "有人进入", "camera_id": "xxx"}
  ]
}
```

---

## 19. License Key Management

FeyaGate free edition: 米家 (Mi Home) is permanently available, while 涂鸦 (Tuya) / 美的 (Midea) / 易微联 (eWeLink) each get a 90-day free trial (usable within the trial period; a licensed edition is required to unlock them once it ends); the licensed edition unlocks all platforms with no time limit and enables Vision/Trigger.

| Tool Name | Description | Required Parameters |
|-----------|-------------|---------------------|
| `license/status` | Get the virtual gateway license status | — |
| `license/set` | Write the license key and trigger cloud activation | `license_key` |
| `license/clear` | Clear the license key and revert to the free edition | — |

### `license/status`

**Response example** (licensed):
```json
{
  "edition": "licensed",
  "status": "active",
  "product": "feyagate-linux",
  "device_id": "xxx",
  "key_masked": "FG-xxxx-****-xxxx"
}
```

**Response example** (free edition):
```json
{
  "edition": "free",
  "status": "inactive",
  "product": "feyagate-linux",
  "device_id": "xxx",
  "key_masked": "",
  "guidance": {
    "message": "当前为免费版：米家永久可用，涂鸦/美的/易微联 90 天免费试用。试用期满或需解锁全部功能请获取授权版。",
    "how_to_authorize": "1. 联系代理商购买授权版虚拟网关\n2. 获取授权码 (格式: FG-XXXX-XXXX-XXXX)\n3. 使用 license/set 工具写入授权码\n4. 系统自动向云端激活",
    "free_features": "米家平台(永久)、涂鸦/美的/易微联(90天试用)、设备控制、摄像头、小爱音箱、MCP代理、小智AI",
    "licensed_features": "以上全部 + 涂鸦/美的/易微联无时限 + Vision/Trigger"
  }
}
```

### `license/set`

| Parameter | Type | Required | Description |
|--------|------|----------|-------------|
| `license_key` | `string` | ✅ | License key, format `FG-XXXX-XXXX-XXXX` |
| `product` | `string` | ❌ | Product identifier; by default the value from the configuration file is used |

**Response example**:
```json
{
  "edition": "licensed",
  "status": "active",
  "activated": true,
  "message": "授权成功! 全平台功能已解锁。"
}
```

> The license key is bound to a device: one key per machine, and it cannot be transferred after activation.

### `license/clear`

**Response example**:
```json
{
  "edition": "free",
  "status": "inactive",
  "message": "授权已清除，已恢复为免费版 (米家永久可用，涂鸦/美的/易微联回到 90 天试用)。"
}
```

---

## 20. Gateway Information

### `gateway/info`

Get virtual gateway information, including version, platforms, device ID, and license status.

**Parameters**: none

```bash
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gateway/info","arguments":{}}}'
```

---

## 21. Error Codes

### JSON-RPC Protocol Errors

| Error Code | Meaning |
|------------|---------|
| `-32700` | Parse error (Invalid JSON) |
| `-32600` | Invalid request (not JSON-RPC 2.0) |
| `-32601` | Method not found |
| `-32602` | Invalid params (missing `params.name` or the tool does not exist) |
| `-32603` | Internal server error |

### Tool Business Errors

The JSON returned by a tool may contain the following errors:

| Field | Description |
|-------|-------------|
| `{"error": "..."}` | Generic business error |
| `{"success": false, "error": "license_required"}` | A device license is required (set operations on 涂鸦 (Tuya) / 美的 (Midea) / 易微联 (eWeLink) devices) |
| `{"error": "当前平台不支持摄像头功能"}` | The camera feature is not supported on the Windows platform |

---

## Appendix: Quick Examples

### Find and Control the Living Room Light

```bash
# 1. 查找设备
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"device/list","arguments":{"filter":["客厅","灯"]}}}'

# 2. 查询设备规格
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"device/specs","arguments":{"deviceId":"YOUR_DID"}}}'

# 3. 开灯
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"set_xiaomi_device_property","arguments":{"deviceId":"YOUR_DID","siid":2,"piid":1,"value":true}}}'
```

### Check the Authorization Status of Each Platform

```bash
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"auth/platforms","arguments":{}}}'
```

### Create a Trigger Rule (Turn the Light On When Someone Enters)

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "trigger/create",
    "arguments": {
      "name": "玄关感应开灯",
      "cameras": ["CAMERA_DID"],
      "condition": "有人进入玄关",
      "actions": [
        {
          "tool": "set_xiaomi_device_property",
          "args": { "deviceId": "LIGHT_DID", "siid": 2, "piid": 1, "value": true }
        }
      ]
    }
  }
}
```
