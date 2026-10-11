---
name: Email, Ray, new rental license
channel: email
persona: ray
trigger: new_license
description: Three emails for a full-time owner who just added a rental license. One more unit on top of the phone and the spreadsheet.
---

## Step 1

delay_days: 0
subject: New license on top of the other places

Hi {{first_name}},

{{ai_opener}}
{{trigger_line}}
A new rental license is one more renewal date, one more lead cert, one more unit sending repair texts, on top of the properties you already run from your phone and a spreadsheet.

Prop Archive gives every property one home for texts, contractors, rent and license dates, so adding a unit does not mean adding a tab.

This is my second company, and I grew up around landlords and property managers. Free while we're in beta, plus two months free after the public launch. Nothing to sign.

Worth a 15 minute look? {{demo_link}}

## Step 2

delay_days: 3
subject: License dates across all your places

Hi {{first_name}},

With {{property_count}} properties, rental license renewals and lead certs come due on different days all year. Missing one means a fine or a unit you cannot legally rent during turnover.

Prop Archive tracks the dates for every property in one list and reminds you before they hit, next to the repair history and the rent.

Still free while we're in beta. Join here: {{beta_link}}

## Step 3

delay_days: 8
subject: I'll stop here

Hi {{first_name}},

Last note from me. Getting a new unit rented is enough to deal with.

If the renewal dates and the repair texts across all your places ever get to be too much for the spreadsheet, here is where to find me: {{site_link}}

Good luck with the new unit.
