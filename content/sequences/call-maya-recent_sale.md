---
name: Call script, Maya, recent purchase
channel: call
persona: maya
trigger: recent_sale
description: One call script for a side-income owner who just bought another place.
---

## Step 1

delay_days: 0
notes: Theo dials. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}. Congrats on the new property. A new place means a new rental license, a lead cert and a new set of repair texts during your work day. We put all of that in one spot for every place you own. Do you have two minutes?"

Three questions (let them talk)

1. What is the plan for the new place: rent as is, turnover first, or something else?
2. Where do the records for your other places live today, and how is that working at tax time?
3. When a repair text comes in during your work day, what happens next?

The ask
"Worth 15 minutes on a screen so you can see it with your own places? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "I have a system that works"
"Good. Does it tell you the license renewal and lead cert dates for the new place without you looking them up? If not, that is what the 15 minutes is for."

If they say "Not now, just closed"
"Fair. The closing is the busy part. When do you expect the first tenant in? I'll call the week after."
