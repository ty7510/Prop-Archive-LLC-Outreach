// Channel icons: lit when the lead can be reached that way, grey when not.
// lucide 1.x ships no brand marks, so LinkedIn is a briefcase and Instagram a camera.
import { Mail, MailOpen, Briefcase, Camera, Phone } from 'lucide-react'
import clsx from 'clsx'
import type { Channel, LeadChannels } from '@shared/types'
import { CHANNEL_LABEL } from '../lib/format.ts'

export const CHANNEL_ICON: Record<Channel, typeof Mail> = {
  email: Mail,
  mail: MailOpen,
  linkedin: Briefcase,
  instagram: Camera,
  call: Phone,
}

export function ChannelIcon({ channel, className }: { channel: Channel; className?: string }) {
  const Icon = CHANNEL_ICON[channel]
  return <Icon className={clsx('h-5 w-5', className)} aria-hidden />
}

const ORDER: Channel[] = ['email', 'mail', 'linkedin', 'instagram', 'call']

export default function ChannelIcons({ channels }: { channels: LeadChannels }) {
  const lit = ORDER.filter((c) => channels[c])
  return (
    <span
      className="inline-flex items-center gap-1.5"
      aria-label={
        lit.length
          ? `Reachable by ${lit.map((c) => CHANNEL_LABEL[c]).join(', ')}`
          : 'No channel yet'
      }
    >
      {ORDER.map((c) => {
        const Icon = CHANNEL_ICON[c]
        const on = channels[c]
        return (
          <Icon
            key={c}
            className={clsx('h-5 w-5', on ? 'text-emerald-600' : 'text-stone-300')}
            aria-hidden
            // title shows on hover for mouse users
            {...{ title: `${CHANNEL_LABEL[c]}: ${on ? 'yes' : 'no'}` }}
          />
        )
      })}
    </span>
  )
}
