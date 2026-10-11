---
name: Email, Denise, new rental license
channel: email
persona: denise
trigger: new_license
description: Three emails for a small management company that just added a rental license. Compliance across the portfolio lives in one person's spreadsheet.
---

## Step 1

delay_days: 0
subject: One more license across the portfolio

Hi {{first_name}},

{{ai_opener}}
{{trigger_line}}
Another rental license is another renewal date, lead cert and inspection to track across {{property_count}} buildings, usually in a spreadsheet that one person in the office owns.

Prop Archive tracks compliance for every building in one place your whole team can see, next to the work orders, the tenants and the contractors.

This is my second company, and I grew up around property managers. Free while we're in beta, plus two months free after the public launch.

Worth a 15 minute look? {{demo_link}}

## Step 2

delay_days: 3
subject: Compliance your whole office can see

Hi {{first_name}},

When license renewals and lead certs live in one person's spreadsheet, the day that person is out is the day something lapses.

Prop Archive puts the dates for every building where the owner, the office manager and the staff all see them, with reminders before they matter.

Still free while we're in beta, and your data comes with you. Join here: {{beta_link}}

## Step 3

delay_days: 8
subject: I'll stop here

Hi {{first_name}},

Last note from me. Bringing a new rental online takes enough of the office's week.

If the compliance list across the buildings ever outgrows the spreadsheet, here is where to find me: {{site_link}}

Good luck with the new unit.
