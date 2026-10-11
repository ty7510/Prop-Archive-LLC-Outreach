---
name: Call script, Denise, no trigger
channel: call
persona: denise
trigger: none
description: One call script for the owner of a small management company. The office manager usually weighs in, so the ask includes them.
---

## Step 1

delay_days: 0
notes: Theo dials. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}. I work with small Philadelphia management companies. Staff, tenants and contractors tracked in different places, compliance across {{property_count}} buildings in a spreadsheet, and a per-unit bill for a tool the team half uses. We put all of that in one platform. Do you have two minutes?"

Three questions (let them talk)

1. Walk me through a work order today, from the tenant's text to the paid invoice. How many tools does it touch?
2. Who owns license renewals and lead certs across the buildings, and what happens when they are out?
3. What are you paying per unit today, and which parts of that tool does the team actually use?

The ask
"Worth 15 minutes on a screen with you and your office manager? It's free while we're in beta, plus two months free after the public launch, and your data comes with you. Here is the link: {{demo_link}}"

If they say "Moving our data is too much work"
"That is the real cost, and we do the move with you. The 15 minutes is to see what comes over and what does not before you decide anything."

If they say "We just renewed our current tool"
"Fair. When is the renewal date? I'll call two months before, so you have a real comparison when the bill comes."
