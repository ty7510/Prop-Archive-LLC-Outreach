// "Start sequence" picks a sequence by persona from settings.sequence_by_persona (spec section 12).
// Pure so it is easy to test. Channel order follows the autopilot's enroll rule: email first.
import type { Channel } from '@shared/types'
import type { Settings } from '@shared/settings'
import type { Lead, Sequence } from '../types.ts'

export const CHANNEL_ORDER: Channel[] = ['email', 'mail', 'linkedin', 'instagram', 'call']

export interface SequencePick {
  lead: Lead
  channel: Channel | null
  sequence: Sequence | null
  /** Why nothing was picked, in plain words. Empty when a sequence was found. */
  reason: string
}

type PickSettings = Pick<Settings, 'sequence_by_persona' | 'channels'> &
  Partial<Pick<Settings, 'main_sequence_id'>>

/**
 * Pick the first enabled channel the lead can use that has a sequence for the lead's persona.
 * When the lead has no usable channel yet (not enriched), fall back to the first enabled channel
 * with a sequence so Theo can still start outreach by hand.
 */
export function pickSequence(
  lead: Lead,
  settings: PickSettings,
  sequences: Sequence[],
): SequencePick {
  if (lead.do_not_contact) {
    return { lead, channel: null, sequence: null, reason: 'Marked do not contact' }
  }
  // One main sequence for everyone (email, then LinkedIn, then mail) wins when it is on.
  const main = settings.main_sequence_id
    ? sequences.find((s) => s.id === settings.main_sequence_id && s.active)
    : undefined
  if (main)
    return { lead, channel: main.steps[0]?.channel ?? main.channel, sequence: main, reason: '' }
  if (lead.persona === 'unknown') {
    return { lead, channel: null, sequence: null, reason: 'Persona unknown (no property count)' }
  }
  const byChannel = settings.sequence_by_persona[lead.persona]
  const byId = new Map(sequences.map((s) => [s.id, s]))

  const candidates = CHANNEL_ORDER.filter((ch) => settings.channels[ch] && byChannel[ch])
  if (candidates.length === 0) {
    return {
      lead,
      channel: null,
      sequence: null,
      reason: 'No sequence set for this persona in Settings',
    }
  }
  const usable = candidates.filter((ch) => lead.channels[ch])
  const chosen = usable[0] ?? candidates[0]
  if (!chosen) {
    return { lead, channel: null, sequence: null, reason: 'No channel available' }
  }
  const id = byChannel[chosen]
  const sequence = id ? (byId.get(id) ?? null) : null
  if (!sequence) {
    return {
      lead,
      channel: chosen,
      sequence: null,
      reason: 'The sequence set in Settings no longer exists',
    }
  }
  return { lead, channel: chosen, sequence, reason: '' }
}
