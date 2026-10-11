---
name: Call script, Ray, no trigger
channel: call
persona: ray
trigger: none
description: One call script for a full-time owner with 7 to 14 properties. Opens on the repair dispute with no record.
---

## Step 1

delay_days: 0
notes: Theo dials by hand. Only call someone who has talked with you or asked about Prop Archive; Pennsylvania treats any other sales call as telemarketing that needs registration. If that talk was more than 3 months ago, check the Do Not Call list first. 9 AM to 7 PM, never Sunday or a legal holiday. Take no payment on the phone. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}, calling about how you keep the records for your rentals. When a tenant's leak turns into a dispute six months later, finding that text and the receipt for the fix is the hard part. We put every record for every property in one search. Do you have two minutes?"

Three questions (let them talk)

1. The last time a repair turned into a dispute, how long did it take to find the text and the receipt?
2. How do turnovers go? Who tracks what the contractor did and what it cost?
3. Where do your license and lead cert dates live today, a spreadsheet?

The ask
"Worth 15 minutes on a screen so you can see it with your own places? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "I have a spreadsheet and it works"
"It works until a tenant disputes a repair and the text is in your phone, the receipt in email and the date in the spreadsheet. The 15 minutes is to see one search for all of it."

If they say "I tried software and it was too much"
"Fair. This one starts with your records, not a new way of running things. Fifteen minutes and you'll know if it fits."
