// The printout Theo mails in a folder with his business card (2026-10-16): one US Letter page
// (8.5 x 11 in) on how Prop Archive helps this person's company, what Prop Archive is, and a few
// lines about Theo. One renderer for the print page (server) and the live preview while he proofs
// and edits it (client), so what he reads is what prints. The fit script shrinks the text until it
// fits the one page and flags the page when even the smallest size does not.

export const DEFAULT_PRINTOUT_OVERVIEW = [
  'Prop Archive is one place to run your rentals. Leases and documents, repair requests and rent live together instead of across texts, email and spreadsheets. Tenants, owners and contractors each get their own portal, so the questions that used to land on your phone have somewhere to go.',
  "It's built for owners with a handful of doors up to small management teams, so you can run as tight as the big portfolios without their software bill. It's free while we're in beta, beta members get six months free at launch, and there's nothing to sign.",
].join('\n\n')

export const DEFAULT_PRINTOUT_BIO =
  "Prop Archive is my second company. I ran my first one for five years before moving to something with more room to grow. I grew up around landlords, realtors and property managers, so I've watched good owners lose their evenings to paperwork, repair calls and chasing rent. I'm building Prop Archive here in Philadelphia with direct feedback from landlords and managers, so small operators can compete with the big portfolios."

export const DEFAULT_PRINTOUT_CLOSING =
  "My card is in this folder. If any of this sounds like your week, call or text me and I'll show you around in 15 minutes. You can also look around first at proparchive.app."

/** Longest each part may be, in characters. With the fit script this keeps it to one page. */
export const PRINTOUT_LIMITS = {
  heading: 120,
  body: 1400,
  overview: 1200,
  bio: 900,
  closing: 400,
} as const

export interface PrintoutParts {
  heading: string
  /** The part written for this person. */
  body: string
  overview: string
  bio: string
  closing: string
  /** "Prepared for" lines: their name, and their company when it is not just their name. */
  preparedFor: string[]
  date: string
  ownerName: string
  email: string
  /** The site without https://, e.g. proparchive.app. */
  site: string
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

const HOUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.2 12 4l9 7.2" fill="none" stroke="#047857" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 10v9.5h13V10" fill="none" stroke="#047857" stroke-width="2.2" stroke-linejoin="round"/><rect x="10" y="13.5" width="4" height="6" fill="#047857"/></svg>`

/** The page's styles. 10.98in tall, not 11: a hair under the sheet so no blank page follows. */
export const PRINTOUT_CSS = `
@page printout { size: 8.5in 11in; margin: 0; }
.onepager { page: printout; box-sizing: border-box; width: 8.5in; height: 10.98in; margin: 16px auto; padding: 0.6in 0.7in 0.5in; background: #fff; color: #1c1917; display: flex; flex-direction: column; position: relative; overflow: hidden; font-family: Georgia, 'Times New Roman', serif; box-shadow: 0 1px 6px rgba(0,0,0,0.18); break-after: page; page-break-after: always; }
.onepager:last-of-type { break-after: auto; page-break-after: auto; }
.onepager * { box-sizing: border-box; }
.op-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.3in; padding-bottom: 0.14in; border-bottom: 2px solid #047857; font-family: Arial, Helvetica, sans-serif; }
.op-brand { display: flex; align-items: center; gap: 0.1in; font-size: 18pt; font-weight: 700; color: #064e3b; }
.op-brand svg { width: 0.36in; height: 0.36in; }
.op-meta { text-align: right; font-size: 9pt; line-height: 1.45; color: #44403c; }
.op-for { margin: 0.22in 0 0; font: 9.5pt/1.4 Arial, Helvetica, sans-serif; color: #57534e; letter-spacing: 0.04em; text-transform: uppercase; }
.op-title { margin: 0.06in 0 0; font: 700 20pt/1.15 Arial, Helvetica, sans-serif; color: #064e3b; }
.op-flow { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 0.85em; margin-top: 0.16in; font-size: 12pt; line-height: 1.5; }
.op-flow p { margin: 0 0 0.6em; }
.op-flow p:last-child { margin-bottom: 0; }
.op-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0.25in; }
.op-box { border: 1px solid #d6d3d1; border-top: 3px solid #047857; border-radius: 4px; padding: 0.75em 0.9em; font-size: 0.86em; line-height: 1.45; }
.op-box h2 { margin: 0 0 0.45em; font: 700 1.05em Arial, Helvetica, sans-serif; color: #064e3b; }
.op-sign { display: flex; align-items: flex-end; gap: 0.15in; }
.op-line { width: 2.4in; height: 0.42in; border-bottom: 1px solid #1c1917; }
.op-name { font: 10pt/1.35 Arial, Helvetica, sans-serif; }
.op-foot { margin-top: 0.12in; padding-top: 0.1in; border-top: 1px solid #d6d3d1; font: 9pt Arial, Helvetica, sans-serif; color: #57534e; text-align: center; }
.op-edit { position: absolute; top: 0.12in; right: 0.12in; font: 13px Arial, Helvetica, sans-serif; background: #ecfdf5; color: #065f46; border: 1px solid #6ee7b7; border-radius: 6px; padding: 4px 10px; text-decoration: none; }
.onepager.too-long { outline: 4px solid #dc2626; outline-offset: -4px; }
.onepager.too-long::after { content: 'Too long for one page: cut some words'; position: absolute; left: 0; right: 0; bottom: 0; padding: 6px; background: #dc2626; color: #fff; font: 700 14px Arial, Helvetica, sans-serif; text-align: center; }
@media print {
  .onepager { margin: 0; box-shadow: none; }
  .op-edit { display: none; }
  .onepager.too-long { outline: none; }
  .onepager.too-long::after { display: none; }
}
`

/**
 * Shrinks the text of each page (12pt down to 9pt) until it fits, marks pages that still do not,
 * and tells a parent window (the editor's preview) whether everything fits.
 */
export const PRINTOUT_FIT_SCRIPT = `(function () {
  function fit() {
    var long = 0;
    document.querySelectorAll('.onepager').forEach(function (page) {
      var flow = page.querySelector('.op-flow');
      if (!flow) return;
      var size = 12;
      flow.style.fontSize = size + 'pt';
      while (flow.scrollHeight > flow.clientHeight + 1 && size > 9) {
        size -= 0.25;
        flow.style.fontSize = size + 'pt';
      }
      var over = flow.scrollHeight > flow.clientHeight + 1;
      page.classList.toggle('too-long', over);
      if (over) long++;
    });
    var note = document.getElementById('fit-note');
    if (note) note.textContent = long ? long + (long === 1 ? ' page is' : ' pages are') + ' too long for one sheet: open Edit on the red one and cut some words.' : '';
    if (window.parent !== window) window.parent.postMessage({ type: 'printout-fit', tooLong: long }, '*');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fit); else fit();
  window.addEventListener('load', fit);
})();`

/** One page. */
export function printoutSection(p: PrintoutParts): string {
  const aboutOwner = p.ownerName.trim().split(/\s+/)[0] || 'me'
  const meta = [p.date, p.site, p.email].filter(Boolean).map(esc).join('<br>')
  const prepared = p.preparedFor.filter(Boolean)
  return `<section class="onepager">
  ${p.editHref ? `<a class="op-edit" href="${esc(p.editHref)}" target="_blank" rel="noreferrer">Proof and edit</a>` : ''}
  <div class="op-head">
    <div class="op-brand">${HOUSE}<span>Prop Archive</span></div>
    <div class="op-meta">${meta}</div>
  </div>
  ${prepared.length ? `<p class="op-for">Prepared for ${prepared.map(esc).join(', ')}</p>` : ''}
  <h1 class="op-title">${esc(p.heading)}</h1>
  <div class="op-flow">
    <div class="op-them">${paragraphsHtml(p.body)}</div>
    <div class="op-cols">
      <div class="op-box"><h2>What Prop Archive is</h2>${paragraphsHtml(p.overview)}</div>
      <div class="op-box"><h2>About ${esc(aboutOwner)}</h2>${paragraphsHtml(p.bio)}</div>
    </div>
    <div class="op-close">${paragraphsHtml(p.closing)}</div>
    <div class="op-sign"><span class="op-line"></span><span class="op-name">${esc(p.ownerName)}<br>Prop Archive</span></div>
  </div>
  <div class="op-foot">${[p.ownerName, p.email, p.site].filter(Boolean).map(esc).join(' &middot; ')}</div>
</section>`
}

/** A whole document with one page, for the editor's preview frame (it also prints from there). */
export function printoutPreviewDocument(p: PrintoutParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(p.heading)}</title>
<style>${PRINTOUT_CSS}
html, body { margin: 0; background: #fff; }
.onepager { margin: 0; box-shadow: none; }
</style>
</head>
<body>
${printoutSection({ ...p, editHref: undefined })}
<script>${PRINTOUT_FIT_SCRIPT}</script>
</body>
</html>`
}
