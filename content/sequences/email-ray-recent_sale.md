---
name: Email, Ray, recent purchase
channel: email
persona: ray
trigger: recent_sale
description: Three emails for a full-time owner who just bought a building. New tenants, new license, same phone.
---

## Step 1

delay_days: 0
subject: New building, same phone

Hi {{first_name}},

{{ai_opener}}
{{trigger_line}}
A new building means new tenants texting about repairs, a rental license to pull, lead certs before move-in, and a contractor list that just got longer. All of it lands in the same phone as the other {{property_count}} properties.

Prop Archive gives every property one home for texts, contractors, rent and license dates, so growing does not mean more digging.

This is my second company, and I grew up around landlords and property managers. Free while we're in beta, plus two months free after the public launch. Nothing to sign.

Worth a 15 minute look? {{demo_link}}

## Step 2

delay_days: 3
subject: The first turnover in a new building

Hi {{first_name}},

The first turnover in a building you just bought is where the old owner's records fail you: no repair history, no receipts, no idea which contractor fixed what.

Prop Archive starts the record on day one and keeps it for every property, so the next turnover and the next tax time have the numbers ready.

Still free while we're in beta. Join here: {{beta_link}}

## Step 3

delay_days: 5
subject: I'll stop here

Hi {{first_name}},

Last one from me. A new building is plenty to deal with, so I'll get out of your inbox.

If the texts and receipts from the new place start to pile up with the rest, here is where I am: {{site_link}}

Good luck with the building.
