# Outreach copy: voice rules and how to edit

The default copy lives in `content/sequences/*.md`. The seed reads those files on first boot and
`npm run seed` reads them again by hand. Theo can also edit any sequence in the app on the
Sequences page; the seed never overwrites a sequence whose name already exists, so edits in the
app survive a re-seed.

## What is in the folder

36 files: one per persona (maya, ray, denise) x trigger (new_license, recent_sale, none) x
channel (email, mail, linkedin, call). File names follow `<channel>-<persona>-<trigger>.md`.

| Channel  | Steps | Rules                                                                                                                                                  |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| email    | 3     | day 0, 3, 8. Subject under 45 characters. Body under 120 words. Step 1 asks for the look, step 2 points at the beta, step 3 is a break-up with no ask. |
| mail     | 1     | A postcard under 350 characters. Hand-written feel, one ask, a link line with `{{demo_link}}`, signed `{{sender_name}}`.                               |
| linkedin | 2     | Connection note under 300 characters with no link, then a message under 100 words three days later.                                                    |
| call     | 1     | 10 second open, three open questions, the ask, two likely objections with one-line answers.                                                            |

The "none" trigger variants are the defaults the autopilot enrolls into
(`settings.sequence_by_persona`). The trigger variants exist for the outreach builder to pick when
a lead has `trigger.type` set. In the database "none" is stored as trigger `any`.

## The voice

Theo sounds like one person typing to another, fast, at a desk. Every message:

1. **Names the pain first.** The first sentence is about them, never about Theo or Prop Archive.
   On a call, the first 10 seconds name the pain and then the fix, before any feature.
2. **Gestures at the fix in one or two lines.** Name the gap Prop Archive fills. Do not list
   features. The message earns the 15 minutes, it does not replace them.
3. **One credibility line, operator only.** "This is my second company, and I grew up around
   landlords." Never vanity metrics: no pitch winnings, lead counts, follower counts, fundraising.
4. **One ask.** Either the 15 minute look (`{{demo_link}}`) or join the beta (`{{beta_link}}`).
   Never both in one message. Say the words "demo" and "beta" at most once each per message.
5. **The offer, exactly.** "Free while we're in beta, plus two months free after the public
   launch." Nothing more: no lifetime pricing, no locked-in rate.
6. **Nothing to sign.** Never imply a contract, NDA or agreement.
7. **Present tense, forward motion.** "The beta is opening", never "looking for our first user".
8. **Plain words a Philadelphia rowhome landlord uses.** Repair texts, rental license, lead cert,
   turnover, tax time, contractors, the spreadsheet, the office, per unit.
9. **The last email is a break-up.** Short, honest, no ask, just `{{site_link}}`.
10. **Records are the sale.** Lead with finding the text, the receipt, the license. Never lead with
    rent collection, autopay or payments (docs/RESEARCH.md, "What to stop doing").
11. **Never recite their own records back.** No property counts, addresses, licenses or purchases
    quoted at them; L&I already emails owners about their own licenses. The data picks who gets
    which sequence; the copy speaks to the situation.
12. **Nov 1 once, as a date, as a question about their records.** "One question with
    Philadelphia's Nov 1 rental changes: could you find ...?" Never "the law requires": Theo is not
    a lawyer, and the ordinance is in litigation.

Banned: "circle back", "touch base", "hope this finds you well", "great question", "I wanted to
reach out", "quick question", "I came across your", "checking in", "synergies", "leverage".

**Never an em-dash (the character "—") in any file.** Use a comma, a colon or a new sentence.

## Who we are talking to

| Persona | Who                                                     | What hurts                                                                                                                                                 |
| ------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maya    | Side-income owner with a day job, 3 to 6 places         | Repair texts during work; no records at tax time; missed rental license or lead cert.                                                                      |
| Ray     | Full-time owner, 7 to 14 properties                     | 10+ repair texts a week with no record; summer turnover; chasing contractors and rent; digging for licenses and receipts.                                  |
| Denise  | Owner of a small management company, 15 to 20 buildings | Staff, tenants, contractors tracked in different places; compliance across the buildings; paying per unit for a half-used tool; worried about moving data. |

Triggers: `new_license` (a brand-new rental license, so the first year of paperwork is starting)
and `recent_sale` (just bought, so a new set of keys lands on top of everything else).

## Variables

Only these render (spec section 10). Anything else renders empty and logs a warning.

`{{first_name}}` `{{full_name}}` `{{company}}` `{{property_count}}` `{{unit_count}}`
`{{neighborhood}}` `{{trigger_line}}` `{{demo_link}}` `{{beta_link}}` `{{site_link}}`
`{{sender_name}}` `{{unsubscribe_link}}` `{{ai_opener}}`

- `{{ai_opener}}` goes on its own line at the top of email step 1 only. With an Anthropic key it
  becomes one plain sentence grounded in the lead's facts; without a key it renders empty.
- `{{property_count}}`, `{{unit_count}}`, `{{neighborhood}}` and `{{trigger_line}}` still render, but
  the shipped copy never uses them (rule 11). A test fails if one shows up in a sequence file.
- Never write `{{unsubscribe_link}}` in a body. The email sender appends the CAN-SPAM footer
  (sender, physical address, a line saying the email is an offer, unsubscribe link) to every email.
- Email bodies have no sign-off because the footer signs them.

## File format

```
---
name: Email, Maya, no trigger
channel: email
persona: maya
trigger: none
description: one optional line shown on the Sequences page
---

## Step 1

delay_days: 0
subject: Repair texts during your work day?

Hi {{first_name}},

The body, until the next "## Step" heading.

## Step 2

delay_days: 3
subject: Tax time with no records
notes: optional, for Theo only

...
```

- `channel`: email, mail, linkedin, instagram or call. `persona`: maya, ray, denise or any.
  `trigger`: new_license, recent_sale or none.
- Steps are numbered 1, 2, 3 in order. `delay_days` is required. `subject` only matters for email.
  `notes` is free text shown in the editor, never sent.
- Meta lines sit at the top of the step. The first line that is not `delay_days:`, `subject:` or
  `notes:` starts the body, so a body line that happens to contain a colon is fine.
- Prettier formats these files with the rest of the repo (it adds a blank line after headings).
  The parser ignores blank lines between meta lines.

## How to edit copy

1. Edit the `.md` file. Keep the limits in the table above.
2. Run `npm test`. `server/seed/content.test.ts` checks every rule on this page for every file:
   counts, limits, variables, em-dash, banned phrases, one ask per message.
3. Run `npm run format` so Prettier is happy.
4. To load the change into an existing database, either delete that sequence on the Sequences page
   and run `npm run seed` (it re-inserts missing names), or paste the new text into the editor.
   A fresh database picks everything up on first boot.
5. To add a sequence, add a file. To give a persona a new default, point
   `settings.sequence_by_persona` at it in Settings; the seed only fills empty slots.

## What to A/B test

Test angles, not words. The email step 1 subjects are pain-led questions or concrete observations;
a second variant should lead with a different pain (time versus money or risk), not a reworded
subject. Reply rate is the number that matters; at least 40 to 50 sends per variant before reading
anything into it.
