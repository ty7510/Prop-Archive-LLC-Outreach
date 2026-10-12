// `npm run seed`: apply migrations, run the seed, print the result, exit.
import 'dotenv/config'
import { assertDatabaseReady, getDb } from '../db/client.ts'
import { seed } from './index.ts'

const db = getDb()
await assertDatabaseReady(db)
const result = await seed(db)
console.log('seed:', JSON.stringify(result))
process.exit(0)
