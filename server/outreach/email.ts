// Email sending: SMTP (nodemailer) or Resend (HTTP). Builds the CAN-SPAM headers. (spec section 10)
import type { SendingInbox, Settings } from '../../shared/settings.ts'
import type { OutgoingMail, OutreachDeps } from './deps.ts'
import { compileMail } from './gmail.ts'
import { googleSignedIn, inboxProvider, resolveMailHost } from './inboxes.ts'

export type EmailProvider = 'smtp' | 'resend'

export interface EmailSendResult {
  /** 'smtp', 'resend', or 'smtp:<inbox email>' for mail sent through a warmed inbox. */
  provider: string
  providerMessageId: string | null
}

/** Which provider will carry email, honouring the setting but falling back to whatever has a key. */
export function pickEmailProvider(deps: OutreachDeps, settings: Settings): EmailProvider | null {
  const hasSmtp = Boolean(deps.smtp)
  const hasResend = Boolean(deps.env.RESEND_API_KEY)
  if (settings.email_provider === 'resend' && hasResend) return 'resend'
  if (settings.email_provider === 'smtp' && hasSmtp) return 'smtp'
  if (hasSmtp) return 'smtp'
  if (hasResend) return 'resend'
  return null
}

export const EMAIL_KEYS_HINT = 'add a sending inbox under Settings > Sending inboxes'

/** A minimal HTML twin of a plain text body: paragraphs and clickable links. */
export function textToHtml(text: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const linkify = (s: string) =>
    s.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`)
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p>${linkify(esc(p)).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#222">${paragraphs}</body></html>`
}

export interface EmailInput {
  to: string
  subject: string
  text: string
  /** Lead mail always has one. Mail to Theo himself (test send, reply notice) has none. */
  unsubscribeUrl?: string | undefined
  /** Set by send.ts from the idempotency key so a duplicate can be spotted on the receiving side. */
  messageId?: string | undefined
}

/**
 * From, Reply-To and, for lead mail, the one-click unsubscribe headers. Mail through a warmed
 * inbox comes from that inbox and replies go back to it, where the reply sync reads them.
 */
export function buildMail(
  settings: Settings,
  input: EmailInput,
  inbox?: SendingInbox | null,
): OutgoingMail {
  const fromEmail = inbox ? inbox.email : settings.from_email
  const fromName = inbox?.from_name || settings.from_name
  const replyTo = inbox ? inbox.email : settings.reply_to || settings.from_email
  const mail: OutgoingMail = {
    from: `${fromName} <${fromEmail}>`,
    to: input.to,
    replyTo,
    subject: input.subject,
    text: input.text,
    html: textToHtml(input.text),
  }
  if (input.unsubscribeUrl) {
    mail.headers = {
      'List-Unsubscribe': `<mailto:${replyTo}?subject=unsubscribe>, <${input.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    }
  }
  if (input.messageId) mail.messageId = input.messageId
  return mail
}

/**
 * Send one email. With an inbox it goes through that inbox's SMTP login; otherwise through the
 * configured provider. Throws when nothing is configured or the provider fails.
 */
export async function sendEmail(
  deps: OutreachDeps,
  settings: Settings,
  input: EmailInput,
  inbox?: SendingInbox | null,
): Promise<EmailSendResult> {
  if (inbox && googleSignedIn(inbox)) {
    // Sign in with Google: the same message, sent through Gmail's API as the signed-in account.
    const mail = buildMail(settings, input, inbox)
    const sent = await deps.gmail.send(await compileMail(mail))
    // The Message-ID it really went out with is what replies quote, so that is what we keep.
    return {
      provider: inboxProvider(inbox),
      providerMessageId: sent.messageId ?? mail.messageId ?? null,
    }
  }
  if (inbox) {
    const host = await resolveMailHost(deps, inbox.smtp_host)
    if (!host.ok) throw new Error(`Inbox ${inbox.email}: ${host.problem}`)
    const info = await deps
      .smtpForInbox(inbox, host.address)
      .sendMail(buildMail(settings, input, inbox))
    return { provider: inboxProvider(inbox), providerMessageId: info.messageId ?? null }
  }
  const provider = pickEmailProvider(deps, settings)
  if (!provider) throw new Error(`No email provider: ${EMAIL_KEYS_HINT}`)
  const mail = buildMail(settings, input)
  if (provider === 'smtp') {
    if (!deps.smtp) throw new Error('SMTP is not configured')
    const info = await deps.smtp().sendMail(mail)
    return { provider, providerMessageId: info.messageId ?? null }
  }
  return sendViaResend(deps, mail)
}

async function sendViaResend(deps: OutreachDeps, mail: OutgoingMail): Promise<EmailSendResult> {
  const res = await deps.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deps.env.RESEND_API_KEY ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: mail.from,
      to: [mail.to],
      reply_to: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.headers ? { headers: mail.headers } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string }
  return { provider: 'resend', providerMessageId: json.id ?? null }
}
