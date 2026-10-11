---
name: Call script, Denise, new rental license
channel: call
persona: denise
trigger: new_license
description: One call script for a small management company that is adding licenses. Never cite the license back to them.
---

## Step 1

delay_days: 0
notes: Theo dials by hand. Only call someone who has talked with you or asked about Prop Archive; Pennsylvania treats any other sales call as telemarketing that needs registration. If that talk was more than 3 months ago, check the Do Not Call list first. 9 AM to 7 PM, never Sunday or a legal holiday. Take no payment on the phone. Let them talk after each question.

10 second open
"Hi {{first_name}}, this is {{sender_name}}, calling about how your office keeps its records. Every license added across a portfolio is one more renewal date and lead cert in a compliance spreadsheet only one person owns. We put every building's papers and dates where the whole staff can see them. Do you have two minutes?"

Three questions (let them talk)

1. Who owns license renewals and lead certs across the buildings today?
2. What happens when that person is out?
3. If a tenant asked the office for a building's rental license tomorrow, who would find it, and how?

The ask
"Worth 15 minutes on a screen with you and your office manager? It's free while we're in beta, plus two months free after the public launch, and your data comes with you. Here is the link: {{demo_link}}"

If they say "Our property software already does that"
"Some do part of it. The 15 minutes is to compare, building by building, with what your staff actually uses."

If they say "We just renewed our current tool"
"Fair. When is the renewal date? I'll call two months before, so you have a real comparison when the bill comes."
