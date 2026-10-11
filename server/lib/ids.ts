import { ulid } from 'ulid'

/** A new sortable id. Every table uses these as text primary keys. */
export function newId(): string {
  return ulid()
}

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

export function isUlid(value: string): boolean {
  return ULID_RE.test(value)
}
