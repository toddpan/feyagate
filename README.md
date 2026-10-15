# feyagate

让 AI 助手直接控制你家里的智能设备：米家（小米）、涂鸦、美的、易微联（Sonoff）、华为智慧生活。支持 Claude Code、Cursor、Codex CLI、Windsurf、Gemini CLI、DeepSeek Harness（DSH）、OpenClaw，以及其他支持 MCP 或能执行命令的 AI 工具。

它由两部分组成：

- **技能（SKILL）**：教 AI 什么时候用、怎么安全地用。
- **引擎**：装在本机的 MCP 服务 `miloco-mcp-server`，负责和各家云平台通信。由 `feyagate` 命令行负责安装、升级和启动。

[English](#english)

## 安装前准备

- Node.js 20.16 或更新版本（`node -v` 查看）
- macOS（Apple 芯片或 Intel）、Linux（x64 / arm64）或 Windows x64
- 能访问 github.com。引擎约 25 MB，第一次下载可能要几分钟

不需要事先 `npm install`，下面的命令都用 `npx` 直接运行。

---

## 方式一：自己动手安装

在终端里依次运行：

**1. 安装并启动引擎**

```bash
npx -y feyagate install --yes
```

会从 GitHub 下载引擎，按内置的 SHA-256 校验后安装到 `~/.feyagate-mcp/`，然后启动。看到 `✓ FeyaGate 引擎 v… 已运行` 就是成功了。

想先看看会下载什么，去掉 `--yes` 运行一次，它只打印计划，不做任何改动。

**2. 接入你的 AI 工具**

```bash
npx -y feyagate setup-agent claude --yes
```

把 `claude` 换成你用的工具：`cursor`、`codex`、`windsurf`、`gemini`、`dsh`、`openclaw`。这一步会做两件事：

- 把技能复制到该工具的 skills 目录
- 在它的 MCP 配置里加一条 `feyagate → npx -y feyagate mcp`

原配置文件会先备份成 `*.feyagate.bak`，其他配置不动。DSH 需要手动在「设置 › MCP」里添加，命令会告诉你填什么。

**3. 登录智能家居平台**

```bash
npx -y feyagate auth tuya --user-code <用户代码>   # 涂鸦：扫码，用户代码在 App「我的 → 设置 → 账号与安全」
npx -y feyagate auth xiaomi                        # 米家：浏览器授权，粘贴回调地址
npx -y feyagate auth midea                         # 美的：输入账号密码
npx -y feyagate auth ewelink                       # 易微联：输入账号密码
npx -y feyagate auth huawei                        # 华为：账号密码 + 双重验证码（不发短信，看华为手机/平板弹窗）
npx -y feyagate auth status                        # 查看各平台登录状态
```

密码输入时不显示，只发给本机引擎。

**4. 重启 AI 工具，开始使用**

重启后对 AI 说「列出我家的设备」或「把客厅灯关掉」就可以了。

---

## 方式二：让 AI 帮你安装

把下面这段话发给你的 AI 助手（需要它能执行终端命令）：

```text
请阅读 https://unpkg.com/feyagate/skill/SKILL.md ，按里面的步骤在我的电脑上安装 FeyaGate：
先运行 npx -y feyagate doctor --json 检查状态，安装引擎和接入 AI 工具前先告诉我会做什么、等我同意。
```

AI 会按技能里写好的流程走：

1. 运行 `doctor` 看当前状态
2. 运行不带 `--yes` 的 `install`，把版本、大小、下载来源告诉你，**等你同意**后再安装
3. 问你用的是哪个 AI 工具，同样**等你同意**后运行 `setup-agent`
4. 登录平台：
   - 涂鸦只需要用户代码，AI 可以直接帮你生成二维码，你用 App 扫码
   - 米家、美的、易微联、华为要输入账号密码，AI 会请你**在自己的终端里**运行对应的 `npx -y feyagate auth …` 命令。不要把密码发到聊天里
5. 提醒你重启 AI 工具

如果你的 AI 工具不支持 MCP 也没关系，AI 可以用 `npx -y feyagate call <工具名> '<参数>'` 直接调用。

---

## 升级、回滚、卸载

```bash
npx -y feyagate upgrade --check     # 只检查，不下载
npx -y feyagate upgrade --yes       # 升级引擎
npx -y feyagate@latest upgrade --yes  # 检查提示有新版 CLI 时，用最新 CLI 升级
npx -y feyagate rollback            # 切回上一个版本
npx -y feyagate uninstall --yes     # 卸载；加 --keep-data 保留登录状态和授权
```

升级时新版本装在旧版本旁边，启动并通过健康检查后才切换；失败会自动回到旧版本。

其他常用命令：`doctor`、`status`、`start`、`stop`、`restart`、`logs`、`tools`。完整用法看 `npx -y feyagate help`。

## 常见问题

- **下载很慢或失败**：GitHub 不通时会自动换备用源。也可以先手动下载安装包，再运行 `install --yes --local <文件路径>`（同样会校验 SHA-256），或用 `--mirror <镜像地址>`。
- **端口被占用**：默认 38080，被占时自动顺延到 38081、38082……AI 工具通过 `npx -y feyagate mcp` 连接，会自动找到实际端口，不用改配置。
- **AI 里看不到设备工具**：运行 `npx -y feyagate doctor`，按提示安装或启动引擎，然后重启 AI 工具。
- **提示 `capability_denied`**：该平台的免费试用期已过，运行 `npx -y feyagate call license/status` 查看授权状态。

## 安全说明

- 引擎只监听 `127.0.0.1`，没有鉴权，同一台电脑上的程序都能访问它。
- 只安装 SHA-256 与 npm 包内置清单一致的引擎；不一致的下载会被删除。
- 安装、升级、卸载、修改 AI 工具配置都必须加 `--yes`，否则只打印计划。
- 账号密码只在你自己的终端里输入，不能作为命令参数，也不经过 AI 对话。
- 文件位置：引擎和数据在 `~/.feyagate-mcp/`（可用 `FEYAGATE_HOME` 修改）。会联网访问 github.com、你登录的各家云平台，以及 www.feyagate.com（授权与试用校验）。

## 开发

```bash
npm install
npm test              # 编译 + 单元测试（使用假引擎，不联网）
npm run manifest      # 从 GitHub Releases 重新生成内置引擎清单
npm run pack:skill    # Agensi 发布前检查 + 生成 dist/feyagate-skill-<版本>.zip
npm publish           # 发布前会自动跑测试
```

旧版 Python 包（`pip install feyagate-skill`，1.3.x）在 [toddpan/feyagate-skill](https://github.com/toddpan/feyagate-skill)，使用 `~/.feyagate` 目录，与本包互不影响。

---

<a id="english"></a>

## English

Requires Node.js 20.16+ on macOS, Linux (x64/arm64) or Windows x64.

**Install it yourself**

```bash
npx -y feyagate install --yes                 # download, sha256-verify and start the engine
npx -y feyagate setup-agent claude --yes      # or cursor / codex / windsurf / gemini / dsh / openclaw
npx -y feyagate auth tuya --user-code <CODE>  # or: auth xiaomi | midea | ewelink | huawei
```

Restart your AI tool, then ask it to "list my devices".

**Let your AI agent install it.** Send this to an agent that can run shell commands:

```text
Read https://unpkg.com/feyagate/skill/SKILL.md and install FeyaGate on my machine following it.
Start with npx -y feyagate doctor --json, and ask me before installing the engine or changing my AI tool's config.
```

The agent shows you the install plan and waits for your OK before running anything with `--yes`. For password-based logins (Xiaomi, Midea, eWeLink, Huawei), it asks you to run `npx -y feyagate auth <platform>` in your own terminal. Never paste passwords into the chat.

Upgrades keep the old version on disk and roll back automatically if the new one fails its health check. Run `npx -y feyagate help` for every command.

## License

MIT
