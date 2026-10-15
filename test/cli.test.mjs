import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseArgs } from '../lib/cli.js'
import { normalizeState } from '../lib/state.js'
import { repairToolsList, StdioBridge } from '../lib/bridge.js'
import { activate, createContext, doctor, ensureRunning, planInstall, prune, rollback } from '../lib/engine.js'
import { stopEngine } from '../lib/supervise/process.js'
import { binaryName, detectPlatformTag } from '../lib/util/platform.js'

const here = dirname(fileURLToPath(import.meta.url))
const quiet = { info() {}, warn() {}, error() {} }
const isWin = process.platform === 'win32'

function fakeVersion(root, version) {
  const dir = join(root, 'versions', version)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, binaryName(detectPlatformTag()))
  copyFileSync(join(here, 'fixtures', 'fake-engine.mjs'), target)
  chmodSync(target, 0o755)
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'feyagate-test-'))
}

test('parseArgs: booleans, values, -y alias', () => {
  const a = parseArgs(['install', '--yes', '--version', '1.2.20', '--json'])
  assert.deepEqual(a.positionals, ['install'])
  assert.equal(a.flags.yes, true)
  assert.equal(a.flags.version, '1.2.20')
  assert.equal(parseArgs(['upgrade', '-y']).flags.yes, true)
  assert.equal(parseArgs(['logs', '-n', '20']).flags.n, '20')
})

test('normalizeState drops garbage and keeps valid fields', () => {
  const s = normalizeState({ currentVersion: ' 1.2.21 ', port: 99999, pending: { version: '1.2.22' }, junk: 1 })
  assert.equal(s.currentVersion, '1.2.21')
  assert.equal(s.port, 38080)
  assert.equal(s.pending.version, '1.2.22')
  assert.equal('junk' in s, false)
})

test('repairToolsList turns {} schemas into object schemas', () => {
  const r = repairToolsList({ tools: [{ name: 'a', inputSchema: {} }, { name: 'b' }] })
  for (const t of r.tools) assert.deepEqual(t.inputSchema, { type: 'object', properties: {} })
})

test('planInstall pins sha256 from the bundled manifest and never downloads', () => {
  const root = tempRoot()
  const plan = planInstall(createContext(root, quiet))
  assert.equal(plan.action, 'install')
  assert.match(plan.asset.url, /^https:\/\/github\.com\/toddpan\/miloco-mcp-server-releases\//)
  assert.match(plan.asset.sha256 ?? '', /^[0-9a-f]{64}$/)
  rmSync(root, { recursive: true, force: true })
})

test('doctor reports install when nothing is installed', async () => {
  const root = tempRoot()
  const report = await doctor(root, quiet)
  assert.equal(report.nextAction, 'install')
  assert.equal(report.ready, false)
  rmSync(root, { recursive: true, force: true })
})

test('bridge serves a setup tool when the engine is absent', async () => {
  const root = tempRoot()
  const bridge = new StdioBridge(root, () => {})
  assert.equal(await bridge.connect(), false)
  const init = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(init.result.capabilities.tools.listChanged, true)
  const list = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual(list.result.tools.map((t) => t.name), ['feyagate_setup_status'])
  const call = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'feyagate_setup_status' } })
  assert.match(call.result.content[0].text, /install --yes/)
  rmSync(root, { recursive: true, force: true })
})

test('activation handshake: healthy start, failed upgrade rolls back, rollback, prune', { skip: isWin }, async () => {
  const root = tempRoot()
  const ctx = createContext(root, quiet)
  ctx.state.patch({ port: 39180 + Math.floor(Math.random() * 500) })
  try {
    fakeVersion(root, '1.0.0')
    fakeVersion(root, '1.0.1')
    fakeVersion(root, '9.9.9') // crashes on start

    const first = await activate(ctx, '1.0.0')
    assert.equal(first.ok, true)
    assert.equal(ctx.state.get().lastKnownGood, '1.0.0')

    const up = await activate(ctx, '1.0.1')
    assert.equal(up.ok, true)
    assert.equal(ctx.state.get().currentVersion, '1.0.1')

    const bad = await activate(ctx, '9.9.9')
    assert.equal(bad.ok, false)
    assert.equal(bad.rolledBackTo, '1.0.1')
    const after = ctx.state.get()
    assert.equal(after.currentVersion, '1.0.1')
    assert.equal(after.pending, null)

    // Bridge proxies the live engine and repairs its schema + capability.
    const bridge = new StdioBridge(root, () => {})
    assert.equal(await bridge.connect(), true)
    const init = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    assert.equal(init.result.capabilities.tools.listChanged, true)
    const list = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.deepEqual(list.result.tools[0].inputSchema, { type: 'object', properties: {} })

    const back = await rollback(ctx, '1.0.0')
    assert.equal(back.ok, true)
    assert.equal(ctx.state.get().currentVersion, '1.0.0')

    // A leftover pending entry (crash mid-activation) is rolled back on start.
    await stopEngine(root)
    ctx.state.patch({ pending: { version: '9.9.9', startedAt: Date.now() }, currentVersion: '9.9.9' })
    const recovered = await ensureRunning(ctx)
    assert.equal(recovered.healthy, true)
    assert.equal(recovered.rolledBack, '1.0.0')
    assert.equal(ctx.state.get().currentVersion, '1.0.0')

    const removed = prune(ctx, 1)
    assert.ok(!removed.includes('1.0.0'))
  } finally {
    await stopEngine(root)
    rmSync(root, { recursive: true, force: true })
  }
})

test('setup-agent writes only the feyagate entry and backs up the file', async () => {
  const home = tempRoot()
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    const { setupAgent, removeAgent } = await import('../lib/agents.js')
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    assert.throws(() => setupAgent('cursor', { apply: false }), (e) => e.exitCode === 3)
    setupAgent('cursor', { apply: true })
    const doc = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'))
    assert.equal(doc.mcpServers.other.command, 'x')
    assert.deepEqual(doc.mcpServers.feyagate.args, ['-y', 'feyagate', 'mcp'])
    assert.ok(readFileSync(join(home, '.cursor', 'skills', 'feyagate', 'SKILL.md'), 'utf8').includes('name: feyagate'))
    readFileSync(join(home, '.cursor', 'mcp.json.feyagate.bak'), 'utf8')

    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n')
    setupAgent('codex', { apply: true, skillOnly: false })
    setupAgent('codex', { apply: true })
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    assert.equal(toml.match(/\[mcp_servers\.feyagate\]/g).length, 1)
    assert.ok(toml.startsWith('model = "x"'))
    removeAgent('codex', true)
    assert.ok(!readFileSync(join(home, '.codex', 'config.toml'), 'utf8').includes('feyagate'))
  } finally {
    process.env.HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})
