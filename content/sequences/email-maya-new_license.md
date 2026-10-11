---
name: Email, Maya, new rental license
channel: email
persona: maya
trigger: new_license
description: Three emails for a side-income owner who just got a rental license. The first year of paperwork is the pain.
---

## Step 1

delay_days: 0
subject: New rental license, new paperwork

Hi {{first_name}},

{{ai_opener}}
{{trigger_line}}
A new rental license means the paperwork starts now: the lead cert, the renewal date, the tenant's deposit record, and every repair text in between. Most owners with a day job keep all of that in their phone until something goes wrong.

Prop Archive keeps it in one place from day one, so the first year of this rental does not turn into a search through old texts.

This is my second company, and I grew up around landlords. Free while we're in beta, plus two months free after the public launch. Nothing to sign.

Worth a 15 minute look? {{demo_link}}

## Step 2

delay_days: 3
subject: The lead cert and the renewal date

Hi {{first_name}},

The two dates that bite new Philadelphia landlords: the lead cert that has to be in hand before the tenant moves in, and the rental license renewal a year out. Both are easy to lose in a busy work week.

Prop Archive tracks the dates for each place and reminds you before they matter, next to the receipts and the repair texts.

Still free while we're in beta. Join here: {{beta_link}}

## Step 3

delay_days: 8
subject: I'll stop here

Hi {{first_name}},

Last note from me. The first year with a new rental is busy enough without a stranger in your inbox.

If the texts and the dates start piling up and you want them in one place, this is where to find me: {{site_link}}

Good luck with the new place.
