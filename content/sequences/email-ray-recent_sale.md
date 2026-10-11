---
name: Email, Ray, recent purchase
channel: email
persona: ray
trigger: recent_sale
description: Three emails for a full-time owner who just added a building. New tenants, new license, same phone; never cite the purchase back to them.
---

## Step 1

delay_days: 0
subject: New building, same phone

Hi {{first_name}},

{{ai_opener}}
A new building means new tenants texting about repairs, a license to pull, lead certs before move-in and a longer contractor list, all landing in the same phone as everything else.

Prop Archive gives every property one searchable record, so growing doesn't mean more digging.

This is my second company, and I grew up around landlords and property managers. We're building it so owners your size can keep up with the big portfolios.

Free while we're in beta, plus two months free after the public launch. Nothing to sign.

Worth a 15 minute look? {{demo_link}}

## Step 2

delay_days: 3
subject: Papers for the new building

Hi {{first_name}},

One question with Philadelphia's Nov 1 rental changes: if a tenant in your newest building asked for the rental license and the Certificate of Rental Suitability, could you find both in a minute?

Prop Archive starts each building's record on day one, papers, repairs and contractors, and keeps it through every turnover.

Still free while we're in beta. Join here: {{beta_link}}

## Step 3

delay_days: 5
subject: I'll stop here

Hi {{first_name}},

Last one from me. A new building is plenty to deal with, so I'll get out of your inbox.

If its texts and receipts start to pile up with the rest, here's where to find me: {{site_link}}

Good luck with the building.
