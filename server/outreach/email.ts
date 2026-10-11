// Email sending: SMTP (nodemailer) or Resend (HTTP). Builds the CAN-SPAM headers. (spec section 10)
import type { Settings } from '../../shared/settings.ts'
import type { OutgoingMail, OutreachDeps } from './deps.ts'

export type EmailProvider = 'smtp' | 'resend'

export interface EmailSendResult {
  provider: EmailProvider
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

export const EMAIL_KEYS_HINT = 'add SMTP_HOST, SMTP_USER and SMTP_PASS or RESEND_API_KEY in .env'

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
  unsubscribeUrl: string
}

/** From, Reply-To and the one-click unsubscribe headers. */
export function buildMail(settings: Settings, input: EmailInput): OutgoingMail {
  const from = `${settings.from_name} <${settings.from_email}>`
  return {
    from,
    to: input.to,
    replyTo: settings.reply_to || settings.from_email,
    subject: input.subject,
    text: input.text,
    html: textToHtml(input.text),
    headers: {
      'List-Unsubscribe': `<mailto:${settings.reply_to || settings.from_email}?subject=unsubscribe>, <${input.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

/** Send one email through the configured provider. Throws when nothing is configured or the provider fails. */
export async function sendEmail(
  deps: OutreachDeps,
  settings: Settings,
  input: EmailInput,
): Promise<EmailSendResult> {
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
      headers: mail.headers,
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
