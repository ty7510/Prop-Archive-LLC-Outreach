---
name: Call script, Ray, recent purchase
channel: call
persona: ray
trigger: recent_sale
description: One call script for a full-time owner who just bought a building.
---

## Step 1

delay_days: 0
notes: Theo dials. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}. Congrats on the new building. New tenants texting about repairs, a license to pull, lead certs before move-in and a longer contractor list, all in the same phone as the other properties. We put all of that in one place. Do you have two minutes?"

Three questions (let them talk)

1. What did the old owner hand you: repair history, receipts, leases, or a shoebox?
2. How are the tenants in the new building reaching you about repairs so far?
3. With {{property_count}} properties now, how are you tracking license renewals and lead cert dates?

The ask
"Worth 15 minutes on a screen so you can see it with your own properties? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "I'll set it up once the building settles"
"The first 90 days are when the record is worth the most. The 15 minutes is to start it before the first turnover."

If they say "Not now, just closed"
"Fair. When is the first lease up in the new building? I'll call a few weeks before."
