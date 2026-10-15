# FeyaGate — 让 AI 助手控制你的智能家居

[English](#english) · [中文](#中文)

[![npm](https://img.shields.io/badge/npm-feyagate-blue)](https://www.npmjs.com/package/feyagate)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple)](https://modelcontextprotocol.io)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

让 Claude Code、Cursor、Codex CLI、Windsurf、Gemini CLI、DeepSeek Harness（DSH）、OpenClaw 等 AI 工具直接控制家里的设备：灯、空调、摄像头、音箱、插座和定时任务。支持 **米家（小米）、涂鸦、美的、易微联（Sonoff）、华为智慧生活**。

官网：[www.feyagate.com](https://www.feyagate.com)

## 它由什么组成

| 组成 | 说明 |
|---|---|
| **技能（SKILL）** | [skill/](<skill/>) 目录。教 AI 什么时候用、怎么安全地用，本身不包含任何可执行代码。 |
| **引擎** | `miloco-mcp-server`，装在本机的 MCP 服务，负责和各家云平台通信。约 25 MB，只监听 `127.0.0.1`。 |
| **命令行** | npm 包 `feyagate`，负责安装、校验、升级、启动、回滚引擎，以及注册到 AI 工具。 |

## 安装前准备

- Node.js 20.16 或更新版本（`node -v` 查看）
- macOS（Apple 芯片 / Intel）、Linux（x64 / arm64）或 Windows x64
- 能访问 github.com

不需要预先 `npm install`，下面所有命令都用 `npx` 直接运行。

---

<a id="中文"></a>

## 方式一：自己动手安装（中文）

### 第 1 步：安装并启动引擎

```bash
npx -y feyagate install --yes
```

命令会从 GitHub 下载引擎，按 npm 包内置的 SHA-256 校验值核对无误后安装到 `~/.feyagate-mcp/`，然后启动。看到 `✓ FeyaGate 引擎 v… 已运行` 就成功了。

想先看清楚它要做什么，可以去掉 `--yes` 先跑一次：只打印安装计划，不改动任何文件。

### 第 2 步：接入你的 AI 工具

```bash
npx -y feyagate setup-agent claude --yes
```

把 `claude` 换成你用的工具名：`cursor`、`codex`、`windsurf`、`gemini`、`dsh`、`openclaw`。这一步会做两件事：

- 把技能复制到该工具的 skills 目录；
- 在它的 MCP 配置里加一条 `feyagate → npx -y feyagate mcp`。

原配置文件会先备份成 `*.feyagate.bak`，其余配置不动。DSH 无法自动写配置，命令会告诉你手动填什么。

### 第 3 步：登录智能家居平台

```bash
npx -y feyagate auth tuya --user-code <用户代码>   # 涂鸦：扫码。用户代码在 App「我的 → 设置 → 账号与安全」
npx -y feyagate auth xiaomi                        # 米家：浏览器授权后粘贴回调地址
npx -y feyagate auth midea                         # 美的：输入账号密码
npx -y feyagate auth ewelink                       # 易微联：输入账号密码
npx -y feyagate auth huawei                        # 华为：账号密码 + 双重验证码（不发短信，看华为手机/平板弹窗）
npx -y feyagate auth status                        # 查看各平台登录状态
```

密码输入时不回显，只发给本机引擎，不会进入 AI 的对话。

### 第 4 步：重启 AI 工具，开始使用

重启后直接对 AI 说「列出我家的设备」「把客厅灯关掉」「空调调到 26 度」即可。

---

## 方式二：让 AI 帮你安装（中文）

把下面这段话原样发给你的 AI 助手（需要它能执行终端命令）：

```text
请阅读 https://unpkg.com/feyagate/skill/SKILL.md ，按里面的步骤在我的电脑上安装 FeyaGate：
先运行 npx -y feyagate doctor --json 检查状态；安装引擎和修改我的 AI 工具配置之前，先告诉我你打算做什么，等我同意。
```

AI 会按技能里写好的流程执行：

1. 运行 `doctor` 判断当前状态；
2. 运行不带 `--yes` 的 `install`，把版本、大小、下载来源告诉你，**等你同意**后再装；
3. 问你在用哪个 AI 工具，**等你同意**后运行 `setup-agent`；
4. 登录平台：
   - 涂鸦只需要用户代码，AI 可以直接帮你生成二维码，你用 App 扫码即可；
   - 米家、美的、易微联、华为需要账号密码，AI 会请你在**自己的终端**里运行对应的 `npx -y feyagate auth …`。**不要把密码发到聊天里**；
5. 提醒你重启 AI 工具。

如果你的 AI 工具不支持 MCP 也没关系，AI 可以用 `npx -y feyagate call <工具名> '<参数 JSON>'` 直接调用引擎工具。

---

## 升级、回滚、卸载

```bash
npx -y feyagate upgrade --check       # 只检查有没有新版，不下载
npx -y feyagate upgrade --yes         # 升级引擎
npx -y feyagate@latest upgrade --yes  # 检查提示有新版 CLI 时，用最新 CLI 升级
npx -y feyagate rollback              # 切回上一个版本
npx -y feyagate uninstall --yes       # 卸载；加 --keep-data 可保留登录状态和授权
```

升级时新版本装在旧版本旁边的目录里，启动并通过健康检查后才切换；一旦失败会自动回退到旧版本，不会把用户卡在坏版本上。

其他常用命令：`doctor`（体检）、`status`、`start`、`stop`、`restart`、`logs`、`tools`、`call`。完整用法见 `npx -y feyagate help`。

## 常见问题

- **下载慢或失败**：GitHub 不通时会自动切换备用源。也可以手动下载后运行 `install --yes --local <文件路径>`（同样校验 SHA-256），或用 `--mirror <镜像地址>` 指定镜像。
- **端口被占用**：默认 38080，被占用时自动顺延到 38081、38082……AI 工具通过 `npx -y feyagate mcp` 连接，会自动找到实际端口，不用改配置。
- **AI 里看不到设备工具**：运行 `npx -y feyagate doctor`，按提示安装或启动引擎，然后重启 AI 工具。
- **出现 `capability_denied`**：该平台的免费试用期已到期，运行 `npx -y feyagate call license/status` 查看授权状态。

## 安全说明

- 引擎只监听 `127.0.0.1` 且没有鉴权，同一台电脑上的其他程序也能访问它，请只在信任的机器上使用。
- 只安装 SHA-256 与 npm 包内置清单一致的引擎；校验不通过的下载会被删除，不会执行。
- 安装、升级、卸载、修改 AI 工具配置都必须显式加 `--yes`，否则只打印计划，不做任何改动。
- 账号密码只在你自己的终端里输入，不能作为命令行参数，也不会经过 AI 对话。
- **联网范围**：github.com（下载引擎）、你登录的各家云平台、www.feyagate.com（授权与试用校验）；GitHub 不可达时备用源为 oneapi.sooncore.com。
- **文件位置**：引擎与数据默认在 `~/.feyagate-mcp/`，可用环境变量 `FEYAGATE_HOME` 更改。

## 开发

```bash
npm install
npm test              # 编译 + 单元测试（使用假引擎，不联网）
npm run manifest      # 从 GitHub Releases 重新生成内置引擎清单
npm run pack:skill    # Agensi 发布前检查 + 生成 dist/feyagate-skill-<版本>.zip
npm publish           # 发布前自动跑测试
```

目录结构：`skill/` 是技能（也是 Agensi 上架的内容），`src/` 是命令行，`manifest/` 是内置的引擎版本与校验值清单，`test/` 是单元测试。

旧版 Python 包（`pip install feyagate-skill`，1.3.x）见 [toddpan/feyagate-skill](https://github.com/toddpan/feyagate-skill)，它使用 `~/.feyagate` 目录，与本包互不影响。

## 许可证

MIT

---

<a id="english"></a>

# FeyaGate — smart home control for AI agents

Let Claude Code, Cursor, Codex CLI, Windsurf, Gemini CLI, DeepSeek Harness (DSH), OpenClaw and other MCP-capable agents control your home: lights, air conditioning, cameras, speakers, plugs, and scheduled tasks. Works with **Xiaomi (Mi Home), Tuya, Midea, eWeLink (Sonoff) and Huawei SmartHome**.

Website: [www.feyagate.com](https://www.feyagate.com)

## What it is made of

| Part | What it does |
|---|---|
| **Skill** | The [skill/](<skill/>) folder. Tells the agent when and how to use FeyaGate safely. Contains no executable code. |
| **Engine** | `miloco-mcp-server`, a local MCP server that talks to the vendor clouds. About 25 MB, binds to `127.0.0.1` only. |
| **CLI** | The npm package `feyagate`: installs, verifies, upgrades, starts and rolls back the engine, and registers it with your AI tool. |

## Requirements

- Node.js 20.16 or newer (`node -v`)
- macOS (Apple silicon / Intel), Linux (x64 / arm64) or Windows x64
- Network access to github.com

No `npm install` needed — every command below runs through `npx`.

### Option A: install it yourself

**1. Install and start the engine**

```bash
npx -y feyagate install --yes
```

It downloads the engine from GitHub, verifies it against the SHA-256 value pinned inside the npm package, installs it into `~/.feyagate-mcp/`, and starts it. Drop `--yes` for a dry run that only prints the plan and changes nothing.

**2. Connect your AI tool**

```bash
npx -y feyagate setup-agent claude --yes
```

Replace `claude` with `cursor`, `codex`, `windsurf`, `gemini`, `dsh` or `openclaw`. This copies the skill into that tool's skills directory and adds one MCP entry, `feyagate → npx -y feyagate mcp`, to its config. The original file is backed up to `*.feyagate.bak` first and other entries are left untouched. DSH has to be configured by hand; the command prints exactly what to fill in.

**3. Log in to your platforms**

```bash
npx -y feyagate auth tuya --user-code <CODE>   # Tuya: scan a QR. User code: Me → Settings → Account and Security
npx -y feyagate auth xiaomi                    # Xiaomi: browser OAuth, then paste the redirect URL
npx -y feyagate auth midea                     # Midea: account and password
npx -y feyagate auth ewelink                   # eWeLink: account and password
npx -y feyagate auth huawei                    # Huawei: account, password, two-factor code (no SMS — it pops up on a signed-in Huawei phone/tablet)
npx -y feyagate auth status                    # Check which platforms are logged in
```

Passwords are entered with hidden input, sent only to the local engine, and never enter the AI conversation.

**4. Restart your AI tool and start asking**

Try "list my devices", "turn off the living-room light" or "set the AC to 26 degrees".

### Option B: let your AI agent install it

Send this to an agent that can run shell commands:

```text
Read https://unpkg.com/feyagate/skill/SKILL.md and install FeyaGate on my machine following it.
Start with npx -y feyagate doctor --json, and ask me before installing the engine or changing my AI tool's config.
```

The agent then:

1. runs `doctor` to see what is already there;
2. runs `install` **without** `--yes`, shows you the version, size and source, and waits for your **OK** before installing;
3. asks which AI tool you use and, after your **OK**, runs `setup-agent`;
4. handles login: Tuya needs only a non-secret user code so the agent can show you a QR code; Xiaomi, Midea, eWeLink and Huawei need a password, so the agent asks you to run `npx -y feyagate auth <platform>` in your own terminal. **Never paste a password into the chat**;
5. reminds you to restart the AI tool.

If your tool has no MCP support, the agent can still call the engine with `npx -y feyagate call <tool> '<json-args>'`.

### Upgrades, rollback, removal

```bash
npx -y feyagate upgrade --check       # check only, downloads nothing
npx -y feyagate upgrade --yes         # upgrade the engine
npx -y feyagate@latest upgrade --yes  # when the check reports a newer CLI, upgrade with it
npx -y feyagate rollback              # switch back to the previous version
npx -y feyagate uninstall --yes       # remove; add --keep-data to keep logins and the license
```

An upgrade installs the new version **next to** the old one and only switches over after it passes a health check. If it fails, FeyaGate rolls back automatically, so you are never stranded on a broken version.

Other commands: `doctor`, `status`, `start`, `stop`, `restart`, `logs`, `tools`, `call`. See `npx -y feyagate help`.

### Troubleshooting

- **Slow or failing download**: FeyaGate automatically falls back to a mirror. You can also download the archive yourself and run `install --yes --local <file>` (still SHA-256 verified), or point it at your own with `--mirror <url>`.
- **Port already in use**: the default is 38080 and it moves up to 38081, 38082… automatically. AI tools connect through `npx -y feyagate mcp`, which finds the live port for you — nothing to configure.
- **No device tools in the agent**: run `npx -y feyagate doctor`, follow what it says, then restart the AI tool.
- **`capability_denied` errors**: the free trial for that platform has expired. Run `npx -y feyagate call license/status`.

### Security

- The engine binds to `127.0.0.1` with no authentication, so any other program on the same machine can reach it. Only use it on a machine you trust.
- Only engines whose SHA-256 matches the manifest shipped inside the npm package are installed. A download that fails verification is deleted, never run.
- Installing, upgrading, removing or editing an AI tool's config requires an explicit `--yes`. Without it, FeyaGate only prints the plan.
- Passwords are typed in your own terminal, never passed as command-line arguments, and never sent through the AI chat.
- **Network access**: github.com (engine download), the vendor cloud you log in to, and www.feyagate.com (license and trial checks). When GitHub is unreachable the fallback mirror is oneapi.sooncore.com.
- **Files**: engine and data live in `~/.feyagate-mcp/` by default; set `FEYAGATE_HOME` to change it.

### Development

```bash
npm install
npm test              # build + unit tests with a fake engine, no network
npm run manifest      # regenerate the pinned engine manifest from GitHub Releases
npm run pack:skill    # Agensi pre-flight + dist/feyagate-skill-<version>.zip
npm publish           # runs the tests first
```

Layout: `skill/` is the skill (and what gets uploaded to Agensi), `src/` is the CLI, `manifest/` pins engine versions and checksums, `test/` holds the unit tests.

The legacy Python package (`pip install feyagate-skill`, 1.3.x) lives in [toddpan/feyagate-skill](https://github.com/toddpan/feyagate-skill) and uses `~/.feyagate`; it does not interfere with this package.

## License

MIT
