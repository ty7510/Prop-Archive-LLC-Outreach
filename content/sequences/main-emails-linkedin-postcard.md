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
notes: Sent by the app from one of your warmed inboxes. Hypothesis: the repair-dispute pain earns more replies than a general records pitch.

Hi {{first_name}},

{{ai_opener}}
When a tenant's leak text turns into a dispute months later, the text, the receipt and the contractor's invoice are usually in three different places.

Prop Archive keeps each property's repairs, receipts, leases and license papers in one place, so you can find them in seconds.

This is my second company, and I grew up around landlords and property managers. We're building it with direct feedback from owners so small portfolios can keep up with the big ones.

It's free while we're in beta, plus two months free after the public launch.

Worth a 15 minute look? {{demo_link}}

If you'd like to look around first, it's all at proparchive.app.

{{sender_name}}

## Step 2

delay_days: 2
channel: linkedin
notes: Your task: open their profile, send a connection request, paste this as the note. Never sent by the app. No profile on file: use Find on LinkedIn on the task.

Hi {{first_name}}, a tenant's repair text that turns into a dispute months later is the headache I hear most from Philly landlords. I build software that keeps each property's records in one place. Second company, and I grew up around landlords. Glad to connect.

## Step 3

delay_days: 2
channel: email
subject: Your rental license papers, in one place?
notes: Sent by the app. A new angle: paperwork at license renewal or in a dispute, not repairs.

Hi {{first_name}},

When a license renewal or a tenant's lawyer asks for paperwork, it usually means digging through email, a glovebox and a filing cabinet.

Prop Archive keeps every property's leases, licenses, receipts and repair history together, so it's one search instead of an afternoon.

We're building it with direct feedback from Philly owners so small portfolios can keep up with the big ones. It's free while we're in beta.

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
notes: Sent by the app. The break-up: short, no pressure, the door left open.

Hi {{first_name}},

Sounds like the timing's off, so this is my last note.

If a repair dispute or a license renewal ever has you hunting for a receipt, Prop Archive keeps each property's records in one place. It's free while we're in beta, plus two months free after the public launch.

Worth a 15 minute look? {{demo_link}}

If you'd like to look around first, it's all at proparchive.app.

{{sender_name}}
