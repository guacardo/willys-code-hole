import { exec } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GateResult } from '../../shared/types'
import { failureKinds } from './signals'

const LINTABLE = /\.(m|c)?(t|j)sx?$/

/** Deterministic checks for a repo: its typecheck script (or tsc), plus eslint on the files this turn edited. */
export function gateCommands(root: string, edited: string[], override?: string): string[] {
  if (override) return [override]
  const cmds: string[] = []
  let scripts: Record<string, string> = {}
  try {
    scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
  } catch {
    return cmds
  }
  if (scripts.typecheck) cmds.push('npm run -s typecheck')
  else if (existsSync(join(root, 'tsconfig.json')) && existsSync(join(root, 'node_modules/.bin/tsc'))) {
    const refs = /"references"\s*:/.test(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
    cmds.push(refs ? 'npx tsc -b' : 'npx tsc --noEmit')
  }
  const lintable = edited.filter((f) => LINTABLE.test(f) && f.startsWith(root) && existsSync(f))
  const hasEslint = existsSync(join(root, 'node_modules/.bin/eslint')) && ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc.cjs'].some((f) => existsSync(join(root, f)))
  if (hasEslint && lintable.length) cmds.push(`npx eslint ${lintable.map((f) => JSON.stringify(f)).join(' ')}`)
  return cmds
}

export function runGate(root: string, command: string): Promise<GateResult> {
  return new Promise((resolve) => {
    exec(command, { cwd: root, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim()
      resolve({ command, ok: !err, kinds: err ? failureKinds(output) : {}, output: output.slice(-6000) })
    })
  })
}
