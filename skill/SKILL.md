---
name: feyagate
description: Control a real smart home from the AI agent through the local FeyaGate MCP engine. Use when the user asks to turn devices on or off, set brightness, temperature or AC mode, check device status, view a camera, make a XiaoAI speaker talk, create schedules or automations, or log in to Xiaomi (Mi Home / 米家), Tuya (Smart Life / 涂鸦), Midea (美的), eWeLink / Sonoff or Huawei (华为智慧生活). Also use when the user asks to install, upgrade, repair or roll back FeyaGate.
version: 2.0.1
author: panzuji
homepage: https://www.feyagate.com
license: MIT
---

# FeyaGate: smart home control for AI agents

FeyaGate is a local MCP engine (`miloco-mcp-server`). It bridges Xiaomi, Tuya, Midea, eWeLink and Huawei clouds to MCP tools such as `device/list`, `device/specs` and `xiaomi/set_property`. This skill teaches you how to install the engine, keep it updated and use it safely. It works the same way in Claude Code, Cursor, Codex CLI, Windsurf, Gemini CLI, DeepSeek Harness (DSH), OpenClaw and any other host that can run shell commands or MCP servers.

Everything runs through one npm CLI: `npx -y feyagate <command>`. It needs Node.js 20.16 or newer. All commands accept `--json` and print one JSON object on stdout.

## What this skill does to the user's machine

Tell the user this before the first install:

- It downloads one engine archive (about 25 MB) from `github.com/toddpan/miloco-mcp-server-releases`. If GitHub is unreachable, it falls back to the vendor mirror `oneapi.sooncore.com`.
- Every archive is checked against a SHA-256 value that ships inside the npm package. A mismatch is deleted and never run.
- Files go to `~/.feyagate-mcp/` (or `$FEYAGATE_HOME`). The engine listens on `127.0.0.1` only, port 38080 by default.
- The engine talks to the vendor clouds the user logs in to, plus `www.feyagate.com` for license and trial checks.
- Nothing is installed, upgraded or deleted without `--yes`. Run without it, the CLI only prints the plan and exits with code 3.

## Step 1: Run doctor before every smart-home session

```bash
npx -y feyagate doctor --json
```

Branch on `nextAction`:

| nextAction | What you do |
|---|---|
| `ready` | Go to Step 3. |
| `upgrade_available` | Go to Step 3. At a natural pause, offer the upgrade (Step 4). Never upgrade unasked. |
| `start` | Run `npx -y feyagate start`, then continue. |
| `install` | Install the engine (Step 2). |
| `upgrade_required` | The installed engine is older than `compat.minSupportedServer`. Explain this, ask, then run `npx -y feyagate upgrade --yes`. |
| `unsupported_platform` | Stop. Supported platforms are macOS arm64/x64, Linux x64/arm64 and Windows x64. |

## Step 2: First install (ask the user first)

1. Run `npx -y feyagate install --json` without `--yes`. It exits with code 3 and returns `plan`: version, file name, size, URL and pinned sha256.
2. Show the user the version, size and source host, then ask for consent.
3. After the user agrees, run `npx -y feyagate install --yes`. This downloads, verifies, extracts to `versions/<version>/`, starts the engine and waits for `/health`.
4. Optional: register the MCP server in the user's AI tool so the tools appear natively (Step 5).

Offline or intranet installs: `install --yes --local /path/to/archive.zip` (still checked against the pinned sha256) or `--mirror https://host/prefix`. Never pass `--allow-unverified` unless the user explicitly asks for it and understands that the archive will not be verified.

## Step 3: Use the tools

There are two ways to call tools. Use whichever the host supports.

- MCP (preferred): if the host already shows `feyagate` tools (for example `mcp__feyagate__device_list`), call them directly.
- CLI: `npx -y feyagate call <tool> '<json-args>'`, for example:

```bash
npx -y feyagate call auth/platforms
npx -y feyagate call device/list '{"filter":["客厅","灯"]}'
npx -y feyagate call device/specs '{"deviceId":"<id>"}'
```

Run `npx -y feyagate tools` to list every tool the installed engine offers.

### Control workflow

1. `device/list` to find the device and its `platform`.
2. `device/specs` before any first read or write. It returns the exact `siid/piid` (Xiaomi), DP codes (Tuya) or property names (Midea, eWeLink, Huawei).
3. Call the platform tool: `xiaomi/set_property`, `tuya/set_property`, `midea/set_property`, `ewelink/set_property` or `huawei/set_property`. The `get_properties` and `execute_action` tools work the same way.
4. Read the value back to confirm the change, then tell the user what changed.

Parameter casing: device tools use `deviceId` (camelCase). Only the `xiaoai/*` speaker tools use `device_id`.

Before doing anything with physical side effects, confirm with the user. That covers locks, garage doors, heaters, ovens, water valves, turning off cameras or alarms, and bulk changes to many devices.

Platform details are in the references. Load only the one you need:

- [references/xiaomi.md](references/xiaomi.md): Mi Home, MIOT `siid/piid`, cameras, XiaoAI speakers
- [references/tuya.md](references/tuya.md): Tuya DP codes, QR login
- [references/midea.md](references/midea.md): Midea air conditioners and appliances
- [references/ewelink.md](references/ewelink.md): eWeLink / Sonoff switches and relays
- [references/automation.md](references/automation.md): schedules, camera triggers, skills
- [references/extension.md](references/extension.md): Xiaozhi, license, vision config, stats
- [references/mcp-api.md](references/mcp-api.md): full tool reference
- [references/http-api.md](references/http-api.md): engine REST API

## Platform login

| Platform | How | Who runs it |
|---|---|---|
| Tuya | `npx -y feyagate auth tuya --user-code <CODE>` prints a QR code and saves `tuya-qr.png` in the install folder. The user code is in the Tuya / Smart Life app under Me → Settings → Account and Security → User Code. It is not a secret. | You may run it. Show the QR image to the user. The command waits until they scan. |
| Xiaomi | `npx -y feyagate auth xiaomi [--region cn]` prints an OAuth URL, then asks the user to paste the redirect URL. | The user, in their own terminal |
| Midea, eWeLink | `npx -y feyagate auth midea` and `npx -y feyagate auth ewelink` prompt for the account and password with hidden input. | The user, in their own terminal |
| Huawei | `npx -y feyagate auth huawei` prompts for the account and password, then the two-factor code. Huawei does not send an SMS. The code pops up on a Huawei phone or tablet signed in to the same account. | The user, in their own terminal |

Rules:

- Never ask the user to type a password into the chat. Never put passwords in command arguments. The CLI refuses `call auth/*_login` for that reason.
- If a login command exits with code 4, it needs an interactive terminal. Ask the user to run it themselves, then check the result with `npx -y feyagate auth status`.
- For Huawei, if the result says `sessionPreserved`, the verification code was already accepted. Do not ask for another one.
- `npx -y feyagate auth logout <platform>` signs out of one platform.

## Step 4: Upgrades and recovery

```bash
npx -y feyagate upgrade --check --json   # read-only: current, target, cliLatest, notes
npx -y feyagate upgrade --json           # prints the plan, exit code 3
npx -y feyagate upgrade --yes            # after the user agrees
```

How an upgrade works:

- The new version is installed next to the old one in `versions/<v>/`. Nothing is overwritten.
- The new version is marked pending, then started. It is promoted only after `/health` answers. If it fails, the CLI restarts the previous version automatically and reports `rolledBackTo`.
- If the machine crashed mid-upgrade, the next `start` notices the leftover pending entry and rolls back.
- The engine versions this CLI can install are the ones pinned in its manifest. If `upgrade --check` reports `cliLatest`, a newer CLI pins newer engines. Run the upgrade with `npx -y feyagate@latest upgrade --yes`.
- After a successful upgrade, old versions are pruned down to the current version, the last known-good version and the newest two.

Recovery commands:

| Problem | Command |
|---|---|
| Engine down or unhealthy | `npx -y feyagate restart`, then `npx -y feyagate logs -n 80` |
| Problems after an upgrade | `npx -y feyagate rollback` (previous version) or `rollback --to <version>` |
| Corrupted install | `npx -y feyagate install --yes --reinstall` |
| `capability_denied` errors | The free trial for that platform has expired. Run `call license/status` and tell the user. Do not retry the call. |
| Remove everything | Ask first, then `npx -y feyagate uninstall --yes`. Add `--keep-data` to keep logins and the license. |

## Step 5: Register in the user's AI tool (optional, ask first)

```bash
npx -y feyagate setup-agent <claude|cursor|codex|windsurf|gemini|dsh|openclaw>        # dry run, prints the changes
npx -y feyagate setup-agent <host> --yes                                               # apply
```

This copies this skill folder into the host's skills directory and adds one MCP server entry, `feyagate → npx -y feyagate mcp`. Other entries in the host's config are left untouched, and the original file is backed up to `*.feyagate.bak`. Restart the host afterwards. `remove-agent <host> --yes` undoes it.

The stdio MCP server never downloads anything. If the engine is installed but stopped, it starts it. If the engine is missing, it exposes a single `feyagate_setup_status` tool that explains how to install. The smart-home tools appear once the engine is ready.

## Exit codes

`0` ok · `1` error (read `error`) · `2` engine not installed · `3` needs the user's confirmation, re-run with `--yes` · `4` needs an interactive terminal
