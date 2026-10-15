#!/usr/bin/env node
// Fake miloco-mcp-server for tests: reads server.http_port from --config and
// answers /health + a tiny MCP surface. FAKE_MODE=crash exits immediately.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

if (process.env.FAKE_MODE === 'crash' || process.argv[1].includes('9.9.9')) process.exit(1)
const config = readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8')
const port = Number(/http_port:\s*(\d+)/.exec(config)[1])
createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ status: 'ok' }))
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const msg = JSON.parse(body || '{}')
    res.setHeader('Content-Type', 'application/json')
    if (msg.method === 'tools/list') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'auth/platforms', inputSchema: {} }] } }))
    if (msg.method === 'initialize') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }))
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '[]' }] } }))
  })
}).listen(port, '127.0.0.1')
