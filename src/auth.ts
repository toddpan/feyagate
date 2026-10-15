/**
 * `feyagate auth <platform>` — platform login without a GUI.
 *
 * Credentials are read **in the user's terminal** (hidden input for
 * passwords) and sent only to the local engine on 127.0.0.1, which talks to
 * the vendor cloud. They are never accepted as command-line flags (shell
 * history, process lists) and never pass through the AI conversation. That is
 * why the skill tells the agent to ask the user to run these commands
 * themselves rather than run them on the user's behalf.
 *
 * Tuya is the exception that *can* run inside an agent: it needs only the
 * non-secret "user code" and a QR scan, so the QR is printed to the terminal
 * and also saved as a PNG the agent can show.
 */

import { createInterface } from 'node:readline'
import { join } from 'node:path'

import QRCode from 'qrcode'

import { TUYA_STATUS_LONG_POLL_MS, TUYA_STATUS_POLL_INTERVAL_MS } from './constants.js'
import { EngineClient } from './client.js'
import { CliError } from './engine.js'
import { TUYA_WAITING_MSG_RE, isTuyaToken, tuyaQrPayload } from './tuya-qr.js'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export const PLATFORMS = ['xiaomi', 'tuya', 'midea', 'ewelink', 'huawei'] as const
export type PlatformId = (typeof PLATFORMS)[number]

function requireTty(): void {
  if (!process.stdin.isTTY) {
    throw new CliError('该登录需要在交互式终端中输入账号信息。请让用户在自己的终端里运行此命令（不要把密码发给 AI）', 4)
  }
}

export async function ask(question: string, options: { hidden?: boolean } = {}): Promise<string> {
  requireTty()
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  if (options.hidden === true) {
    // Mute echo: readline writes typed characters through _writeToOutput.
    const anyRl = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream }
    anyRl._writeToOutput = (s: string) => {
      if (s.startsWith(question)) anyRl.output.write(s)
    }
  }
  try {
    return await new Promise<string>((resolve) => rl.question(question, (answer) => resolve(answer.trim())))
  } finally {
    if (options.hidden === true) process.stderr.write('\n')
    rl.close()
  }
}

function failure(payload: unknown, fallback: string): string {
  const r = rec(payload)
  return str(r.message) ?? str(r.error) ?? str(r.msg) ?? fallback
}

export async function authStatus(client: EngineClient): Promise<unknown> {
  return client.callTool('auth/platforms')
}

export async function loginTuya(client: EngineClient, userCode: string, qrPngDir: string, say: (m: string) => void) {
  if (userCode.trim() === '') throw new CliError('缺少涂鸦用户代码：涂鸦/智能生活 App「我的 → 设置 → 账号与安全 → 用户代码」')
  const ticket = rec(await client.callTool('auth/tuya_qr', { user_code: userCode }))
  if (ticket.success !== true) {
    const hint = ticket.code === 'USERCODE_INCORRECT' ? '用户代码不正确，请在涂鸦 App 中核对。' : ''
    throw new CliError(`生成涂鸦二维码失败：${hint}${failure(ticket, '上游未返回二维码')}`)
  }
  const token = str(ticket.token) ?? str(ticket.token_id)
  if (token === null || !isTuyaToken(token)) throw new CliError('上游返回的二维码 token 不可用')
  const payload = tuyaQrPayload(token)
  const png = join(qrPngDir, 'tuya-qr.png')
  await QRCode.toFile(png, payload, { width: 360, margin: 2 })
  say(await QRCode.toString(payload, { type: 'terminal', small: true }))
  say(`用涂鸦/智能生活 App 扫一扫上方二维码并点「确认登录」。二维码图片：${png}`)
  const expire = Number(ticket.expire_time ?? ticket.expire ?? 300) || 300
  const deadline = Date.now() + expire * 1000
  while (Date.now() < deadline) {
    const status = rec(await client.callTool('auth/tuya_qr_status', { token, user_code: userCode }, TUYA_STATUS_LONG_POLL_MS + 10_000))
    const s = str(status.status) ?? (status.success === true ? 'pending' : 'error')
    if (s === 'authorized') return { platform: 'tuya', authenticated: true, uid: str(status.uid), qrImage: png }
    if (s === 'error' || s === 'expired' || s === 'invalid') {
      const msg = str(status.msg)
      // "please scan and try again" is how this endpoint says "not scanned yet".
      if (msg !== null && !TUYA_WAITING_MSG_RE.test(msg)) throw new CliError(`涂鸦授权失败：${msg}`)
    }
    await new Promise((r) => setTimeout(r, TUYA_STATUS_POLL_INTERVAL_MS))
  }
  throw new CliError('二维码已过期，请重新运行 feyagate auth tuya')
}

export async function loginMidea(client: EngineClient) {
  const account = await ask('美的账号（手机号/邮箱）: ')
  const password = await ask('美的密码: ', { hidden: true })
  const cloud = (await ask('云端 [meiju=美的美居 / msmart=MSmartHome]（回车默认 meiju）: ')) || 'meiju'
  if (!['meiju', 'msmart'].includes(cloud)) throw new CliError(`未知云端类型 ${cloud}`)
  const r = rec(await client.callTool('auth/midea_login', { account, password, cloud }))
  if (r.success !== true) throw new CliError(`美的登录失败：${failure(r, '账号或密码不正确')}`)
  return { platform: 'midea', authenticated: true, deviceCount: r.device_count ?? null }
}

export async function loginEwelink(client: EngineClient) {
  const email = await ask('易微联邮箱或手机号: ')
  const password = await ask('易微联密码: ', { hidden: true })
  const countryCode = (await ask('国家代码（回车默认 +86）: ')) || '+86'
  if (!/^\+?\d{1,4}$/.test(countryCode)) throw new CliError(`国家代码格式不正确：${countryCode}`)
  const r = rec(await client.callTool('auth/ewelink_login', { email, password, country_code: countryCode }))
  if (r.success !== true) throw new CliError(`易微联登录失败：${failure(r, '账号或密码不正确，或区域不匹配')}`)
  return { platform: 'ewelink', authenticated: true, deviceCount: r.device_count ?? null }
}

function huaweiOutcome(payload: unknown) {
  const r = rec(payload)
  const s = rec(r.auth_status)
  return {
    success: r.success === true,
    needCode: s.pending_challenge === true || r.pending_challenge === true,
    retryWithoutCode: r.retry_without_code === true || s.retry_without_code === true,
    authenticated: s.authenticated === true || r.authenticated === true,
    message: str(r.message) ?? str(r.hint) ?? str(r.error),
  }
}

export async function loginHuawei(client: EngineClient, say: (m: string) => void) {
  const account = await ask('华为账号（手机号/邮箱）: ')
  const password = await ask('华为账号密码: ', { hidden: true })
  let outcome = huaweiOutcome(await client.callTool('auth/huawei_login', { account, password }))
  for (let attempt = 0; outcome.needCode && attempt < 3; attempt += 1) {
    say('华为不发短信：验证码会弹在已登录同一帐号的华为手机/平板上，或在「设置 → 华为帐号 → 帐号安全」中查看。')
    const code = await ask('双重验证码: ')
    outcome = huaweiOutcome(await client.callTool('auth/huawei_challenge', { code }))
    if (!outcome.success && !outcome.needCode && !outcome.retryWithoutCode) throw new CliError(`验证码不正确：${outcome.message ?? ''}`)
  }
  if (outcome.retryWithoutCode) {
    // The code was accepted; only the token exchange failed. The session is
    // preserved, so asking for another code would waste one.
    return { platform: 'huawei', authenticated: false, sessionPreserved: true, next: '验证码已通过，会话已保留，无需重新输入验证码；稍后运行 feyagate auth status 确认' }
  }
  if (!outcome.success && !outcome.authenticated) throw new CliError(`华为登录失败：${outcome.message ?? '请核对账号与密码'}`)
  return { platform: 'huawei', authenticated: true }
}

export async function loginXiaomi(client: EngineClient, region: string | null, say: (m: string) => void) {
  const r = rec(await client.callTool('xiaomi/auth_url', region === null ? {} : { region }))
  const url = str(r.url)
  if (url === null) throw new CliError(`未获取到米家授权地址：${failure(r, '未知原因')}`)
  say(`在浏览器打开以下地址并用小米账号登录授权：\n\n  ${url}\n`)
  say('授权后浏览器会跳到一个打不开的地址（形如 https://127.0.0.1/?code=...），把地址栏完整内容粘贴到下面。')
  const raw = await ask('回调地址或 code: ')
  const match = /[?&#]code=([^&#\s]+)/.exec(raw)
  const code = match !== null ? decodeURIComponent(match[1] ?? '') : raw.trim()
  if (code === '') throw new CliError('没有找到 code')
  const args: Rec = { code }
  if (region !== null) args.region = region
  const done = rec(await client.callTool('xiaomi/auth_callback', args))
  if (done.success !== true) throw new CliError(`米家授权失败：${failure(done, 'code 无效或已过期，请重新运行')}`)
  return { platform: 'xiaomi', authenticated: true, region: str(done.region) ?? region }
}

export async function logout(client: EngineClient, platform: PlatformId) {
  if (platform === 'xiaomi') return client.rest('/api/v1/platform/xiaomi/logout', { method: 'POST', body: '{}' })
  return client.callTool(`auth/${platform}_logout`)
}
