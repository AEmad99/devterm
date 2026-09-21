import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'

const MAX_SKILL_BYTES = 512 * 1024

export function personalSkillDirs(): string[] {
  const dirs = [join(homedir(), 'DevTerm', 'skills')]
  try {
    dirs.unshift(join(app.getPath('userData'), 'skills'))
  } catch {
    /* tests without app ready */
  }
  return dirs
}

/** Instruction-only markdown skills from the operator's skills folders. */
export function listPersonalMarkdownSkills(): string[] {
  const out: string[] = []
  for (const dir of personalSkillDirs()) {
    if (!existsSync(dir)) continue
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.md')) continue
      const path = join(dir, name)
      try {
        const st = statSync(path)
        if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue
        out.push(path)
      } catch {
        /* skip */
      }
    }
  }
  return out
}

export function skillDigest(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}
