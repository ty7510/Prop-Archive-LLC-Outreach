---
name: Call script, Ray, new rental license
channel: call
persona: ray
trigger: new_license
description: One call script for a full-time owner who is adding units. Never cite the license back to them.
---

## Step 1

delay_days: 0
notes: Theo dials by hand. Only call someone who has talked with you or asked about Prop Archive; Pennsylvania treats any other sales call as telemarketing that needs registration. If that talk was more than 3 months ago, check the Do Not Call list first. 9 AM to 7 PM, never Sunday or a legal holiday. Take no payment on the phone. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}, calling about how you keep the records for your rentals. Every unit you add brings another license date, another lead cert and another tenant texting the same phone. We put every property's papers, texts and receipts in one search. Do you have two minutes?"

Three questions (let them talk)

1. Where do your license and lead cert dates live today?
2. When a contractor fixes something, where does the receipt end up?
3. How do turnovers go across your places, and what slips?

The ask
"Worth 15 minutes on a screen so you can see it with your own places? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "I have a spreadsheet and it works"
"It works until a tenant disputes a repair and the text is in your phone, the receipt in email and the date in the spreadsheet. The 15 minutes is to see one search for all of it."

If they say "Not now, busy"
"Fair. What week is less busy? I'll call back then." Then set the date.
