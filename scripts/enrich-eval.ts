// How well does web research find the RIGHT contact info? Runs claude_research on a few leads that
// have rental properties and prints, per field, how many came back verified, likely or rejected.
// Reads the database, writes nothing. Each lead costs one research call (about 30 web searches).
//
//   npm run enrich:eval -- --yes            (10 leads)
//   npm run enrich:eval -- --yes --limit 25
//
// Needs ANTHROPIC_API_KEY (or Claude_API) and DATABASE_URL, so run it in the Replit shell.
import 'dotenv/config'
import { desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '../server/db/client.ts'
import { leads, properties } from '../server/db/schema.ts'
import {
  createClaudeResearchProvider,
  type ResearchRaw,
} from '../server/enrich/providers/claudeResearch.ts'
import { CONTACT_FIELDS } from '../server/enrich/verify.ts'
import { env } from '../server/env.ts'
import { getSettings } from '../server/lib/settings.ts'

const args = process.argv.slice(2)
const limitAt = args.indexOf('--limit')
const limit = limitAt >= 0 ? Math.max(1, Number(args[limitAt + 1]) || 10) : 10

if (!args.includes('--yes')) {
  console.log(`This runs ${limit} research calls (about $0.50 each). Add --yes to go ahead.`)
  process.exit(0)
}
if (!env.ANTHROPIC_API_KEY) {
  console.log('No Claude key: set Claude_API (or ANTHROPIC_API_KEY) first.')
  process.exit(1)
}

const db = getDb()
const settings = await getSettings(db)
const provider = createClaudeResearchProvider()
const sample = await db
  .select()
  .from(leads)
  .where(inArray(leads.status, ['new', 'enriched', 'enrolled']))
  .orderBy(desc(leads.icp_score))
  .limit(limit)

type Tally = Record<string, { verified: number; likely: number; rejected: number; manager: number }>
const tally: Tally = Object.fromEntries(
  CONTACT_FIELDS.map((f) => [f, { verified: 0, likely: 0, rejected: 0, manager: 0 }]),
)
let leadsWithOwnerContact = 0

for (const lead of sample) {
  const owned = await db.select().from(properties).where(eq(properties.lead_id, lead.id))
  try {
    const result = await provider.enrich(lead, {
      env,
      settings,
      properties: owned,
      now: new Date(),
      log: async () => {},
    })
    const raw = result.raw as ResearchRaw | null
    const checked = raw?.checked ?? []
    let ownerHit = false
    for (const c of checked) {
      const t = tally[c.field]
      if (!t) continue
      if (c.role !== 'owner' && c.verdict !== 'rejected') t.manager++
      else t[c.verdict]++
      if (c.role === 'owner' && c.verdict !== 'rejected') ownerHit = true
    }
    if (ownerHit) leadsWithOwnerContact++
    console.log(
      `${lead.full_name ?? lead.company ?? lead.id}: ${
        checked
          .filter((c) => c.verdict !== 'rejected')
          .map((c) => `${c.field}(${c.role}, ${c.verdict})`)
          .join(', ') || 'nothing verified'
      }`,
    )
  } catch (err) {
    console.log(`${lead.full_name ?? lead.id}: failed: ${err instanceof Error ? err.message : err}`)
  }
}

console.log(`\n${leadsWithOwnerContact} of ${sample.length} leads got at least one owner contact.`)
console.log('field          verified  likely  rejected  manager/agent')
for (const f of CONTACT_FIELDS) {
  const t = tally[f]!
  console.log(
    `${f.padEnd(14)} ${String(t.verified).padStart(8)} ${String(t.likely).padStart(7)} ${String(t.rejected).padStart(9)} ${String(t.manager).padStart(14)}`,
  )
}
process.exit(0)
