// Module registry: the contract between the scaffold and the parallel builders. Owned by the scaffold.
// Each builder calls registerModule('<name>', impl) from its server/<name>/index.ts.
// Routes call requireModule('<name>') and get a clear error when a module is not built yet.
import type { AutopilotStatus, ImportResult, ResearchPaused } from '../shared/types.ts'

export interface SourcesModule {
  discover(opts: {
    zips?: string[]
    limit?: number
  }): Promise<{ created: number; merged: number; skipped: number }>
  importCsv(buffer: Buffer, filename: string): Promise<ImportResult>
}

export interface EnrichModule {
  pickBatch(limit: number): Promise<string[]>
  enrichLeads(ids: string[]): Promise<{ enriched: number; failed: number; skipped: number }>
  /** Why Claude research is not running right now, or null when it is free to run. */
  researchPause?(): Promise<ResearchPaused | null>
  /** Check stored research answers again with newer contact checks. No research call. */
  recheckStored?(limit: number): Promise<{ checked: number; improved: number }>
  /** Take saved LinkedIn links off leads when the name on the profile is not theirs. */
  checkSavedLinkedIn?(limit: number): Promise<{ checked: number; removed: number }>
}

export interface OutreachModule {
  enrollEligible(): Promise<{ enrolled: number }>
  enrollLead(leadId: string, sequenceId: string): Promise<void>
  stopLead(leadId: string, reason: string): Promise<void>
  sendDue(): Promise<{ sent: number; dryRun: number; queued: number; skipped: number }>
  syncReplies(): Promise<{ received: number }>
  /** The Go page to-do list: put today's people on it (server/outreach/todo.ts). */
  fillTodo(): Promise<{ added: number; reason?: string }>
  renderStep(stepId: string, leadId: string): Promise<{ subject?: string; body: string }>
}

export interface AutopilotModule {
  start(): void
  stop(): void
  tick(): Promise<void>
  status(): Promise<AutopilotStatus>
}

export const modules: {
  sources?: SourcesModule
  enrich?: EnrichModule
  outreach?: OutreachModule
  autopilot?: AutopilotModule
} = {}

export function registerModule<K extends keyof typeof modules>(
  name: K,
  impl: NonNullable<(typeof modules)[K]>,
): void {
  modules[name] = impl
}

export class ModuleNotRegisteredError extends Error {
  readonly code = 'MODULE_NOT_REGISTERED'
  constructor(readonly moduleName: string) {
    super(
      `module not registered: ${moduleName}. Its builder has not wired server/${moduleName}/index.ts yet.`,
    )
    this.name = 'ModuleNotRegisteredError'
  }
}

export function requireModule<K extends keyof typeof modules>(
  name: K,
): NonNullable<(typeof modules)[K]> {
  const impl = modules[name]
  if (!impl) throw new ModuleNotRegisteredError(name)
  return impl as NonNullable<(typeof modules)[K]>
}

export function hasModule<K extends keyof typeof modules>(name: K): boolean {
  return Boolean(modules[name])
}

/** Tests use this to swap in fakes and clean up after themselves. */
export function resetModules(): void {
  for (const k of Object.keys(modules) as (keyof typeof modules)[]) delete modules[k]
}
