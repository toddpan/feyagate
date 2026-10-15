# Automation & Utility Tools

> **Parent skill:** [SKILL.md](../SKILL.md) — provides cross-platform tools and MCP endpoint config.

## Schedule

> Schedule tasks call any other MCP tool at a given time. The `tool_name` must be a registered tool name (e.g. `set_xiaomi_device_property`, `set_tuya_device_property`).

| Tool | Arguments | Returns |
|------|-----------|---------|
| `schedule/add` | `name`, `scheduled_time`, `tool_name`, `tool_args`, `repeat` (opt), `repeat_days` (opt) | Task ID |
| `schedule/list` | `status` (opt) | `tasks[]` |
| `schedule/get` | `id` (int) | Task detail |
| `schedule/update` | `id` + fields to update | Update result |
| `schedule/delete` | `id` (int) | Delete result |
| `schedule/cancel` | `id` (int) | Cancel result (preserves record as `cancelled`) |

**Field formats:**
- `scheduled_time`: ISO 8601 string, e.g. `2026-05-16T23:00:00+08:00`
- `tool_name`: full MCP tool name with prefix (e.g. `set_xiaomi_device_property`, `xiaomi/camera_snapshot`)
- `tool_args`: **JSON string** (not object), e.g. `"{\"deviceId\":\"xxx\",\"siid\":2,\"piid\":1,\"value\":false}"`
- `repeat`: `none` / `daily` / `weekdays` / `weekends` / `weekly` / `custom`
- `repeat_days`: JSON array string, e.g. `"[1,2,3,4,5]"` (0=Sun, 1=Mon, ..., 6=Sat). Only used when `repeat=custom`.
- `status` (for `schedule/list`): `pending` / `completed` / `cancelled` (omit to list all)

**Example:**
```json
{
  "name": "schedule/add",
  "arguments": {
    "name": "Turn off lights at bedtime",
    "scheduled_time": "2026-05-16T23:00:00+08:00",
    "tool_name": "set_xiaomi_device_property",
    "tool_args": "{\"deviceId\":\"xxx\",\"siid\":2,\"piid\":1,\"value\":false}",
    "repeat": "daily"
  }
}
```

## Trigger Engine

Trigger rules monitor Xiaomi camera frames and auto-execute MCP tool calls when a natural-language condition is detected.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `trigger/create` | `name`, `cameras`, `condition`, `actions` (opt), `notify` (opt), `filter` (opt) | Rule ID |
| `trigger/list` | — | `rules[]` |
| `trigger/update` | `id` + fields to update | Update result |
| `trigger/delete` | `id` | Delete result |
| `trigger/toggle` | `id`, `enabled` | Toggle result |
| `trigger/logs` | `limit` (opt), `rule_id` (opt) | `logs[]` |

**Action format** (`trigger.create.actions[]`):
```json
{
  "tool": "set_xiaomi_device_property",
  "args": { "deviceId": "LIGHT_DID", "siid": 2, "piid": 1, "value": true }
}
```

**Example — "Turn on the light when someone comes in":**
```json
{
  "name": "trigger/create",
  "arguments": {
    "name": "Motion light at the entryway",
    "cameras": ["CAMERA_DID"],
    "condition": "Someone enters the entryway",
    "actions": [
      {
        "tool": "set_xiaomi_device_property",
        "args": { "deviceId": "LIGHT_DID", "siid": 2, "piid": 1, "value": true }
      }
    ]
  }
}
```

## Skill System

> Manages the skill set served to the AI agent at runtime. Skills are stored as Markdown files in the `skills/` directory.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `skill/list` | `source` (opt: `all` / `builtin` / `user`) | Skills with metadata |
| `skill/read` | `name` | Full skill content (frontmatter + body) |
| `skill/create` | `name`, `content` | Create result |
| `skill/update` | `name`, `content` | Update result |
| `skill/delete` | `name` | Delete result (built-ins cannot be deleted) |
| `skill/context` | — | Always-on skills context summary |
| `skill/reload` | — | Re-scan and refresh |

**`skill/create` / `skill/update`:** `content` is the full Markdown file including YAML frontmatter, e.g.:
```
---
name: my_skill
description: ...
---
# My skill
...
```
