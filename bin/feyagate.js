#!/usr/bin/env node
import { main } from '../lib/cli.js'

const code = await main(process.argv.slice(2))
// The stdio MCP bridge keeps running until stdin closes; everything else exits.
process.exitCode = code
