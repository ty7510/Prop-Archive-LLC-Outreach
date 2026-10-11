// `npm run seed`: apply migrations, run the seed, print the result, exit.
import 'dotenv/config'
import { applyMigrations, getDb } from '../db/client.ts'
import { seed } from './index.ts'

const db = getDb()
await applyMigrations(db)
const result = await seed(db)
console.log('seed:', JSON.stringify(result))
process.exit(0)
