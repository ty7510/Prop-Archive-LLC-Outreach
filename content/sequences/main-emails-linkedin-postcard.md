---
name: Three emails, LinkedIn and a postcard
channel: email
persona: any
trigger: none
description: The one sequence. The app sends the three emails by itself. The LinkedIn note and the postcard are tasks for you on the Go page (copy and paste, print and mail), and they never hold up the emails. Steps a lead cannot get are skipped.
---

## Step 1

delay_days: 0
channel: email
subject: When a repair text becomes a dispute
notes: Sent by the app from one of your warmed inboxes. Hypothesis: a question about their last bad day (the repair dispute) earns more replies than a statement about records.

Hi {{first_name}},

{{ai_opener}}
When a tenant's leak text turns into a dispute six months later, how fast can you find that text and the receipt?

Prop Archive keeps every property's repairs, receipts, leases and licenses in one place.

It's my second company, and I grew up around landlords and property managers. We're building it with direct feedback from owners so small portfolios can keep up with the big ones.

It's free while we're in beta, plus two months free after the public launch.

Worth a 15 minute look? {{demo_link}}

If you'd like to look around first, it's all at proparchive.app.

{{sender_name}}

## Step 2

delay_days: 2
channel: linkedin
notes: Your task: open their profile, send a connection request, paste this as the note (it fits the 200 character limit of a free LinkedIn account). Never sent by the app. Only for leads whose profile research found; everyone else skips this step.

Hi {{first_name}}, when a tenant's repair text turns into a dispute, the hard part is finding it. I build software that keeps each property's records in one place. Second company. Glad to connect.

## Step 3

delay_days: 2
channel: email
subject: Your suitability certificate, in 10 days?
notes: Sent by the app. A new angle: the Nov 1 Safe Healthy Homes date (Bill 250329-AA, section 9-3903(1)(d)), asked as a question about their records, never as what the law requires.

Hi {{first_name}},

One question with Philadelphia's Nov 1 rental changes: if a tenant asks for a fresh Certificate of Rental Suitability, you have 10 days. Could you find that unit's license, past certificates and repair records in a minute?

Prop Archive keeps every property's papers together, so it's one search instead of an afternoon.

It's free while we're in beta, plus two months free after the public launch.

Worth a 15 minute look? {{demo_link}}

If you'd like to look around first, it's all at proparchive.app.

{{sender_name}}

## Step 4

delay_days: 3
channel: mail
notes: Your task: print the postcard from the Go page (or save it as a PDF), sign it, stamp it and mail it.

Hi {{first_name}},

When a tenant's repair turns into a dispute, can you find the text and the receipt in a minute? Prop Archive keeps every property's records in one place. Free while we're in beta.

Worth a 15 minute look? {{demo_link}}

{{sender_name}}

## Step 5

delay_days: 3
channel: email
subject: Last note about your property records
notes: Sent by the app. The break-up: short, no pressure, no ask, the door left open.

Hi {{first_name}},

Sounds like the timing's off, so this is my last note.

If a repair dispute or a tenant's paperwork request ever has you hunting for a receipt, Prop Archive keeps each property's records in one place. It's free while we're in beta, plus two months free after the public launch.

If the timing ever changes, my calendar is at {{demo_link}} and everything else is at proparchive.app.

{{sender_name}}
