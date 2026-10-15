#!/usr/bin/env node
/**
 * Build the Agensi upload: dist/feyagate-skill-<version>.zip containing only
 * the skill folder (SKILL.md + references/). No scripts or binaries go into
 * the marketplace package; the installer lives in the npm package.
 *
 * Also runs the pre-flight checks Agensi's scanner applies, so a rejection
 * shows up here instead of after a 24-48h review.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const skillDir = join(root, 'skill')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else files.push(p)
  }
}
walk(skillDir)

const problems = []
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
const front = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? ''
for (const key of ['name', 'description', 'version', 'author']) {
  if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(front)) problems.push(`SKILL.md frontmatter missing ${key}`)
}
if (!new RegExp(`^version:\\s*${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(front)) problems.push(`SKILL.md version != package.json ${version}`)
const patterns = [
  [/\b(npm|ghp|gho|github_pat|sk|xox[bp])_[A-Za-z0-9_]{16,}/, 'possible secret token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/curl[^\n|]*\|\s*(ba|z)?sh\b/, 'curl | sh'],
  [/rm\s+-rf\s+(\/|~|\$HOME|\*)/, 'dangerous rm -rf'],
]
for (const file of files) {
  const rel = relative(skillDir, file)
  if (/(^|\/)\.(DS_Store|env)|\.(sh|py|js|mjs|exe|bin|zip)$/.test(rel)) problems.push(`unexpected file type: ${rel}`)
  const text = readFileSync(file, 'utf8')
  for (const [re, label] of patterns) if (re.test(text)) problems.push(`${rel}: ${label}`)
}
if (problems.length > 0) {
  console.error('Pre-flight failed:\n  ' + problems.join('\n  '))
  process.exit(1)
}

const outDir = join(root, 'dist')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, `feyagate-skill-${version}.zip`)
rmSync(out, { force: true })
// Zip root is the "feyagate/" folder, the layout skill hosts expect.
const stage = join(outDir, 'feyagate')
rmSync(stage, { recursive: true, force: true })
cpSync(skillDir, stage, { recursive: true })
execFileSync('zip', ['-r', '-X', '-q', out, 'feyagate'], { cwd: outDir, stdio: 'inherit' })
rmSync(join(outDir, 'feyagate'), { recursive: true, force: true })
console.log(`Pre-flight OK (${files.length} files) → ${out}`)
