import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { LedgerRun } from '../../shared/types'
import { configDir } from '../config'
import { reworkScore } from './signals'

const dir = join(configDir, 'ledger')

const fileFor = (repo: string) => join(dir, `${basename(repo)}-${createHash('sha1').update(repo).digest('hex').slice(0, 6)}.jsonl`)

export function appendRun(run: LedgerRun) {
  mkdirSync(dir, { recursive: true })
  appendFileSync(fileFor(run.repo), JSON.stringify(run) + '\n')
}

export function readRuns(repo: string): LedgerRun[] {
  try {
    return readFileSync(fileFor(repo), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerRun)
  } catch {
    return []
  }
}

export const trendOf = (runs: LedgerRun[]) =>
  runs.slice(-30).map((r) => ({ at: r.at, work: r.work, reworkScore: reworkScore(r.signals), costUsd: r.usage?.costUsd }))
