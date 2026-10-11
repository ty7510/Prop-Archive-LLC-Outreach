---
name: Call script, Denise, no trigger
channel: call
persona: denise
trigger: none
description: One call script for the owner of a small management company. The office manager usually weighs in, so the ask includes them.
---

## Step 1

delay_days: 0
notes: Theo dials by hand. Only call someone who has talked with you or asked about Prop Archive; Pennsylvania treats any other sales call as telemarketing that needs registration. If that talk was more than 3 months ago, check the Do Not Call list first. 9 AM to 7 PM, never Sunday or a legal holiday. Take no payment on the phone. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}, calling about how your office keeps its records. Staff, tenants and contractors in different tools, compliance in a spreadsheet one person owns, and a per-unit bill for software the team half uses. We put all of it in one platform the whole office shares. Do you have two minutes?"

Three questions (let them talk)

1. Walk me through a work order today, from the tenant's text to the paid invoice. How many tools does it touch?
2. Who owns license renewals and lead certs across the buildings, and what happens when they are out?
3. What are you paying per unit today, and which parts of that tool does the team actually use?

The ask
"Worth 15 minutes on a screen with you and your office manager? It's free while we're in beta, plus two months free after the public launch, and your data comes with you. Here is the link: {{demo_link}}"

If they say "Moving our data is too much work"
"That is the real cost. The 15 minutes is to see what comes over and how, before you decide anything."

If they say "We just renewed our current tool"
"Fair. When is the renewal date? I'll call two months before, so you have a real comparison when the bill comes."
