# FeyaGate HTTP API Documentation

> **Applicable products**: miloco-mcp-server (desktop virtual gateway / ESP32 physical gateway)
> **Base URL**: `http://<gateway-IP>:<port>` (desktop default `38080`)
> **Protocol**: HTTP REST + MCP JSON-RPC 2.0
> **CORS**: open globally, `Access-Control-Allow-Origin: *`

---

## Table of Contents

- [1. Overview](#1-overview)
- [2. HTTP REST Endpoints](#2-http-rest-endpoints)
  - [2.1 Health Check](#21-health-check)
  - [2.2 OAuth Authorization Callback](#22-oauth-authorization-callback)
  - [2.3 Gateway Info](#23-gateway-info)
  - [2.4 License Management](#24-license-management)
- [3. MCP JSON-RPC Endpoints](#3-mcp-json-rpc-endpoints)
  - [3.1 Protocol Description](#31-protocol-description)
  - [3.2 Protocol Methods](#32-protocol-methods)
- [4. 米家 (Mi Home) Platform](#4-米家-mi-home-platform)
- [5. 小爱音箱 (Xiaoai Speaker)](#5-小爱音箱-xiaoai-speaker)
- [6. 小智 (Xiaozhi) Platform](#6-小智-xiaozhi-platform)
- [7. License and Gateway](#7-license-and-gateway)
- [8. Vision AI](#8-vision-ai)
- [9. Trigger Rules](#9-trigger-rules)
- [10. Configuration Management](#10-configuration-management)
- [11. Statistics](#11-statistics)
- [12. Multi-platform Devices](#12-multi-platform-devices)
- [13. Scheduled Tasks](#13-scheduled-tasks)
- [14. Skill Management](#14-skill-management)

---

## 1. Overview

The FeyaGate gateway provides two kinds of HTTP endpoints:

1. **HTTP REST endpoints** — standard GET/POST/DELETE endpoints, used mainly for health checks, the OAuth authorization callback, gateway info, and license management.
2. **MCP JSON-RPC endpoints** — all core features such as smart home control and device management are invoked over the JSON-RPC 2.0 protocol through `POST /mcp/http`.

---

## 2. HTTP REST Endpoints

### 2.1 Health Check

```
GET /health
```

**Response example**:
```json
{"status": "ok"}
```

### 2.2 OAuth Authorization Callback

#### 2.2.1 OAuth Callback

```
GET /auth/callback?code=xxx&source=browser
```

| Parameter | Type | Required | Description |
|------|------|------|------|
| `code` | string | Yes | OAuth authorization code |
| `source` | string | No | Source identifier; when `browser`, a page redirect is triggered |

**Response**: On success, returns an HTML page showing the authorization result; on failure, returns an error message.

#### 2.2.2 Browser OAuth Callback

```
GET /auth/browser-callback?code=xxx
```

| Parameter | Type | Required | Description |
|------|------|------|------|
| `code` | string | Yes | OAuth authorization code |

**Response**: Redirects to `/#/?auth=success` or `/#/?auth=failed`.

#### 2.2.3 Browser OAuth Start Page

```
GET /auth/browser-start?oauth_url=xxx&callback=xxx
```

| Parameter | Type | Required | Description |
|------|------|------|------|
| `oauth_url` | string | Yes | OAuth authorization URL |
| `callback` | string | Yes | Callback address |

**Response**: Returns an HTML page containing a Xiaomi login button that automatically redirects to the authorization page after 500ms.

### 2.3 Gateway Info

```
GET /api/v1/gateway/info
```

**Response example**:
```json
{
  "code": 0,
  "data": {
    "version": "v1.2.14",
    "platform": "linux",
    "device_id": "xxx",
    "edition": "licensed",
    "licensed": true
  }
}
```

### 2.4 License Management

#### Get License Status

```
GET /api/v1/gateway/license
```

**Response example**:
```json
{
  "code": 0,
  "data": {
    "edition": "licensed",
    "status": "active",
    "product": "feyagate-linux",
    "license_key": "FG-xxxx-****-xxxx"
  }
}
```

#### Write License Key

```
POST /api/v1/gateway/license
Content-Type: application/json
```

**Request body**:
```json
{
  "license_key": "FG-XXXX-XXXX-XXXX",
  "product": "feyagate-linux"
}
```

| Parameter | Type | Required | Description |
|------|------|------|------|
| `license_key` | string | Yes | License key, format `FG-XXXX-XXXX-XXXX` |
| `product` | string | No | Product identifier; defaults to the value in the configuration file |

**Response example**:
```json
{
  "code": 0,
  "data": {
    "edition": "licensed",
    "status": "active",
    "activated": true
  }
}
```

#### Clear License

```
DELETE /api/v1/gateway/license
```

**Response example**:
```json
{
  "code": 0,
  "data": { "edition": "free", "status": "inactive" },
  "message": "授权已清除, 恢复免费版"
}
```

---

## 3. MCP JSON-RPC Endpoints

### 3.1 Protocol Description

All MCP tools are invoked through a single endpoint:

```
POST /mcp/http
Content-Type: application/json
```

**Request format** (JSON-RPC 2.0):
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

**Response format**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

> **Note**: `GET /mcp/http` returns `{"error": "SSE stream not supported yet. Use POST for JSON-RPC."}`; SSE is not supported yet.

### 3.2 Protocol Methods

| Method | Description |
|------|------|
| `initialize` | MCP protocol handshake |
| `ping` | Keep-alive heartbeat |
| `tools/list` | List all registered tools |
| `tools/call` | Invoke the specified tool |
| `notifications/initialized` | Initialization-complete notification (no response) |

---

## 4. 米家 (Mi Home) Platform

### 4.1 xiaomi/auth_status

Check the Mi Home OAuth authorization status.

**Parameters**: none

**Response example**:
```json
{
  "authorized": true,
  "remaining_seconds": 86400,
  "cloud_server": "cn"
}
```

### 4.2 xiaomi/auth_url

Get the Mi Home OAuth authorization URL.

**Parameters**: none

**Response example**:
```json
{
  "url": "https://account.xiaomi.com/oauth2/authorize?...",
  "message": "请在浏览器中打开此 URL 完成米家账号授权。"
}
```

### 4.3 xiaomi/auth_callback

Process the OAuth authorization callback code.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `code` | string | Yes | OAuth authorization code |

### 4.4 xiaomi/refresh

Refresh the Mi Home token.

**Parameters**: none

### 4.5 xiaomi/camera_list

Get the list of Mi Home cameras.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `filter` | string[] | No | Keyword filter array |

**Response example**:
```json
[
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
]
```

### 4.6 xiaomi/camera_status

Query the camera connection status.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `camera_id` | string | No | Camera DID; leave empty to return all |

### 4.7 xiaomi/camera_connect

Connect to a camera.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `camera_id` | string | Yes | Camera DID |

### 4.8 xiaomi/camera_disconnect

Disconnect the camera.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `camera_id` | string | Yes | Camera DID |

### 4.9 xiaomi/camera_snapshot

Capture a snapshot from the camera.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `camera_id` | string | Yes | Camera DID |
| `channel` | integer | No | Channel number, default `0` |
| `count` | integer | No | Number of frames to capture, default `1`, maximum `10` |
| `use_subprocess` | boolean | No | Whether to capture in a subprocess |

### 4.10 xiaomi/get_area_info

Get the home and room information from Mi Home.

**Parameters**: none

### 4.11 xiaomi/get_device_classes

Get the list of Mi Home device categories.

**Parameters**: none

### 4.12 xiaomi/get_devices

Get the list of Mi Home devices.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `area_id` | string | No | Filter by room ID |
| `device_class` | string | No | Filter by device category |

### 4.13 get_xiaomi_device_properties

Get Mi Home device property values.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `deviceId` | string | Yes | Device DID |
| `siid` | integer | Yes | Service ID |
| `piids` | integer[] | Yes | Property ID array |

### 4.14 set_xiaomi_device_property

Set a Mi Home device property.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `deviceId` | string | Yes | Device DID |
| `siid` | integer | Yes | Service ID |
| `piid` | integer | Yes | Property ID |
| `value` | any | Yes | Property value |

### 4.15 execute_xiaomi_device_action

Execute a Mi Home device action.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `deviceId` | string | Yes | Device DID |
| `siid` | integer | Yes | Service ID |
| `aiid` | integer | Yes | Action ID |
| `params` | array | No | Action parameters |

### 4.16 xiaomi/scene_list

Get the list of Mi Home scenes.

**Parameters**: none

### 4.17 xiaomi/scene_trigger

Trigger a Mi Home scene.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `sceneId` | string | Yes | Scene ID |

---

## 5. 小爱音箱 (Xiaoai Speaker)

### 5.1 xiaoai/play_music

Control the Xiaoai speaker to play music or voice content.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `device_id` | string | Yes | Xiaoai speaker device ID |
| `text` | string | Yes | Content to play |
| `command` | string | No | Playback command (an alias of `text`) |

### 5.2 xiaoai/tts

Xiaoai speaker TTS speech broadcast.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `device_id` | string | Yes | Xiaoai speaker device ID |
| `text` | string | Yes | Text to broadcast |

### 5.3 xiaoai/control

Send a control command to the Xiaoai speaker.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `device_id` | string | Yes | Xiaoai speaker device ID |
| `command` | string | Yes | Control command |
| `silence` | boolean | No | Execute silently, default `true` |

---

## 6. 小智 (Xiaozhi) Platform

> The Xiaozhi platform supports multiple connections (up to the limit defined by the `XIAOZHI_MAX_CONNECTIONS` constant).

### 6.1 xiaozhi/status

Get the connection status of all Xiaozhi platform connections.

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

### 6.2 xiaozhi/list

List all configured Xiaozhi connection endpoints.

**Parameters**: none

### 6.3 xiaozhi/add

Add a new Xiaozhi platform WebSocket connection.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `endpoint` | string | Yes | WebSocket URL (`ws://` or `wss://`) |

### 6.4 xiaozhi/remove

Delete the Xiaozhi connection at the given index.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `index` | integer | Yes | Connection index (0-based) |

### 6.5 xiaozhi/set_endpoint

Set the first Xiaozhi platform endpoint (backward-compatible endpoint).

| Parameter | Type | Required | Description |
|------|------|------|------|
| `endpoint` | string | No | WebSocket URL; leave empty to disable |

---

## 7. License and Gateway

### 7.1 license/status

Get the device license status.

**Parameters**: none

**Response example**:
```json
{
  "edition": "licensed",
  "status": "active",
  "product": "feyagate-linux",
  "device_id": "xxx",
  "key_masked": "FG-xxxx-****-xxxx"
}
```

> On the free edition, an additional `guidance` field is returned, containing license guidance information.

### 7.2 license/set

Write a license key and activate it.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `license_key` | string | Yes | License key, format `FG-XXXX-XXXX-XXXX` |
| `product` | string | No | Product identifier; defaults to the value in the configuration file |

**Response example**:
```json
{
  "edition": "licensed",
  "status": "active",
  "activated": true,
  "message": "授权成功! 全平台功能已解锁。"
}
```

### 7.3 license/clear

Clear the license key and revert to the free edition.

**Parameters**: none

### 7.4 gateway/info

Get gateway info (the MCP counterpart of the REST endpoint `GET /api/v1/gateway/info`).

**Parameters**: none

---

## 8. Vision AI

### 8.1 xiaomi/camera_vision_chat

Ask Vision AI about what the camera sees.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `camera_id` | string | Yes | Camera device DID |
| `query` | string | Yes | The question asked of the AI |
| `channel` | integer | No | Camera channel, default `0` |
| `count` | integer | No | Number of most recent frames sent, default `3`, maximum `10` |

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

> `vision.enabled=true` and `api_key` must first be configured in `config.yaml`.

---

## 9. Trigger Rules

### 9.1 trigger/create

Create a camera trigger rule.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `name` | string | Yes | Rule name |
| `cameras` | string[] | Yes | List of associated camera DIDs |
| `condition` | string | Yes | Natural-language trigger condition |
| `actions` | array | No | List of actions executed on trigger |
| `notify` | object | No | Notification configuration `{title, body}` |
| `filter` | object | No | Filter `{interval, period}` |

**Response example**:
```json
{
  "id": "rule_001",
  "message": "触发规则已创建",
  "rule": { ... }
}
```

### 9.2 trigger/list

List all trigger rules.

**Parameters**: none

### 9.3 trigger/update

Update a trigger rule.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `id` | string | Yes | Rule ID |
| `name` | string | No | New name |
| `cameras` | string[] | No | New camera list |
| `condition` | string | No | New trigger condition |
| `actions` | array | No | New action list |
| `notify` | object | No | New notification configuration |
| `filter` | object | No | New filter |
| `enabled` | boolean | No | Enable/disable |

### 9.4 trigger/delete

Delete a trigger rule.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `id` | string | Yes | Rule ID |

### 9.5 trigger/toggle

Enable or disable a trigger rule.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `id` | string | Yes | Rule ID |
| `enabled` | boolean | Yes | `true` enables, `false` disables |

### 9.6 trigger/logs

View the execution logs of trigger rules.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `limit` | integer | No | Maximum number of entries returned, default `50` |
| `rule_id` | string | No | Filter by rule ID |

---

## 10. Configuration Management

### 10.1 config/get_vision

Get the current Vision AI configuration.

**Parameters**: none

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

### 10.2 config/set_vision

Update the Vision AI configuration and save it to `config.yaml`; the change takes effect immediately.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `enabled` | boolean | No | Whether Vision AI is enabled |
| `api_key` | string | No | LLM API key |
| `base_url` | string | No | OpenAI-compatible API endpoint |
| `model` | string | No | Model name |
| `temperature` | number | No | Temperature parameter (0-2) |
| `max_tokens` | integer | No | Maximum response token count |
| `timeout_seconds` | integer | No | HTTP timeout in seconds |

### 10.3 config/get_trigger

Get the current trigger engine configuration.

**Parameters**: none

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

### 10.4 config/set_trigger

Update the trigger engine configuration and save it to `config.yaml`; the change takes effect immediately.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `enabled` | boolean | No | Whether the trigger engine is enabled |
| `interval_seconds` | integer | No | Rule check interval (seconds) |
| `vision_img_count` | integer | No | Number of frames used per LLM call |
| `motion_threshold` | integer | No | dHash motion detection threshold |
| `log_ttl_days` | integer | No | Number of days logs are retained |
| `min_trigger_interval` | integer | No | Minimum trigger interval per rule (seconds) |

---

## 11. Statistics

### 11.1 stats/token_usage

Get token usage statistics.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `days` | integer | No | Number of recent days to aggregate, default `30` |

**Response example**:
```json
{
  "summary": { "total_tokens": 150000, "total_calls": 300 },
  "daily": [ {"date": "2026-05-20", "tokens": 5000, "calls": 10} ],
  "by_model": [ {"model": "gpt-4o", "tokens": 100000} ],
  "by_source": [ {"source": "vision", "tokens": 80000} ]
}
```

### 11.2 stats/token_records

Get recent LLM API call records.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `limit` | integer | No | Number of records returned, default `50` |

### 11.3 stats/trigger_summary

Get aggregated trigger event statistics (daily trend, rule ranking, camera distribution, time heatmap).

| Parameter | Type | Required | Description |
|------|------|------|------|
| `days` | integer | No | Number of recent days to aggregate, default `30` |

**Response example**:
```json
{
  "overview": {
    "today": 5, "this_week": 32, "total": 150,
    "enabled_rules": 3, "total_rules": 5
  },
  "daily": [ {"date": "2026-05-20", "count": 8} ],
  "by_rule": [ {"rule_id": "rule_001", "rule_name": "有人进入", "count": 20} ],
  "by_camera": [ {"camera_id": "102838844", "count": 45} ],
  "heatmap": [ {"weekday": "Mon", "weekday_idx": 0, "hour": 9, "count": 3} ]
}
```

### 11.4 stats/dashboard

Get the dashboard summary data.

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

## 12. Multi-platform Devices

### 12.1 auth/platforms

List all registered smart home platforms and their authentication status.

**Parameters**: none

### 12.2 device/list

Get the device list of all authenticated platforms (unified across platforms).

| Parameter | Type | Required | Description |
|------|------|------|------|
| `platform` | string | No | Filter by platform: `xiaomi` / `tuya` / `midea` / `ewelink` |
| `filter` | string[] | No | Keyword filter array, matched against device name, model, and room name |

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

### 12.3 device/specs

Get the device capability specification definitions (unified across platforms).

| Parameter | Type | Required | Description |
|------|------|------|------|
| `deviceId` | string | Yes | Device ID |

### 12.4 涂鸦 (Tuya) Platform

| Tool name | Required parameters | Description |
|--------|----------|------|
| `auth/tuya_qr` | `user_code` | Start Tuya QR code authorization |
| `auth/tuya_qr_status` | `token`, `user_code` | Query the QR scan status |
| `auth/tuya_logout` | none | Log out of Tuya authorization |
| `tuya/refresh` | none | Refresh the Tuya device list |
| `get_tuya_device_properties` | `deviceId` | Get the device DP properties |
| `set_tuya_device_property` | `deviceId`, `code`, `value` | Set a device DP property (requires authorization) |

**set_tuya_device_property parameters**:

| Parameter | Type | Required | Description |
|------|------|------|------|
| `deviceId` | string | Yes | Device ID |
| `code` | string | Yes | DP code (e.g. `switch_1`, `bright_value`) |
| `value` | any | Yes | DP value (boolean/number/string) |

### 12.5 美的 (Midea) Platform

| Tool name | Required parameters | Description |
|--------|----------|------|
| `auth/midea_login` | `account`, `password` | Log in to the Midea platform |
| `auth/midea_logout` | none | Log out of Midea authorization |
| `midea/refresh` | none | Refresh the Midea device list |
| `get_midea_device_properties` | `deviceId` | Get the device properties |
| `set_midea_device_property` | `deviceId`, `property`, `value` | Set a device property (requires authorization) |

**auth/midea_login parameters**:

| Parameter | Type | Required | Description |
|------|------|------|------|
| `account` | string | Yes | Phone number or email address |
| `password` | string | Yes | Password |
| `cloud` | string | No | Cloud type: `meiju` (default) or `msmart` |

**set_midea_device_property parameters**:

| Parameter | Type | Required | Description |
|------|------|------|------|
| `deviceId` | string | Yes | Device ID (applianceCode) |
| `property` | string | Yes | Property name (e.g. `power`, `temperature`, `mode`) |
| `value` | any | Yes | Property value |

### 12.6 易微联 (eWeLink)

| Tool name | Required parameters | Description |
|--------|----------|------|
| `auth/ewelink_login` | `email`, `password` | Log in to the eWeLink platform |
| `auth/ewelink_logout` | none | Log out of eWeLink authorization |
| `ewelink/refresh` | none | Refresh the eWeLink device list |
| `get_ewelink_device_properties` | `deviceId` | Get the device properties |
| `set_ewelink_device_property` | `deviceId`, `property`, `value` | Set a device property (requires authorization) |

**auth/ewelink_login parameters**:

| Parameter | Type | Required | Description |
|------|------|------|------|
| `email` | string | Yes | Email address or phone number |
| `password` | string | Yes | Password |
| `country_code` | string | No | Country code, default `+86` |

**set_ewelink_device_property parameters**:

| Parameter | Type | Required | Description |
|------|------|------|------|
| `deviceId` | string | Yes | Device ID |
| `property` | string | Yes | Property name (e.g. `switch`, `switches`) |
| `value` | any | Yes | Property value (boolean/string/array) |

---

## 13. Scheduled Tasks

### 13.1 schedule/add

Create a scheduled task.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `name` | string | Yes | Task name |
| `scheduled_time` | string | Yes | Execution time in ISO 8601, e.g. `2026-05-24T08:00:00+08:00` |
| `tool_name` | string | Yes | Name of the MCP tool to execute |
| `tool_args` | string | Yes | Tool arguments as a JSON string |
| `repeat` | string | No | Repeat type: `none`/`daily`/`weekdays`/`weekends`/`weekly`/`custom` |
| `repeat_days` | string | No | Custom repeat days as a JSON array, e.g. `[1,2,3,4,5]` (Monday to Friday) |

### 13.2 schedule/list

List scheduled tasks.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `status` | string | No | Filter by status: `pending`/`completed`/`cancelled`; leave empty to return all |

### 13.3 schedule/get

Get the details of a scheduled task.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `id` | integer | Yes | Task ID |

### 13.4 schedule/update

Update a scheduled task (only tasks in `pending` status can be modified).

| Parameter | Type | Required | Description |
|------|------|------|------|
| `id` | integer | Yes | Task ID |
| `scheduled_time` | string | No | New execution time in ISO 8601 |
| `repeat` | string | No | New repeat type |
| `repeat_days` | string | No | New custom repeat days |

### 13.5 schedule/delete

Delete a scheduled task.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `id` | integer | Yes | Task ID |

### 13.6 schedule/cancel

Cancel a scheduled task (the record is kept and its status becomes `cancelled`).

| Parameter | Type | Required | Description |
|------|------|------|------|
| `id` | integer | Yes | Task ID |

---

## 14. Skill Management

### 14.1 skill/list

List all skills.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `source` | string | No | Source filter: `all` (default) / `builtin` / `user` |

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

### 14.2 skill/read

Read the full content of the specified skill.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `name` | string | Yes | Skill name |

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

### 14.3 skill/create

Create a new custom skill.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `name` | string | Yes | Skill name (letters, digits, and hyphens) |
| `content` | string | Yes | Skill content (Markdown + YAML frontmatter) |

### 14.4 skill/update

Update the content of an existing custom skill.

| Parameter | Type | Required | Description |
|------|------|------|------|
| `name` | string | Yes | Skill name |
| `content` | string | Yes | New skill content |

### 14.5 skill/delete

Delete the specified custom skill (built-in skills cannot be deleted).

| Parameter | Type | Required | Description |
|------|------|------|------|
| `name` | string | Yes | Skill name |

### 14.6 skill/context

Get the context content of all resident skills.

**Parameters**: none

**Response example**:
```json
{
  "context": "...",
  "skill_count": 5
}
```

### 14.7 skill/reload

Rescan the skill directory and refresh the cache.

**Parameters**: none
