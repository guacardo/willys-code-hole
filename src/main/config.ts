import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HoleConfig, Layout } from '../shared/types'

export const configDir = join(homedir(), '.config', 'willys-code-hole')
const legacyDir = join(homedir(), '.config', 'willys-code-closet')
if (!existsSync(configDir) && existsSync(legacyDir)) renameSync(legacyDir, configDir)

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(join(configDir, file), 'utf8')) as T) }
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, file), JSON.stringify(value, null, 2) + '\n')
}

const defaults: HoleConfig = {
  defaultCwd: join(homedir(), 'AIOS'),
  defaultPermissionMode: 'auto',
}

export const loadConfig = () => readJson<HoleConfig>('config.json', defaults)
export const saveConfig = (cfg: HoleConfig) => writeJson('config.json', cfg)

export const loadLayout = () => readJson<Layout>('tabs.json', { tabs: [], groups: [] })
export const saveLayout = (layout: Layout) => writeJson('tabs.json', layout)
