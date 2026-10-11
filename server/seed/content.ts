// Finds and reads content/sequences/*.md. Owned by the content builder.
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSequenceMarkdown, SequenceParseError, type ParsedSequence } from './parse.ts'

export interface SequenceFile {
  /** File name only, for messages and tests. */
  file: string
  text: string
  parsed: ParsedSequence
}

/**
 * The content/sequences folder. Works from the repo root (dev, tests, `npm run seed`) and from
 * dist/server/server/seed (production build).
 */
export function findContentDir(): string {
  const candidates = [
    resolve(process.cwd(), 'content', 'sequences'),
    fileURLToPath(new URL('../../content/sequences', import.meta.url)),
    fileURLToPath(new URL('../../../../content/sequences', import.meta.url)),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error('content/sequences folder not found')
}

/** Read and parse every .md file in the folder, sorted by file name. A bad file names itself. */
export async function loadSequenceFiles(dir: string = findContentDir()): Promise<SequenceFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort()
  const out: SequenceFile[] = []
  for (const file of names) {
    const text = await readFile(join(dir, file), 'utf8')
    try {
      out.push({ file, text, parsed: parseSequenceMarkdown(text) })
    } catch (err) {
      const msg = err instanceof SequenceParseError ? err.message : String(err)
      throw new SequenceParseError(`${file}: ${msg}`)
    }
  }
  return out
}
