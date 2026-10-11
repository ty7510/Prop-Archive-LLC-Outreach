---
name: Email, Ray, new rental license
channel: email
persona: ray
trigger: new_license
description: Three emails for a full-time owner who is adding units. One more license on top of the phone and the spreadsheet; never cite the license back to them.
---

## Step 1

delay_days: 0
subject: One more place on the same phone

Hi {{first_name}},

{{ai_opener}}
Every unit you add brings another license date, another lead cert and another tenant texting the same phone as the rest of your places.

Prop Archive gives every property one searchable record, so the dates, the texts and the contractor receipts are in one spot instead of a spreadsheet and your camera roll.

This is my second company, and I grew up around landlords and property managers. We're building it so owners your size can keep up with the big portfolios.

Free while we're in beta, plus two months free after the public launch. Nothing to sign.

Worth a 15 minute look? {{demo_link}}

## Step 2

delay_days: 3
subject: Could you find it in a minute?

Hi {{first_name}},

One question with Philadelphia's Nov 1 rental changes: if a tenant asked for your rental license and your Certificate of Rental Suitability this week, could you find both for any property in a minute?

Prop Archive keeps every license, lead cert and contractor receipt by property, and the turnover history with them, in one search.

Still free while we're in beta. Join here: {{beta_link}}

## Step 3

delay_days: 5
subject: I'll stop here

Hi {{first_name}},

Last note from me. I'll get out of your inbox.

If the license dates and the repair texts across your places start to slip, here's where to find me: {{site_link}}

Good luck with the properties.
