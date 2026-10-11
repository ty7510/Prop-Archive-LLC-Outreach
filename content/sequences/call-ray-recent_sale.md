---
name: Call script, Ray, recent purchase
channel: call
persona: ray
trigger: recent_sale
description: One call script for a full-time owner who just added a building. Never cite the purchase back to them.
---

## Step 1

delay_days: 0
notes: Theo dials by hand. Only call someone who has talked with you or asked about Prop Archive; Pennsylvania treats any other sales call as telemarketing that needs registration. If that talk was more than 3 months ago, check the Do Not Call list first. 9 AM to 7 PM, never Sunday or a legal holiday. Take no payment on the phone. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}, calling about how you keep the records for your rentals. A new building means new tenants texting about repairs, a license to pull and a longer contractor list, all landing in the same phone. We give every property one searchable record from day one. Do you have two minutes?"

Three questions (let them talk)

1. What records came with the building, and where are they now?
2. Who's on your contractor list for it, and how do you track what they did?
3. When's the first turnover there, and what do you need on hand for it?

The ask
"Worth 15 minutes on a screen so you can see it with your own places? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "I'll sort it out after the first turnover"
"That's when missing records cost the most. The 15 minutes is to start the record before it."

If they say "Not now, busy"
"Fair. What week is less busy? I'll call back then." Then set the date.
