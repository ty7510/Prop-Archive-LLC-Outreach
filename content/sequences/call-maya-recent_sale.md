---
name: Call script, Maya, recent purchase
channel: call
persona: maya
trigger: recent_sale
description: One call script for a side-income owner who just added a place. Never cite the purchase back to them.
---

## Step 1

delay_days: 0
notes: Theo dials by hand. Only call someone who has talked with you or asked about Prop Archive; Pennsylvania treats any other sales call as telemarketing that needs registration. If that talk was more than 3 months ago, check the Do Not Call list first. 9 AM to 7 PM, never Sunday or a legal holiday. Take no payment on the phone. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}, calling about how you keep the records for your rentals. Another place means more repair texts at work, a second pile of receipts for tax time and whatever records the old owner left. We put every place's texts, receipts and papers in one search. Do you have two minutes?"

Three questions (let them talk)

1. What did the old owner hand over, and where is it now?
2. When a repair text comes in during your work day, what happens next?
3. How do you keep the lead cert and license dates straight across your places?

The ask
"Worth 15 minutes on a screen so you can see it with your own places? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "I'm still settling in"
"That's the best time. The record starts on day one instead of catching up later."

If they say "Not now, busy"
"Fair. What week is less busy? I'll call back then." Then set the date.
