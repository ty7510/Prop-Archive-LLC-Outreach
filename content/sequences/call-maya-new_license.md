---
name: Call script, Maya, new rental license
channel: call
persona: maya
trigger: new_license
description: One call script for a side-income owner who just got a rental license.
---

## Step 1

delay_days: 0
notes: Theo dials. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}. Congrats on the new rental license. The first year with a new place is when the lead cert, the renewal date and the repair texts all land on top of a work day. We put all of that in one spot from day one. Do you have two minutes?"

Three questions (let them talk)

1. Is the place rented yet, and where are you keeping the lease, the deposit and the lead cert?
2. When the first repair text comes in at work, what is your plan?
3. How are you tracking the license renewal and the lead cert dates for this place and the others?

The ask
"Worth 15 minutes on a screen so you can see it with your own places? It's free while we're in beta, plus two months free after the public launch. Nothing to sign. Here is the link: {{demo_link}}"

If they say "It's one more place, I'll manage"
"Most owners say that at place number {{property_count}}. The 15 minutes is to see what the first year looks like with the records already in order."

If they say "Not now, I'm in the middle of getting it rented"
"Fair. Getting it rented is the whole job right now. When is the move-in date? I'll call the week after."
