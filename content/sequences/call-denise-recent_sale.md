---
name: Call script, Denise, recent purchase
channel: call
persona: denise
trigger: recent_sale
description: One call script for a small management company that just took on a building.
---

## Step 1

delay_days: 0
notes: Theo dials. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}. Congrats on the new building. New leases, a rental license, lead certs and the old owner's records that someone in your office has to key in, while the work orders keep coming. We give every building one record your team shares, and we help move the data. Do you have two minutes?"

Three questions (let them talk)

1. What did the old owner hand you, and who in the office is keying it in?
2. How are the new tenants reaching your office about repairs so far?
3. With {{property_count}} buildings now, is your current tool's per-unit bill going up, and does the team use all of it?

The ask
"Worth 15 minutes on a screen with you and your office manager? It's free while we're in beta, plus two months free after the public launch, and your data comes with you. Here is the link: {{demo_link}}"

If they say "We will add it to our current system"
"Fair, if the current system is one your staff, tenants and contractors all use. If half of it still runs on texts and email, the 15 minutes is worth it."

If they say "Not now, just closed"
"Fair. When are the first leases up in the new building? I'll call a few weeks before."
