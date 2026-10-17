// Proof and edit one printout: the one-page letter Theo mails in a folder with his business card.
// Left, the words: this person's heading and part, then the parts that are the same on every
// printout. Right, the page exactly as it prints (shared/printout.ts draws it here and on the print
// page), redrawn as he types, with a note when the words no longer fit one US Letter sheet.
// Saving only stores the words; nothing is sent or mailed from here.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'wouter'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, ExternalLink, Loader2, Printer, Save } from 'lucide-react'
import clsx from 'clsx'
import { PRINTOUT_LIMITS, printoutPreviewDocument } from '@shared/printout'
import type { Settings } from '@shared/settings'
import type { MessageStatus, PrintoutDoc } from '@shared/types'
import { editStepText, getPrintout, printQueueUrl, putSettings } from '../api.ts'
import { useAction } from '../hooks/useAction.ts'
import { useToast } from '../components/Toast.tsx'
import { Field } from '../components/Field.tsx'
import Confirm from '../components/Confirm.tsx'
import { ErrorNote, Loading } from '../components/QueryState.tsx'

/** The sheet in CSS pixels: 8.5 x 11 inches at 96 to the inch. */
const PAGE_W = 816
const PAGE_H = 1056
/** From this width up the words and the page sit side by side (Tailwind lg); below, they stack. */
const TWO_COLUMNS = '(min-width: 1024px)'
/** Height the side-by-side preview leaves for its card and the Save bar, so the whole sheet shows. */
const PREVIEW_CHROME = 220
/** Smallest the side-by-side preview gets on a short window (it never gets wider than its column). */
const MIN_SCALE = 0.4
/** The preview redraws this long after the last key press, not on every one. */
const PREVIEW_DELAY_MS = 300

type PartKey = keyof typeof PRINTOUT_LIMITS
type Parts = Record<PartKey, string>
type SharedKey = Exclude<PartKey, 'heading' | 'body'>
type Fit = 'checking' | 'fits' | 'long'

const PART_KEYS: readonly PartKey[] = ['heading', 'body', 'overview', 'bio', 'closing']
const SHARED_KEYS: readonly SharedKey[] = ['overview', 'bio', 'closing']
/** Where each shared part is kept in Settings. */
const SETTING_KEY = {
  overview: 'printout_overview',
  bio: 'printout_bio',
  closing: 'printout_closing',
} as const satisfies Record<SharedKey, keyof Settings>

const LABEL: Record<PartKey, string> = {
  heading: 'Heading',
  body: 'About them',
  overview: 'What Prop Archive is',
  bio: 'About you',
  closing: 'Closing',
}

const READ_ONLY: Partial<Record<MessageStatus, string>> = {
  sent: 'This printout is already marked mailed, so it can no longer be changed.',
  skipped: 'This printout was skipped, so it can no longer be changed.',
}

/** Words the way the server keeps them: plain line breaks, no blank space at either end. */
function norm(s: string): string {
  return s.replace(/\r\n?/g, '\n').trim()
}

function partsOf(doc: PrintoutDoc): Parts {
  const { heading, body, overview, bio, closing } = doc.parts
  return { heading, body, overview, bio, closing }
}

function sameParts(a: Parts, b: Parts): boolean {
  return PART_KEYS.every((k) => norm(a[k]) === norm(b[k]))
}

/**
 * New words from the server (`fresh`, replacing `before`) meet what is in the boxes. A box Theo has
 * not touched takes the new words, and so does one that was just saved (in `saved`) and not typed
 * in since it was sent (`sent`). Anything else he typed stays as it is.
 */
function mergeParts(
  drafts: Parts,
  before: Parts,
  fresh: Parts,
  sent?: Parts,
  saved?: ReadonlySet<PartKey>,
): Parts {
  const out = { ...drafts }
  for (const k of PART_KEYS) {
    const untouched = norm(drafts[k]) === norm(before[k])
    const justSaved = sent !== undefined && saved?.has(k) === true && drafts[k] === sent[k]
    if (untouched || justSaved) out[k] = fresh[k]
  }
  return out
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** First letter up and a full stop, for the server's hints ("it has a number"). */
function sentence(s: string): string {
  const t = s.trim()
  const up = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(up) ? up : `${up}.`
}

/** `value`, but only once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setShown(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return shown
}

export default function Printout() {
  const { id: rawId } = useParams<{ id: string }>()
  const id = safeDecode(rawId)
  const q = useQuery({ queryKey: ['printout', id], queryFn: () => getPrintout(id) })
  // Data first: when a later reload fails, the editor and anything typed in it stay on screen.
  if (q.data) return <PrintoutEditor key={q.data.message_id} doc={q.data} queryId={id} />
  return (
    <div className="space-y-4">
      <BackToGo />
      {q.isError ? (
        <ErrorNote error={q.error} retry={() => void q.refetch()} />
      ) : (
        <Loading text="Loading the printout" />
      )}
    </div>
  )
}

function PrintoutEditor({ doc, queryId }: { doc: PrintoutDoc; queryId: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [, navigate] = useLocation()
  const editable = doc.status === 'ready_for_human'

  // `base` is the saved words the boxes started from; `drafts` is what is in the boxes now.
  const [form, setForm] = useState(() => ({ base: partsOf(doc), drafts: partsOf(doc) }))
  const { base, drafts } = form
  /** Hints from the last save; null means use the ones that came with the page. */
  const [saveProblems, setSaveProblems] = useState<string[] | null>(null)
  const [fit, setFit] = useState<Fit>('checking')
  /** The link Theo pressed with unsaved changes, while the "Leave without saving?" box is open. */
  const [leaveVia, setLeaveVia] = useState<HTMLAnchorElement | null>(null)
  const leaving = useRef(false)

  const adopt = useCallback((fresh: Parts, sent?: Parts, saved?: ReadonlySet<PartKey>) => {
    setForm((f) =>
      !sent && sameParts(f.base, fresh)
        ? f
        : { base: fresh, drafts: mergeParts(f.drafts, f.base, fresh, sent, saved) },
    )
  }, [])

  // The saved copy changed (a save, a reload): boxes not touched since take the new words.
  useEffect(() => {
    adopt(partsOf(doc))
    setSaveProblems(null)
  }, [doc, adopt])

  const changed = PART_KEYS.filter((k) => norm(drafts[k]) !== norm(base[k]))
  const dirty = editable && changed.length > 0
  const sharedDirty = changed.some((k) => k !== 'heading' && k !== 'body')
  const over = PART_KEYS.find((k) => norm(drafts[k]).length > PRINTOUT_LIMITS[k])
  const blocked = !norm(drafts.body)
    ? 'Write something under About them before you save.'
    : over
      ? `${LABEL[over]} is too long: the most is ${PRINTOUT_LIMITS[over]} characters.`
      : null
  const problems = saveProblems ?? doc.problems
  const printUrl = printQueueUrl([doc.message_id])
  const aboutName = doc.parts.ownerName.trim().split(/\s+/)[0] || 'me'

  async function saveAll(): Promise<{ shared: boolean }> {
    // The words as they are in this render: exactly what Theo sees when he presses the button.
    const sent = drafts
    const before = base
    const headingChanged = norm(sent.heading) !== norm(before.heading)
    const bodyChanged = norm(sent.body) !== norm(before.body)
    const shared = SHARED_KEYS.filter((k) => norm(sent[k]) !== norm(before[k]))
    const key = ['printout', queryId]
    const stamp = qc.getQueryState(key)?.dataUpdatedAt ?? 0
    const saved = new Set<PartKey>()
    try {
      if (headingChanged || bodyChanged) {
        const result = await editStepText(doc.message_id, {
          // Left out when unchanged, so a standard heading stays standard.
          subject: headingChanged ? norm(sent.heading) : undefined,
          body: norm(sent.body),
        })
        saved.add('body')
        if (headingChanged) saved.add('heading')
        setSaveProblems(result.problems)
      }
      if (shared.length > 0) {
        const patch: Partial<Settings> = {}
        for (const k of shared) patch[SETTING_KEY[k]] = norm(sent[k])
        await putSettings(patch)
        for (const k of shared) saved.add(k)
      }
    } finally {
      // Reload the page even after an error: whatever did save shows, and a printout marked
      // mailed in another tab turns read-only.
      const reloaded = await qc.invalidateQueries({ queryKey: key }, { throwOnError: true }).then(
        () => true,
        () => false,
      )
      void qc.invalidateQueries({ queryKey: ['todo'] })
      void qc.invalidateQueries({ queryKey: ['settings'] })
      const state = qc.getQueryState<PrintoutDoc>(key)
      if (reloaded && state?.data && state.dataUpdatedAt > stamp) {
        adopt(partsOf(state.data), sent, saved)
      }
    }
    return { shared: shared.length > 0 }
  }

  const save = useAction(saveAll, {
    success: (r) => (r.shared ? 'Saved. This also changed every other printout.' : 'Saved'),
  })

  function setPart(k: PartKey, value: string) {
    setForm((f) => ({ ...f, drafts: { ...f.drafts, [k]: value } }))
  }

  function discard() {
    setForm((f) => ({ ...f, drafts: f.base }))
  }

  function printAfterSave() {
    // Open the tab inside the click, or the browser may block it; it goes to the print page once
    // the words are saved.
    const tab = window.open('', '_blank')
    try {
      if (tab) {
        tab.document.title = 'Saving'
        tab.document.body.textContent = 'Saving your changes. The printout opens here in a moment.'
      }
    } catch {
      // Only the waiting text is lost; the tab still goes to the print page below.
    }
    void save.run().then((result) => {
      if (!result) {
        tab?.close()
        return
      }
      if (tab && !tab.closed) {
        tab.opener = null
        tab.location.href = printUrl
      } else if (!window.open(printUrl, '_blank')) {
        toast.error('Saved, but the browser blocked the new tab. Press Print this page again.')
      }
    })
  }

  // Unsaved words: the browser asks before the tab closes or reloads...
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // ...and a link inside the app (the menu, Back to Go) asks first, since it never reloads the tab.
  useEffect(() => {
    if (!dirty) return
    const onClick = (e: MouseEvent) => {
      if (leaving.current || e.defaultPrevented || e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const link = e.target instanceof Element ? e.target.closest('a') : null
      if (!(link instanceof HTMLAnchorElement) || !link.href || link.hasAttribute('download'))
        return
      if (link.target && link.target !== '_self') return
      const to = new URL(link.href, window.location.href)
      // Another site is a full page load, which the browser's own question covers.
      if (to.origin !== window.location.origin) return
      if (to.pathname === window.location.pathname && to.search === window.location.search) return
      e.preventDefault()
      e.stopPropagation()
      setLeaveVia(link)
    }
    // Capture, so this runs before the router's own click handler.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty])

  function leaveAnyway() {
    const link = leaveVia
    setLeaveVia(null)
    if (!link) return
    leaving.current = true
    if (link.isConnected) {
      link.click()
    } else {
      const to = new URL(link.href, window.location.href)
      navigate(to.pathname + to.search + to.hash)
    }
  }

  const liveHtml = useMemo(
    () => printoutPreviewDocument(editable ? { ...doc.parts, ...drafts } : doc.parts),
    [doc.parts, drafts, editable],
  )
  const previewHtml = useDebounced(liveHtml, PREVIEW_DELAY_MS)

  if (!editable) {
    return (
      <div className="space-y-4">
        <PageHeader doc={doc} />
        <p className="card text-stone-700">
          {READ_ONLY[doc.status] ??
            'This printout is not waiting to be mailed, so it can no longer be changed.'}{' '}
          The page below is how it prints today.
        </p>
        <div className="mx-auto w-full max-w-[52rem] space-y-3">
          <PagePreview html={previewHtml} fit={fit} onFit={setFit} />
          <a href={printUrl} target="_blank" rel="noreferrer" className="btn-secondary">
            <Printer className="h-4 w-4" aria-hidden /> Print this page
          </a>
        </div>
      </div>
    )
  }

  const barNote = save.error
    ? save.error
    : blocked && dirty
      ? blocked
      : dirty
        ? 'Not saved yet. Print this page saves first.'
        : null

  return (
    <div className="space-y-4">
      <PageHeader doc={doc} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          {problems.length > 0 ? (
            <CheckList problems={problems} stale={changed.includes('body')} />
          ) : null}

          <section className="card space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Only on this printout</h2>
              <p className="mt-1 text-stone-600">
                Written for {doc.person}. Read it all the way through before you print.
              </p>
            </div>
            <PartField
              label={LABEL.heading}
              hint="The big line at the top of the page. Leave it empty to use the standard heading."
              value={drafts.heading}
              max={PRINTOUT_LIMITS.heading}
              onChange={(v) => setPart('heading', v)}
              single
            />
            <PartField
              label={LABEL.body}
              hint="The part written for this person and their company. A blank line starts a new paragraph."
              value={drafts.body}
              max={PRINTOUT_LIMITS.body}
              onChange={(v) => setPart('body', v)}
              rows={12}
            />
          </section>

          <details className="card">
            <summary className="min-h-tap cursor-pointer py-2 text-lg font-semibold">
              Same on every printout
              {sharedDirty ? (
                <span className="ml-2 text-sm font-normal text-amber-800">changes not saved</span>
              ) : null}
            </summary>
            <p className="mt-1 text-stone-700">
              These parts print on every printout, not just this one. Changing them here changes
              them on all of them.
            </p>
            <div className="mt-4 space-y-4">
              <PartField
                label={LABEL.overview}
                hint="The section called What Prop Archive is."
                value={drafts.overview}
                max={PRINTOUT_LIMITS.overview}
                onChange={(v) => setPart('overview', v)}
                rows={8}
                emptyNote="Empty: this section prints blank on every printout."
              />
              <PartField
                label={LABEL.bio}
                hint={`The section called About ${aboutName}.`}
                value={drafts.bio}
                max={PRINTOUT_LIMITS.bio}
                onChange={(v) => setPart('bio', v)}
                rows={7}
                emptyNote="Empty: this section prints blank on every printout."
              />
              <PartField
                label={LABEL.closing}
                hint="The lines above your signature."
                value={drafts.closing}
                max={PRINTOUT_LIMITS.closing}
                onChange={(v) => setPart('closing', v)}
                rows={3}
                emptyNote="Empty: nothing prints above your signature."
              />
            </div>
          </details>
        </div>

        <div className="min-w-0">
          <div className="lg:sticky lg:top-4">
            <PagePreview html={previewHtml} fit={fit} onFit={setFit} fitHeight />
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-stone-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={!dirty || blocked !== null || save.busy}
            onClick={() => void save.run()}
          >
            {save.busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            {save.busy ? 'Saving' : dirty ? 'Save changes' : 'Saved'}
          </button>
          {dirty ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={blocked !== null || save.busy}
              onClick={printAfterSave}
            >
              <Printer className="h-4 w-4" aria-hidden /> Print this page
            </button>
          ) : (
            <a href={printUrl} target="_blank" rel="noreferrer" className="btn-primary">
              <Printer className="h-4 w-4" aria-hidden /> Print this page
            </a>
          )}
          {dirty ? (
            <button type="button" className="btn-secondary" disabled={save.busy} onClick={discard}>
              Discard changes
            </button>
          ) : null}
          {barNote || fit === 'long' ? (
            <div className="w-full text-sm sm:w-auto">
              {barNote ? (
                <p className={save.error || (blocked && dirty) ? 'text-red-700' : 'text-stone-600'}>
                  {barNote}
                </p>
              ) : null}
              {fit === 'long' ? (
                <p className="font-medium text-red-700">Too long for one page: cut some words.</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <Confirm
        open={leaveVia !== null}
        onClose={() => setLeaveVia(null)}
        onConfirm={leaveAnyway}
        title="Leave without saving?"
        confirmLabel="Leave without saving"
        danger
      >
        <p>Your changes to this printout are not saved. If you leave now, they are lost.</p>
      </Confirm>
    </div>
  )
}

function BackToGo() {
  return (
    <Link href="/go" className="btn-secondary">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Go
    </Link>
  )
}

function PageHeader({ doc }: { doc: PrintoutDoc }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <BackToGo />
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="break-words">Printout for {doc.person}</h1>
        <p className={clsx('mt-1 break-words', doc.address ? 'text-stone-600' : 'text-amber-800')}>
          {doc.address ? `Mail to: ${doc.address}` : 'No mailing address on file yet.'}
        </p>
        <a
          href={`/leads?id=${encodeURIComponent(doc.lead_id)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-tap items-center gap-1 text-emerald-700 underline"
        >
          <ExternalLink className="h-4 w-4" aria-hidden /> What we know about them
        </a>
      </div>
    </div>
  )
}

/** The house-rule hints on the part about them. Only hints: saving and printing still work. */
function CheckList({ problems, stale }: { problems: string[]; stale: boolean }) {
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
      <h2 className="text-lg font-semibold">Check before you print</h2>
      <p className="mt-1">In the part about them:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {problems.map((p, i) => (
          <li key={`${i}-${p}`} className="break-words">
            {sentence(p)}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm">
        These are only hints. You can still save and print it as it is.
      </p>
      {stale ? (
        <p className="mt-1 text-sm">
          They are about the saved words. Save to check your latest changes.
        </p>
      ) : null}
    </section>
  )
}

function PartField({
  label,
  hint,
  value,
  max,
  onChange,
  rows = 4,
  single = false,
  emptyNote,
}: {
  label: string
  hint: string
  value: string
  max: number
  onChange: (value: string) => void
  rows?: number
  single?: boolean
  /** Said under the box when it is empty. */
  emptyNote?: string
}) {
  const length = norm(value).length
  const tooLong = length > max
  return (
    <Field label={label} hint={hint}>
      {single ? (
        <input
          className={clsx('input', tooLong && 'border-red-500')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <textarea
          className={clsx('input resize-y py-2 leading-relaxed', tooLong && 'border-red-500')}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <span
        className={clsx(
          'mt-1 block text-sm',
          tooLong ? 'font-medium text-red-700' : 'text-stone-500',
        )}
      >
        {length} of {max} characters{tooLong ? `: cut ${length - max}` : ''}
      </span>
      {emptyNote && length === 0 ? (
        <span className="mt-1 block text-sm text-amber-800">{emptyNote}</span>
      ) : null}
    </Field>
  )
}

/**
 * The page as it prints, in a frame scaled down to its column. The frame runs the same fit script
 * as the print page and tells this window whether the words fit one sheet.
 */
function PagePreview({
  html,
  fit,
  onFit,
  fitHeight = false,
}: {
  html: string
  fit: Fit
  onFit: (fit: Fit) => void
  /** Side by side with the words: also keep the whole sheet within the window's height. */
  fitHeight?: boolean
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const widthRef = useRef<HTMLDivElement>(null)
  const onFitRef = useRef(onFit)
  onFitRef.current = onFit
  const [width, setWidth] = useState(0)
  const [room, setRoom] = useState<number | null>(null)

  // A layout effect, so the listener is there before the frame's page can load and report.
  useLayoutEffect(() => {
    function onMessage(e: MessageEvent) {
      const frame = frameRef.current
      if (!frame || e.source !== frame.contentWindow) return
      const data: unknown = e.data
      if (typeof data !== 'object' || data === null) return
      const { type, tooLong } = data as { type?: unknown; tooLong?: unknown }
      if (type !== 'printout-fit') return
      onFitRef.current(typeof tooLong === 'number' && tooLong > 0 ? 'long' : 'fits')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // The column's width, from a zero-height strip so the sheet's own size never feeds back into it.
  useLayoutEffect(() => {
    const el = widthRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!fitHeight) {
      setRoom(null)
      return
    }
    const twoColumns = window.matchMedia(TWO_COLUMNS)
    const measure = () => setRoom(twoColumns.matches ? window.innerHeight - PREVIEW_CHROME : null)
    measure()
    window.addEventListener('resize', measure)
    twoColumns.addEventListener('change', measure)
    return () => {
      window.removeEventListener('resize', measure)
      twoColumns.removeEventListener('change', measure)
    }
  }, [fitHeight])

  const byHeight = room === null ? Infinity : Math.max(MIN_SCALE, room / PAGE_H)
  const scale = Math.max(0, Math.min(1, width / PAGE_W, byHeight))

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">How it prints</h2>
        <p
          role="status"
          className={clsx(
            'flex items-center gap-1.5 text-sm font-medium',
            fit === 'long'
              ? 'text-red-700'
              : fit === 'fits'
                ? 'text-emerald-700'
                : 'text-stone-500',
          )}
        >
          {fit === 'long' ? (
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          ) : fit === 'fits' ? (
            <Check className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
          )}
          {fit === 'long'
            ? 'Too long for one page: cut some words'
            : fit === 'fits'
              ? 'Fits on one page'
              : 'Checking the fit'}
        </p>
      </div>
      <div>
        <div ref={widthRef} className="h-0 w-full" aria-hidden />
        {/* The frame keeps its full 816 x 1056 layout size; this box is the scaled size and clips it. */}
        <div
          className="relative mx-auto overflow-hidden bg-white shadow-md ring-1 ring-stone-300"
          style={{ width: Math.floor(PAGE_W * scale), height: Math.floor(PAGE_H * scale) }}
        >
          <iframe
            ref={frameRef}
            title="The printout, as it prints"
            srcDoc={html}
            sandbox="allow-scripts"
            tabIndex={-1}
            className="pointer-events-none absolute left-0 top-0 block max-w-none border-0"
            style={{
              width: PAGE_W,
              height: PAGE_H,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
        </div>
      </div>
    </section>
  )
}
