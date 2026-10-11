---
name: Call script, Denise, new rental license
channel: call
persona: denise
trigger: new_license
description: One call script for a small management company that just added a rental license.
---

## Step 1

delay_days: 0
notes: Theo dials. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}. I work with small Philadelphia management companies. Every new rental license adds a renewal, a lead cert and an inspection to a list that usually lives in one person's spreadsheet. We put compliance for every building where the whole office sees it. Do you have two minutes?"

Three questions (let them talk)

1. Who tracks license renewals, lead certs and inspections across the {{property_count}} buildings today?
2. What happened the last time a date got missed or almost missed?
3. How do the tenants and contractors for the new unit reach your office?

The ask
"Worth 15 minutes on a screen with you and your office manager? It's free while we're in beta, plus two months free after the public launch, and your data comes with you. Here is the link: {{demo_link}}"

If they say "Our software already has a compliance module"
"Does the whole office see it, and does it cover Philadelphia licenses and lead certs? If yes, you are set. If not, the 15 minutes is to compare."

If they say "Not now, bringing the unit online"
"Fair. When is the tenant in? I'll call the week after."
