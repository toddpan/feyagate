# Xiaomi Platform Tools

> Examples below show raw HTTP for reference. In practice call MCP tools, or run `npx -y feyagate call <tool> '<json>'`. The engine port may differ from 38080 (see `npx -y feyagate status`).


> **Parent skill:** [SKILL.md](../SKILL.md) — provides cross-platform tools (`device/list`, `device/specs`, `auth/platforms`, `gateway/info`) and MCP endpoint config.

## Device Control

> **Parameter naming convention:** Xiaomi device control tools use `deviceId` (camelCase), not `device_id`.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `get_xiaomi_device_properties` | `deviceId` (string), `siid` (int), `piids` (int[]) | Property values |
| `set_xiaomi_device_property` | `deviceId` (string), `siid` (int), `piid` (int), `value` | Control result |
| `execute_xiaomi_device_action` | `deviceId` (string), `siid` (int), `aiid` (int), `params` (opt array) | Action result |

**Workflow (steps 1–2 use parent skill tools):**
1. `device/list` with `{"filter": ["keyword"], "platform": "xiaomi"}` → find target device
2. `device/specs` with `{"deviceId": "xxx"}` → get `siid`/`piid`/`aiid` definitions
3. `get_xiaomi_device_properties` → read current values
4. `set_xiaomi_device_property` → set property value

**`set_xiaomi_device_property` example:**
```json
{
  "name": "set_xiaomi_device_property",
  "arguments": {"deviceId": "1234567890", "siid": 2, "piid": 1, "value": true}
}
```

## Auth & Device Management

| Tool | Arguments | Returns |
|------|-----------|---------|
| `xiaomi/auth_status` | — | `authorized`, `remaining_seconds`, `cloud_server` |
| `xiaomi/auth_url` | `region` (opt) | OAuth login URL |
| `xiaomi/auth_callback` | `code`, `region` (opt) | Token exchange result |
| `xiaomi/refresh` | — | Re-fetch devices from cloud |
| `xiaomi/get_area_info` | — | `areas[]`, `total_areas` |
| `xiaomi/get_device_classes` | — | `device_classes[]` with counts |
| `xiaomi/get_devices` | `area_id` (opt), `device_class` (opt) | `devices[]`, `count` |

### OAuth Flow

```bash
# 1. Get OAuth URL (choose region matching your Xiaomi account)
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xiaomi/auth_url","arguments":{"region":"cn"}}}'

# 2. Open URL in browser → login → copy redirect URL → extract code

# 3. Submit code
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"xiaomi/auth_callback","arguments":{"code":"YOUR_CODE"}}}'

# 4. Verify
curl -s -X POST http://localhost:38080/mcp/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"xiaomi/auth_status","arguments":{}}}'
```

## Scenes

| Tool | Arguments | Returns |
|------|-----------|---------|
| `xiaomi/scene_list` | — | Scene list with `sceneId` and names |
| `xiaomi/scene_trigger` | `sceneId` (string) | Trigger result |

**Workflow:**
1. `xiaomi/scene_list` → get available scenes
2. `xiaomi/scene_trigger` with `{"sceneId": "xxx"}` → execute scene

## Camera Control (macOS/Linux only)

| Tool | Arguments | Returns |
|------|-----------|---------|
| `xiaomi/camera_list` | — | `cameras[]` with metadata |
| `xiaomi/camera_status` | `camera_id` (opt) | Connection status, `buffered_frames` |
| `xiaomi/camera_connect` | `camera_id` | Start P2P stream |
| `xiaomi/camera_disconnect` | `camera_id` | Stop stream |
| `xiaomi/camera_snapshot` | `camera_id`, `channel` (opt), `count` (opt), `use_subprocess` (opt) | `images[]` (base64 JPEG) |
| `xiaomi/camera_vision_chat` | `camera_id`, `query`, `channel` (opt), `count` (opt) | AI vision analysis |

> Windows is not supported for camera P2P streaming.

**Camera workflow:**
1. `xiaomi/camera_list` → discover cameras
2. `xiaomi/camera_connect` → establish P2P connection (wait 3–5s)
3. `xiaomi/camera_snapshot` → capture JPEG frames
4. `xiaomi/camera_disconnect` → release connection when done

**Vision AI (requires config):**
1. Set `vision.enabled=true` and `vision.api_key` in `config.yaml`
2. `xiaomi/camera_connect` → connect camera
3. `xiaomi/camera_vision_chat` with `{"camera_id": "xxx", "query": "有几个人?"}` → analyze

## XiaoAI Speaker Control

| Tool | Arguments | Returns |
|------|-----------|---------|
| `xiaoai/tts` | `device_id`, `text` | TTS playback result |
| `xiaoai/play_music` | `device_id`, `text` or `command` | Music playback result |
| `xiaoai/control` | `device_id`, `command`, `silence` (opt) | Voice command result |

```json
{"name": "xiaoai/control", "arguments": {"device_id": "xxx", "command": "打开客厅灯", "silence": true}}
```
