---
name: Email, Denise, recent purchase
channel: email
persona: denise
trigger: recent_sale
description: Three emails for a small management company that just took on a building. The old owner's records have to be keyed in while the work orders keep coming.
---

## Step 1

delay_days: 0
subject: New building, new records to move

Hi {{first_name}},

{{ai_opener}}
{{trigger_line}}
A new building means new tenants, new leases, a rental license, lead certs, and a pile of the old owner's records that somebody in your office has to key into whatever you use today.

Prop Archive gives every building, tenant and contractor one home your whole team shares, and we help move the data in so the new building starts clean.

This is my second company, and I grew up around property managers. Free while we're in beta, plus two months free after the public launch.

Worth a 15 minute look? {{demo_link}}

## Step 2

delay_days: 3
subject: Onboarding a building without the mess

Hi {{first_name}},

The first 90 days with a new building are when work orders, deposits and license dates fall through the cracks, because the records are in the old owner's shoebox and your office is already full.

Prop Archive starts every building with one record your staff, tenants and contractors share from day one.

Still free while we're in beta, and your data comes with you. Join here: {{beta_link}}

## Step 3

delay_days: 8
subject: I'll stop here

Hi {{first_name}},

Last one from me. A new building is plenty for the office to take on.

If the per-unit bill on your current tool goes up at renewal, or the spreadsheet stops keeping up, here is where I am: {{site_link}}

Good luck with the building.
