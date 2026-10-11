---
name: Call script, Denise, recent purchase
channel: call
persona: denise
trigger: recent_sale
description: One call script for a small management company taking on a building. Never cite the purchase back to them.
---

## Step 1

delay_days: 0
notes: Theo dials by hand. Only call someone who has talked with you or asked about Prop Archive; Pennsylvania treats any other sales call as telemarketing that needs registration. If that talk was more than 3 months ago, check the Do Not Call list first. 9 AM to 7 PM, never Sunday or a legal holiday. Take no payment on the phone. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}, calling about how your office keeps its records. Taking on a building means keying in the old owner's records while the work orders keep coming. We give every building one record the whole staff shares from day one. Do you have two minutes?"

Three questions (let them talk)

1. What came over from the old owner, and who is keying it in?
2. Walk me through a work order at the new building, from the tenant's text to the paid invoice.
3. Where do its license and lead cert dates live now?

The ask
"Worth 15 minutes on a screen with you and your office manager? It's free while we're in beta, plus two months free after the public launch, and your data comes with you. Here is the link: {{demo_link}}"

If they say "Moving the records is too much work"
"That is the real cost. The 15 minutes is to see what comes over and how, before you decide anything."

If they say "Not now, busy"
"Fair. What week is less busy? I'll call back then." Then set the date.
