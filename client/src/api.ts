// Typed fetch helpers. Every call goes through api() so errors look the same everywhere.
import type {
  ActivityEntry,
  ApiError,
  AutopilotStatus,
  DiscoverBody,
  DiscoverResult,
  EnrichBody,
  EnrichResult,
  EnrollBody,
  Health,
  ImportResult,
  GoogleMailStatus,
  InboxTestResult,
  LeadPatch,
  LoginBody,
  Me,
  OutcomeBody,
  LinkedInNote,
  EditStepBody,
  EditStepResult,
  PrintoutDoc,
  Paged,
  ProvidersResponse,
  Queue,
  QueueActionResult,
  ReadinessItem,
  RenderedStep,
  SequenceCreate,
  SequenceUpdate,
  TodoList,
} from '@shared/types'
import type { SendingInbox, Settings } from '@shared/settings'
import type { Lead, LeadDetail, Sequence } from './types.ts'

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
  get notBuilt(): boolean {
    return this.code === 'NOT_BUILT' || this.status === 501
  }
  get unauthorized(): boolean {
    return this.status === 401
  }
}

/** True when an unknown error is the server saying "not built yet". */
export function isNotBuilt(err: unknown): boolean {
  return err instanceof ApiRequestError && err.notBuilt
}

/** Plain words for any thrown value. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiRequestError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export async function api<T>(
  path: string,
  method: Method = 'GET',
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: isForm || body === undefined ? undefined : { 'content-type': 'application/json' },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    ...init,
  })
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: text }
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiError>
    throw new ApiRequestError(res.status, err.error ?? `Request failed (${res.status})`, err.code)
  }
  return data as T
}

const qs = (params: Record<string, string | number | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  if (entries.length === 0) return ''
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()
}

// auth
export const login = (body: LoginBody) => api<Me>('/api/login', 'POST', body)
export const logout = () => api<Me>('/api/logout', 'POST')
export const me = () => api<Me>('/api/me')

// health
export const health = () => api<Health>('/api/health')

// settings
export const getSettings = () => api<Settings>('/api/settings')
export const putSettings = (patch: Partial<Settings>) =>
  api<Settings>('/api/settings', 'PUT', patch)
export const getProviders = () => api<ProvidersResponse>('/api/settings/providers')
export const getReadiness = () => api<ReadinessItem[]>('/api/settings/readiness')
export const getGoogleMail = (fresh = false) =>
  api<GoogleMailStatus>(`/api/settings/google-mail${fresh ? '?fresh=1' : ''}`)
export const testInbox = (inbox: SendingInbox) =>
  api<InboxTestResult>('/api/settings/inboxes/test', 'POST', inbox)

// leads
export interface LeadsParams extends Record<string, string | number | undefined> {
  status?: string
  persona?: string
  q?: string
  page?: number
  limit?: number
}
export const listLeads = (params: LeadsParams) => api<Paged<Lead>>(`/api/leads${qs(params)}`)
export const getLead = (id: string) => api<LeadDetail>(`/api/leads/${encodeURIComponent(id)}`)
export const patchLead = (id: string, patch: LeadPatch) =>
  api<Lead>(`/api/leads/${encodeURIComponent(id)}`, 'PATCH', patch)
export const importCsv = (file: File) => {
  const form = new FormData()
  form.append('file', file)
  return api<ImportResult>('/api/leads/import', 'POST', form)
}
export const discoverLeads = (body: DiscoverBody) =>
  api<DiscoverResult>('/api/leads/discover', 'POST', body)
export const enrichLeads = (body: EnrichBody) =>
  api<EnrichResult>('/api/leads/enrich', 'POST', body)
export const enrollLead = (id: string, body: EnrollBody) =>
  api<{ ok: true }>(`/api/leads/${encodeURIComponent(id)}/enroll`, 'POST', body)
export const stopLead = (id: string, reason?: string) =>
  api<{ ok: true }>(`/api/leads/${encodeURIComponent(id)}/stop`, 'POST', { reason })
export const leadOutcome = (id: string, body: OutcomeBody) =>
  api<Lead>(`/api/leads/${encodeURIComponent(id)}/outcome`, 'POST', body)

// sequences
export const listSequences = () => api<Sequence[]>('/api/sequences')
export const createSequence = (body: SequenceCreate) =>
  api<Sequence>('/api/sequences', 'POST', body)
export const updateSequence = (id: string, body: SequenceUpdate) =>
  api<Sequence>(`/api/sequences/${encodeURIComponent(id)}`, 'PUT', body)
export const deleteSequence = (id: string) =>
  api<{ ok: true }>(`/api/sequences/${encodeURIComponent(id)}`, 'DELETE')
export const previewSequence = (id: string, leadId?: string) =>
  api<RenderedStep[]>(`/api/sequences/${encodeURIComponent(id)}/preview`, 'POST', {
    lead_id: leadId,
  })
export const testSendSequence = (id: string) =>
  api<{ ok: true }>(`/api/sequences/${encodeURIComponent(id)}/test-send`, 'POST')

// queue
export const getQueue = () => api<Queue>('/api/queue')
export const queueDone = (messageId: string, note?: string) =>
  api<QueueActionResult>(`/api/queue/${encodeURIComponent(messageId)}/done`, 'POST', { note })
export const queueSkip = (messageId: string, note?: string) =>
  api<QueueActionResult>(`/api/queue/${encodeURIComponent(messageId)}/skip`, 'POST', { note })
export const queueNote = (messageId: string) =>
  api<LinkedInNote>(`/api/queue/${encodeURIComponent(messageId)}/note`, 'POST')
export const queueRestore = (messageId: string) =>
  api<QueueActionResult>(`/api/queue/${encodeURIComponent(messageId)}/restore`, 'POST')
export const getTodo = () => api<TodoList>('/api/queue/todo')
export const fillTodoNow = () =>
  api<{ added: number; reason?: string }>('/api/queue/todo/fill', 'POST')
export const linkedInWrongPerson = (leadId: string, messageId?: string) =>
  api<{ ok: true }>(`/api/leads/${encodeURIComponent(leadId)}/linkedin/wrong`, 'POST', {
    message_id: messageId,
  })
export const printQueueUrl = (ids: string[]) =>
  `/api/queue/print?ids=${ids.map(encodeURIComponent).join(',')}`
/** The same people as envelope address labels (Avery 5163, 10 a sheet). */
export const printLabelsUrl = (ids: string[]) => `${printQueueUrl(ids)}&labels=1`
/** One printout to proof and edit: this person's part plus the page as it prints. */
export const getPrintout = (messageId: string) =>
  api<PrintoutDoc>(`/api/queue/${encodeURIComponent(messageId)}/printout`)
/** Save Theo's own words on a waiting step (a LinkedIn note, an email, a printout's part). */
export const editStepText = (messageId: string, body: EditStepBody) =>
  api<EditStepResult>(`/api/queue/${encodeURIComponent(messageId)}/text`, 'PUT', body)

// autopilot
export const getAutopilot = () => api<AutopilotStatus>('/api/autopilot')
export const startAutopilot = () => api<AutopilotStatus>('/api/autopilot/start', 'POST')
export const stopAutopilot = () => api<AutopilotStatus>('/api/autopilot/stop', 'POST')
export const tickAutopilot = () => api<AutopilotStatus>('/api/autopilot/tick', 'POST')
export const getActivity = (limit = 100) => api<ActivityEntry[]>(`/api/activity${qs({ limit })}`)
