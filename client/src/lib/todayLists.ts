// Today's to-do list sorted into one list per kind of step (Theo, 2026-10-19: "toggle between the
// prints and the linkedin messages", plus emails), so he can do all of one kind in a row.
import type { TodoPerson, TodoStep } from '@shared/types'

export const TODAY_TABS = ['linkedin', 'printouts', 'emails', 'people'] as const
export type TodayTab = (typeof TODAY_TABS)[number]

export function isTodayTab(v: unknown): v is TodayTab {
  return typeof v === 'string' && (TODAY_TABS as readonly string[]).includes(v)
}

/** One waiting step and the person it is for. */
export interface TodayItem {
  person: TodoPerson
  step: TodoStep
}

export interface TodayLists {
  linkedin: TodayItem[]
  /** Printouts, and old 4x6 postcards on cards made before printouts. */
  printouts: TodayItem[]
  emails: TodayItem[]
  /** On the list with no LinkedIn note at all because the app could not find them. */
  noLinkedIn: TodoPerson[]
  /** How many people on the list have no email to send (most have no address on file). */
  noEmail: number
}

export function todayLists(people: TodoPerson[]): TodayLists {
  const waiting = (channel: TodoStep['channel']): TodayItem[] =>
    people.flatMap((person) =>
      person.steps
        .filter((step) => step.status === 'waiting' && step.channel === channel)
        .map((step) => ({ person, step })),
    )
  return {
    linkedin: waiting('linkedin'),
    printouts: waiting('mail'),
    emails: waiting('email'),
    noLinkedIn: people.filter(
      (p) => p.linkedin_missing === 'not_found' && !p.steps.some((s) => s.channel === 'linkedin'),
    ),
    noEmail: people.filter((p) => !p.steps.some((s) => s.channel === 'email')).length,
  }
}
