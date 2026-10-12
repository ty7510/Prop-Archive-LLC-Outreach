---
name: Email, LinkedIn, then mail
channel: email
persona: any
trigger: none
description: The one sequence. A cold email, a LinkedIn connection note three days later, a postcard five days after that. Steps a lead cannot get are skipped.
---

## Step 1

delay_days: 0
channel: email
subject: When a repair text becomes a dispute
notes: Sent from one of your warmed inboxes. Hypothesis: the repair-dispute pain earns more replies than a general records pitch.

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

delay_days: 3
channel: linkedin
notes: Connection note from your LinkedIn account in Settings. LinkedIn caps these at 300 characters. No profile on file: use Find on LinkedIn on the task.

Hi {{first_name}}, a tenant's repair text that turns into a dispute months later is the headache I hear most from Philly landlords. I build software that keeps each property's records in one place. Second company, and I grew up around landlords. Glad to connect.

## Step 3

delay_days: 5
channel: mail
notes: Postcard to the owner's mailing address. Print it from the Go page, sign it, and mail it.

Hi {{first_name}},

When a tenant's repair turns into a dispute, can you find the text and the receipt in a minute? Prop Archive keeps every property's records in one place. Free while we're in beta.

Worth a 15 minute look? {{demo_link}}

{{sender_name}}
