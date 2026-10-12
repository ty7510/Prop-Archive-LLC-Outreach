import { afterAll } from 'vitest'
import { closeTestDbs } from './testing.ts'
afterAll(async () => {
  await closeTestDbs()
})
