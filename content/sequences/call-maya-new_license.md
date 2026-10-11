---
name: Call script, Maya, new rental license
channel: call
persona: maya
trigger: new_license
description: One call script for a side-income owner with a newly licensed rental. Never cite the license back to them.
---

## Step 1

delay_days: 0
notes: Theo dials by hand. Only call someone who has talked with you or asked about Prop Archive; Pennsylvania treats any other sales call as telemarketing that needs registration. If that talk was more than 3 months ago, check the Do Not Call list first. 9 AM to 7 PM, never Sunday or a legal holiday. Take no payment on the phone. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}, calling about how you keep the records for your rentals. A rental's first year is mostly paperwork on top of a day job: the lead cert, the renewal date, the lease and the repair texts. We put all of it in one place for each rental. Do you have two minutes?"

Three questions (let them talk)

1. Where do the lead cert, the license and the lease live today?
2. When a tenant texts about a repair while you're at work, what happens next?
3. How are you planning to keep the receipts for tax time?

The ask
"Worth 15 minutes on a screen so you can see it with your own places? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "It's just one place, I can keep track"
"That works for one. The 15 minutes is to see it set up so a second place doesn't double the pile."

If they say "Not now, busy"
"Fair. What week is less busy? I'll call back then." Then set the date.
