// The printout Theo mails in a folder with his business card (2026-10-16): two US Letter pages
// (8.5 x 11 in). Page one is a letter written for this person (how Prop Archive helps their
// company, his closing and signature) with a few lines about Theo under it; page two is the full
// pitch: what Prop Archive is and what you get (Theo, 2026-10-25: "two pages with the full spiel,
// with a bio and a specified message to them"). One renderer for the print page (server) and the
// live preview while he proofs and edits it (client), so what he reads is what prints. The fit
// script sets each page in the largest type that fits its sheet and flags a page when even the
// smallest size does not.

import { PRINTOUT_LOGO } from './printoutLogo.ts'

export const DEFAULT_PRINTOUT_OVERVIEW = [
  'Prop Archive is one place to run your rentals. Leases and documents, repair requests and rent live together instead of across texts, email and spreadsheets. Tenants, owners and contractors each get their own portal, so the questions that used to land on your phone have somewhere to go.',
  "It's built for owners with a handful of doors up to small management teams, so you can run as tight as the big portfolios without their software bill. It's free while we're in beta, beta members get six months free at launch, and there's nothing to sign.",
].join('\n\n')

export const DEFAULT_PRINTOUT_BIO =
  "Prop Archive is my second company. I ran my first one for five years before moving to something with more room to grow. I grew up around landlords, realtors and property managers, so I've watched good owners lose their evenings to paperwork, repair calls and chasing rent. I'm building Prop Archive here in Philadelphia with direct feedback from landlords and managers, so small operators can compete with the big portfolios."

export const DEFAULT_PRINTOUT_CLOSING =
  "My card is in this folder. If any of this sounds like your week, call or text me and I'll show you around in 15 minutes. You can also look around first at proparchive.app."

/**
 * Page two's "What you get", under what Prop Archive is: one thing it does per paragraph, its first
 * sentence printed as the bold title. Worded from Theo's "Prop Archive in Action" clips, so it claims only what the
 * app does today.
 */
export const DEFAULT_PRINTOUT_FEATURES = [
  'Your morning on one screen. Late rent, open repairs, expiring documents, messages and leases ending soon, checked across every property each time you open the dashboard.',
  "Documents that file themselves. Snap a photo or drop a PDF with no property picked. It's read, matched to the right property and filed, and the full text is searchable.",
  'Leases read for you. Paste in a lease and the rent, dates, deposit and late fees come back for you to confirm. The end date goes straight into expiration tracking.',
  'Repairs that reach the right vendor. Each repair request comes back with a category, an urgency and the right vendor from your own directory, so you know who to call.',
  'Notices and forms in minutes. Nineteen templates for leases, notices, inspections and financial forms. Pick the property and tenant and their details fill in from your records.',
  'A login for everyone. Tenants send repair requests from their own portal instead of your phone, and owners and contractors each get a portal of their own.',
].join('\n\n')

/** Longest each part may be, in characters. With the fit script this keeps it to its page. */
export const PRINTOUT_LIMITS = {
  heading: 120,
  body: 1400,
  overview: 1200,
  features: 1400,
  bio: 900,
  closing: 400,
} as const

export interface PrintoutParts {
  heading: string
  /** The part written for this person. */
  body: string
  overview: string
  /** Page two's "What you get": one item per paragraph, its first sentence the title. */
  features: string
  bio: string
  closing: string
  /** "Prepared for" lines: their name, and their company when it is not just their name. */
  preparedFor: string[]
  date: string
  ownerName: string
  email: string
  /** The site without https://, e.g. proparchive.app. */
  site: string
  /** "Philadelphia, PA", for the footer. */
  city?: string
  /** Theo's photo for the About section, a data: image from Settings. None: the text runs full width. */
  photo?: string
  /** Screen only: a link to proof and edit this page. Never printed. */
  editHref?: string
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Blank lines start a new paragraph; a single line break stays a line break. */
export function paragraphsHtml(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/**
 * The items of "What you get": one per paragraph, its first sentence the bold title (without its
 * full stop) and the rest the line under it. A paragraph of one sentence is all title.
 */
export function featureItems(text: string): Array<{ title: string; text: string }> {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((p) => {
      const cut = /[.!?](?=\s)/.exec(p)
      if (!cut) return { title: p.replace(/[.]$/, ''), text: '' }
      return { title: p.slice(0, cut.index), text: p.slice(cut.index + 1).trim() }
    })
}

/** Roboto, the face of Theo's Company Overview & Founder Bio page. Goes in each page's <head>. */
export const PRINTOUT_FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap">'

/** The four facts in light-blue boxes under "What Prop Archive is", as on the overview page. */
export const PRINTOUT_STATS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '3–20 properties', label: "who it's for" },
  { value: '3 portals', label: 'owner, tenant, contractor' },
  { value: 'Free in beta', label: 'then 6 months free at launch' },
  { value: 'Beta live', label: 'since August 2026' },
]

/** Theo's title under his name in the About section and in the footer. */
export const PRINTOUT_ROLE = 'Founder & CEO'

/**
 * The pages' styles, matched to Theo's Company Overview & Founder Bio page (Canva, Sept 2026):
 * a navy band with the logo tile and PROP ARCHIVE (a slimmer one on page two), a light-blue rule,
 * navy headings with a short bar under them, four light-blue fact boxes, the things Prop Archive
 * does in two columns, the about section with his photo, a navy footer. Everything inside .op-flow
 * is sized in em so the fit script can shrink it as one. shared/printoutFit.ts lays the pages out
 * from these same numbers; its test fails when they part. 10.98in tall, not 11: a hair under the
 * sheet so no blank page follows.
 */
export const PRINTOUT_CSS = `
@page printout { size: 8.5in 11in; margin: 0; }
.onepager { --op-navy: #0f2044; --op-tile: #1b2950; --op-ink: #0c2d57; --op-sky: #92d0f8; --op-sky-text: #8fc7f1; --op-sky-soft: #c5e6fb; --op-card: #f5f6f9; page: printout; box-sizing: border-box; width: 8.5in; height: 10.98in; margin: 16px auto; background: #fff; color: var(--op-ink); display: flex; flex-direction: column; position: relative; overflow: hidden; font-family: Roboto, Arial, Helvetica, sans-serif; box-shadow: 0 1px 6px rgba(0,0,0,0.18); break-after: page; page-break-after: always; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.onepager:last-of-type { break-after: auto; page-break-after: auto; }
.onepager * { box-sizing: border-box; }
.op-band { flex: 0 0 auto; background: var(--op-navy); color: #fff; }
.op-head { display: flex; align-items: center; gap: 0.28in; height: 1.62in; padding: 0 0.45in; }
.op-logo { flex: 0 0 1.12in; width: 1.12in; height: 1.12in; display: block; }
.op-brand { min-width: 0; flex: 1 1 auto; }
.op-word { font: 700 40pt/1 Roboto, Arial, Helvetica, sans-serif; letter-spacing: 0.01em; color: #fff; white-space: nowrap; }
.op-sub { margin-top: 0.1in; font: 700 14pt/1.25 Roboto, Arial, Helvetica, sans-serif; color: var(--op-sky-text); }
.op-date { margin-top: 0.05in; font: 500 10pt/1.3 Roboto, Arial, Helvetica, sans-serif; color: var(--op-sky-text); opacity: 0.85; }
.op-rule { flex: 0 0 auto; height: 0.13in; background: linear-gradient(var(--op-sky) 0 62%, #dff1fd 80%, #fff 100%); }
.op-flow { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; gap: 0.95em; padding: 0.2in 0.47in 0.16in; font-size: 11.5pt; line-height: 1.42; color: var(--op-ink); }
.op-flow p { margin: 0 0 0.55em; }
.op-flow p:last-child { margin-bottom: 0; }
.op-h { margin: 0 0 0.75em; padding-bottom: 0.32em; position: relative; font: 700 1.55em/1.18 Roboto, Arial, Helvetica, sans-serif; color: var(--op-ink); }
.op-h::after { content: ''; position: absolute; left: 0; bottom: 0; width: 2.6em; height: 0.16em; background: var(--op-ink); }
.op-h.op-h-sky::after { background: var(--op-sky); }
.op-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.6em; margin-top: 0.9em; }
.op-stat { background: var(--op-card); border: 1px solid #a9d8f5; box-shadow: 0 1px 3px rgba(12,45,87,0.12); padding: 0.85em 0.4em 0.75em; text-align: center; }
.op-stat b { display: block; font-weight: 700; font-size: 1.08em; line-height: 1.2; color: var(--op-ink); }
.op-stat i { display: block; width: 5em; height: 2px; margin: 0.6em auto; background: var(--op-sky-soft); }
.op-stat span { display: block; font-size: 0.78em; line-height: 1.3; color: var(--op-ink); }
.op-divider { height: 0; margin: 0; border: 0; border-top: 2px solid var(--op-sky-soft); }
.op-bio { display: flex; gap: 1.6em; align-items: flex-start; }
.op-photo { flex: 0 0 11em; width: 11em; height: 12.3em; object-fit: cover; object-position: center top; display: block; }
.op-bio-text { flex: 1 1 auto; min-width: 0; }
.op-bio-name { margin: 0 0 0.5em; font: 700 1.15em/1.25 Roboto, Arial, Helvetica, sans-serif; color: var(--op-ink); }
.op-sign { display: flex; align-items: flex-end; gap: 0.15in; }
.op-line { width: 2.4in; height: 0.4in; border-bottom: 1.5px solid var(--op-ink); }
.op-name { font-size: 0.9em; line-height: 1.35; font-weight: 500; }
.op-foot { display: flex; justify-content: space-between; align-items: center; gap: 0.2in; height: 0.66in; padding: 0 0.45in; font: 700 10.5pt/1.2 Roboto, Arial, Helvetica, sans-serif; color: var(--op-sky-text); white-space: nowrap; }
.op-head2 { display: flex; align-items: center; gap: 0.2in; height: 0.8in; padding: 0 0.45in; }
.op-logo2 { flex: 0 0 0.52in; width: 0.52in; height: 0.52in; display: block; }
.op-word2 { font: 700 20pt/1 Roboto, Arial, Helvetica, sans-serif; letter-spacing: 0.01em; color: #fff; white-space: nowrap; }
.op-for2 { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 10pt/1.3 Roboto, Arial, Helvetica, sans-serif; color: var(--op-sky-text); }
.op-features { display: grid; grid-template-columns: 1fr 1fr; gap: 1em 1.5em; }
.op-feature { border-left: 3px solid var(--op-sky); padding-left: 0.75em; }
.op-feature b { display: block; margin-bottom: 0.2em; font-weight: 700; font-size: 1.05em; line-height: 1.25; color: var(--op-ink); }
.op-feature span { display: block; font-size: 0.95em; line-height: 1.42; }
.op-extra[hidden] { display: none; }
.op-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6em; }
.op-card { background: var(--op-card); border: 1px solid #a9d8f5; padding: 0.7em 0.8em; }
.op-card b { display: block; margin-bottom: 0.25em; font-weight: 700; line-height: 1.25; color: var(--op-ink); }
.op-card span { display: block; font-size: 0.92em; line-height: 1.4; }
.op-ps { margin: 0; font-style: italic; }
.op-callout { background: var(--op-navy); color: #fff; padding: 0.8em 1em; font-weight: 500; line-height: 1.35; }
.op-callout b { color: var(--op-sky-text); }
.op-edit { position: absolute; top: 0.12in; right: 0.12in; z-index: 1; font: 13px Arial, Helvetica, sans-serif; background: #eaf5fe; color: #0c2d57; border: 1px solid #92d0f8; border-radius: 6px; padding: 4px 10px; text-decoration: none; }
.onepager.too-long { outline: 4px solid #dc2626; outline-offset: -4px; }
.onepager.too-long::after { content: 'Too long for this page: cut some words'; position: absolute; left: 0; right: 0; bottom: 0; padding: 6px; background: #dc2626; color: #fff; font: 700 14px Arial, Helvetica, sans-serif; text-align: center; }
@media print {
  .onepager { margin: 0; box-shadow: none; }
  .op-edit { display: none; }
  .onepager.too-long { outline: none; }
  .onepager.too-long::after { display: none; }
}
`

/**
 * Fills each page first: of its extra sections (.op-extra), picks at most one card section and one
 * short line (.op-small), the pair that fits at full size and leaves the least empty room. Then shrinks the text of each page (11.5pt down to 8.5pt) until it fits its sheet, marks pages that
 * still do not, and tells a parent window (the editor's preview) how many do not. Each page fits on
 * its own: the letter keeps its full size however full the second page is. Runs again once Roboto
 * has loaded, since it measures wider than the fallback.
 */
export const PRINTOUT_FIT_SCRIPT = `(function () {
  function fit() {
    var long = 0;
    document.querySelectorAll('.onepager').forEach(function (page) {
      var flow = page.querySelector('.op-flow');
      if (!flow) return;
      var size = 11.5;
      flow.style.fontSize = size + 'pt';
      // At most one card section and one short line: the pair that fits and leaves the least room.
      var cards = [].slice.call(flow.querySelectorAll('.op-extra:not(.op-small)'));
      var smalls = [].slice.call(flow.querySelectorAll('.op-extra.op-small'));
      var extras = cards.concat(smalls);
      function show(set) { extras.forEach(function (x) { x.hidden = set.indexOf(x) < 0; }); }
      function tooTall() { return flow.scrollHeight > flow.clientHeight + 1; }
      function room() {
        flow.style.justifyContent = 'flex-start';
        var kids = [].filter.call(flow.children, function (k) { return !k.hidden; });
        var bottom = flow.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(flow).paddingBottom) || 0);
        var left = bottom - kids[kids.length - 1].getBoundingClientRect().bottom;
        flow.style.justifyContent = '';
        return left;
      }
      var best = [], bestRoom = Infinity;
      [null].concat(cards).forEach(function (c) {
        [null].concat(smalls).forEach(function (s) {
          var set = [c, s].filter(Boolean);
          show(set);
          if (tooTall()) return;
          var left = room();
          if (left < bestRoom - 1 || (Math.abs(left - bestRoom) <= 1 && set.length < best.length)) { best = set; bestRoom = left; }
        });
      });
      show(best);
      while (flow.scrollHeight > flow.clientHeight + 1 && size > 8.5) {
        size -= 0.25;
        flow.style.fontSize = size + 'pt';
      }
      var over = flow.scrollHeight > flow.clientHeight + 1;
      page.classList.toggle('too-long', over);
      if (over) long++;
    });
    var note = document.getElementById('fit-note');
    if (note) note.textContent = long ? long + (long === 1 ? ' page is' : ' pages are') + ' too long for its sheet: open Edit on the red one and cut some words.' : '';
    if (window.parent !== window) window.parent.postMessage({ type: 'printout-fit', tooLong: long }, '*');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fit); else fit();
  window.addEventListener('load', fit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
})();`

/** Longest the saved photo may be, as a data: URL. The browser shrinks it to about 60 KB first. */
export const PRINTOUT_PHOTO_MAX = 400_000

/** Only a data: image may go in the page as the photo. */
export function isPhotoDataUrl(s: string): boolean {
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(s)
}

/**
 * One printout: two pages. Page one is the letter written for this person (their heading and part,
 * Theo's closing and signature) and about Theo under it; page two is what Prop Archive is and what
 * you get.
 */
/**
 * Extra sections that print only when their page has room left at full size (the fit script picks
 * at most one card section and one short line, whichever fill the gap best), so a short letter or
 * overview still fills its sheet. Worded only from what the overview, features and bio already say.
 */
export interface PrintoutExtra {
  title: string
  cards: ReadonlyArray<{ title: string; text: string }>
}

export const PAGE_ONE_PS =
  'P.S. Not the right time? Keep my card. A text whenever it suits you is all it takes.'

export const PAGE_ONE_EXTRAS: readonly PrintoutExtra[] = [
  {
    title: 'What happens next',
    cards: [
      { title: '1. Call or text me', text: 'My number is on the card in this folder.' },
      {
        title: '2. Take a 15-minute look',
        text: "I'll walk you through it with your rentals in mind.",
      },
      {
        title: '3. Join the beta',
        text: "It's free while we're in beta, and there's nothing to sign.",
      },
    ],
  },
  {
    title: 'A week with Prop Archive',
    cards: [
      {
        title: 'Monday',
        text: 'Open the dashboard: late rent, open repairs and leases ending soon are already there.',
      },
      {
        title: 'Wednesday',
        text: 'A tenant sends a repair from their portal. It comes back with the right vendor from your directory.',
      },
      {
        title: 'Friday',
        text: 'Paste in a new lease. The rent, dates and deposit come back for you to confirm.',
      },
    ],
  },
]

export const PAGE_TWO_EXTRAS: readonly PrintoutExtra[] = [
  {
    title: 'Getting set up',
    cards: [
      {
        title: 'Bring what you have',
        text: "Snap photos or drop PDFs of your leases and documents. They're read and filed to the right property.",
      },
      {
        title: 'Invite your people',
        text: 'Tenants, owners and contractors each get a portal of their own.',
      },
      { title: 'See it first', text: 'A 15-minute look on a call, before you set anything up.' },
    ],
  },
  {
    title: "Who it's for",
    cards: [
      {
        title: 'A few rentals on the side',
        text: 'Repair requests come through a tenant portal instead of your phone.',
      },
      { title: 'Rentals full time', text: 'Run a small operation like a much bigger one.' },
      {
        title: 'A management company',
        text: 'Your team, your owners and your tenants on the same page.',
      },
    ],
  },
]

function extraCards(x: PrintoutExtra): string {
  return `<div class="op-extra" hidden>
      <h2 class="op-h op-h-sky">${esc(x.title)}</h2>
      <div class="op-cards">${x.cards.map((c) => `<div class="op-card"><b>${esc(c.title)}</b><span>${esc(c.text)}</span></div>`).join('')}</div>
    </div>`
}

export function printoutSection(p: PrintoutParts): string {
  const aboutOwner = p.ownerName.trim().split(/\s+/)[0] || 'me'
  const prepared = p.preparedFor.filter(Boolean)
  const sub = prepared.length ? `Prepared for ${prepared.map(esc).join(', ')}` : ''
  const photo = p.photo && isPhotoDataUrl(p.photo) ? p.photo : ''
  const named = p.ownerName.trim() ? `${esc(p.ownerName.trim())}, ${esc(PRINTOUT_ROLE)}` : ''
  const foot = [named, esc(p.email), esc(p.site), esc(p.city ?? '')].filter(Boolean)
  const footer = `<footer class="op-band op-foot">${foot.map((f) => `<span>${f}</span>`).join('')}</footer>`
  const items = featureItems(p.features)
  const features = items.length
    ? `<div class="op-get">
      <h2 class="op-h">What you get</h2>
      <div class="op-features">${items
        .map(
          (f) =>
            `<div class="op-feature"><b>${esc(f.title)}</b>${f.text ? `<span>${esc(f.text)}</span>` : ''}</div>`,
        )
        .join('')}</div>
    </div>`
    : ''
  return `<section class="onepager">
  ${p.editHref ? `<a class="op-edit" href="${esc(p.editHref)}" target="_blank" rel="noreferrer">Proof and edit</a>` : ''}
  <header class="op-band op-head">
    <img class="op-logo" src="${PRINTOUT_LOGO}" alt="Prop Archive logo">
    <div class="op-brand">
      <div class="op-word">PROP ARCHIVE</div>
      ${sub ? `<div class="op-sub">${sub}</div>` : ''}
      ${p.date ? `<div class="op-date">${esc(p.date)}</div>` : ''}
    </div>
  </header>
  <div class="op-rule"></div>
  <div class="op-flow">
    <div class="op-them">
      <h1 class="op-h">${esc(p.heading)}</h1>
      ${paragraphsHtml(p.body)}
    </div>
    <div class="op-close">${paragraphsHtml(p.closing)}</div>
    <div class="op-sign"><span class="op-line"></span><span class="op-name">${esc(p.ownerName)}<br>Prop Archive</span></div>
    <p class="op-extra op-small op-ps" hidden>${esc(PAGE_ONE_PS)}</p>
    <hr class="op-divider">
    <div class="op-about">
      <h2 class="op-h op-h-sky">About ${esc(aboutOwner)}</h2>
      <div class="op-bio">
        ${photo ? `<img class="op-photo" src="${photo}" alt="${esc(p.ownerName)}">` : ''}
        <div class="op-bio-text">
          ${named ? `<h3 class="op-bio-name">${named}</h3>` : ''}
          ${paragraphsHtml(p.bio)}
        </div>
      </div>
    </div>
    ${PAGE_ONE_EXTRAS.map(extraCards).join('\n    ')}
  </div>
  ${footer}
</section>
<section class="onepager">
  <header class="op-band op-head2">
    <img class="op-logo2" src="${PRINTOUT_LOGO}" alt="">
    <div class="op-word2">PROP ARCHIVE</div>
    ${sub ? `<div class="op-for2">${sub}</div>` : ''}
  </header>
  <div class="op-rule"></div>
  <div class="op-flow">
    <div class="op-what">
      <h2 class="op-h">What Prop Archive is</h2>
      ${paragraphsHtml(p.overview)}
      <div class="op-stats">${PRINTOUT_STATS.map((s) => `<div class="op-stat"><b>${esc(s.value)}</b><i></i><span>${esc(s.label)}</span></div>`).join('')}</div>
    </div>
    ${features}
    ${PAGE_TWO_EXTRAS.map(extraCards).join('\n    ')}
    <div class="op-extra op-small op-callout" hidden><b>See it in 15 minutes.</b> Call or text ${esc(aboutOwner === 'me' ? 'me' : aboutOwner)}: the number is on the card in this folder. Or look around first at ${esc(p.site)}.</div>
  </div>
  ${footer}
</section>`
}

/** The gap between the two pages in the editor's preview, in CSS pixels. */
export const PREVIEW_PAGE_GAP = 16

/** A whole document with the printout's two pages, for the editor's preview frame (it also prints from there). */
export function printoutPreviewDocument(p: PrintoutParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(p.heading)}</title>
${PRINTOUT_FONT_LINK}
<style>${PRINTOUT_CSS}
html, body { margin: 0; background: #d6d3d1; }
.onepager { margin: 0; box-shadow: none; }
.onepager + .onepager { margin-top: ${PREVIEW_PAGE_GAP}px; }
@media print { html, body { background: #fff; } .onepager + .onepager { margin-top: 0; } }
</style>
</head>
<body>
${printoutSection({ ...p, editHref: undefined })}
<script>${PRINTOUT_FIT_SCRIPT}</script>
</body>
</html>`
}
