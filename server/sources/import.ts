// CSV import: parse, map headers, upsert each row, record the import. Owned by the sources builder.
import type { ImportResult } from '../../shared/types.ts'
import { getDb, type Db } from '../db/client.ts'
import { imports } from '../db/schema.ts'
import { logActivity } from '../lib/activity.ts'
import { badRequest } from '../lib/http.ts'
import { newId } from '../lib/ids.ts'
import { getSettings } from '../lib/settings.ts'
import { nowIso } from '../lib/time.ts'
import { parseCsv, rowToCandidate, type ParsedCsv } from './csv.ts'
import { upsertCandidate } from './upsert.ts'

export const MAX_IMPORT_ROWS = 20_000

export interface ImportDeps {
  db?: Db
  now?: () => Date
}

/** Parse the file or throw a 400 that says what is wrong in plain words. */
export function parseCsvOr400(buffer: Buffer, filename: string): ParsedCsv {
  if (buffer.length === 0) throw badRequest('That file is empty', 'EMPTY_FILE')
  let parsed: ParsedCsv
  try {
    parsed = parseCsv(buffer)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw badRequest(`Could not read ${filename} as CSV: ${message}`, 'BAD_CSV')
  }
  if (parsed.headers.length === 0) {
    throw badRequest('The first line must be the column names', 'NO_HEADER')
  }
  const mappedCount = Object.keys(parsed.mapping.mapped).length
  if (mappedCount === 0) {
    throw badRequest(
      `None of the columns were recognised (${parsed.headers.join(', ')}). ` +
        'Use names like Name, Email, Phone, Company, Address, City, State, Zip.',
      'NO_KNOWN_COLUMNS',
    )
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw badRequest(
      `Too many rows. Split the file below ${MAX_IMPORT_ROWS} rows.`,
      'TOO_MANY_ROWS',
    )
  }
  return parsed
}

/** Import one CSV file. Merges by dedupe key; never overwrites a filled field with an empty one. */
export async function importCsv(
  buffer: Buffer,
  filename: string,
  deps: ImportDeps = {},
): Promise<ImportResult> {
  const db = deps.db ?? getDb()
  const now = deps.now ?? (() => new Date())
  const parsed = parseCsvOr400(buffer, filename)
  const settings = await getSettings(db)

  const errors: string[] = []
  if (parsed.mapping.unmapped.length > 0) {
    errors.push(`Columns not used: ${parsed.mapping.unmapped.join(', ')}`)
  }
  const fileNote = `Imported from ${filename}`
  const result: ImportResult = {
    import_id: newId(),
    filename,
    row_count: parsed.rows.length,
    created: 0,
    merged: 0,
    skipped: 0,
    errors,
  }

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i]
    if (!row) continue
    const lineNo = i + 2 // header is line 1
    try {
      const r = await upsertCandidate(rowToCandidate(row, parsed.mapping, fileNote), {
        db,
        settings,
        now: now(),
      })
      result[r.outcome]++
      if (r.outcome === 'skipped')
        errors.push(`Line ${lineNo}: skipped, ${r.reason ?? 'not usable'}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.skipped++
      errors.push(`Line ${lineNo}: ${message}`)
    }
  }

  await db.insert(imports).values({
    id: result.import_id,
    kind: 'csv',
    filename,
    row_count: result.row_count,
    created: result.created,
    merged: result.merged,
    skipped: result.skipped,
    at: nowIso(),
    errors: result.errors,
  })
  await logActivity(
    'info',
    'import.csv',
    {
      filename,
      row_count: result.row_count,
      created: result.created,
      merged: result.merged,
      skipped: result.skipped,
    },
    null,
    db,
  )
  return result
}
