---
name: Call script, Ray, new rental license
channel: call
persona: ray
trigger: new_license
description: One call script for a full-time owner who just added a rental license.
---

## Step 1

delay_days: 0
notes: Theo dials. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}. Congrats on the new rental license. One more license is one more renewal date, one more lead cert and one more unit texting about repairs, on top of what you already run from your phone and a spreadsheet. We put all of that in one place. Do you have two minutes?"

Three questions (let them talk)

1. How are you tracking renewal dates and lead certs across all {{property_count}} properties today?
2. When a repair text comes in, where does the record end up, and could you find it a year later?
3. What does adding a unit do to your week right now?

The ask
"Worth 15 minutes on a screen so you can see it with your own properties? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "The spreadsheet works fine"
"It works until the day you miss a renewal and cannot legally rent a unit during turnover. The 15 minutes is to see the dates and the repairs in one list."

If they say "Not now, getting the unit rented"
"Fair. When is move-in? I'll call the week after."
