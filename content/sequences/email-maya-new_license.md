---
name: Email, Maya, new rental license
channel: email
persona: maya
trigger: new_license
description: Three emails for a side-income owner with a newly licensed rental. The first year of paperwork is the pain; never cite the license back to them.
---

## Step 1

delay_days: 0
subject: A rental's first year of paperwork

Hi {{first_name}},

{{ai_opener}}
A rental's first year is mostly paperwork on top of a day job: the lead cert, the license renewal date, the lease, and every repair text from a tenant you just met.

Prop Archive gives each place one home for those papers and texts, so nothing lives only in your inbox.

This is my second company, and I grew up around landlords. We're building it with owners who have a day job too.

Free while we're in beta, plus two months free after the public launch. Nothing to sign.

Worth a 15 minute look? {{demo_link}}

## Step 2

delay_days: 3
subject: If a tenant asks for your papers

Hi {{first_name}},

One question with Philadelphia's Nov 1 rental changes: if your tenant asked for the rental license and the Certificate of Rental Suitability this week, where would you look first?

Prop Archive keeps the license, the lead cert and the repair history for each place in one search, so the answer takes a minute.

Still free while we're in beta. Join here: {{beta_link}}

## Step 3

delay_days: 5
subject: I'll stop here

Hi {{first_name}},

Last note from me. The first year with a rental is busy enough without my emails.

If the lead cert, the renewal date and the repair texts start to pile up, here's where to find me: {{site_link}}

Good luck with the place.
