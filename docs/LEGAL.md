# Legal rules, in plain words

For Theo. This is what the system does and does not do on each channel, and why. It is not legal
advice; it is the set of rules the code enforces. Spec section 1 is the source.

## Email (CAN-SPAM)

Cold business email is allowed in the US when the message is honest and easy to stop. Every email we
send has:

- a true From name and address (you, Prop Archive),
- your real physical mailing address in the footer (Settings > Who you are > Physical address; the
  system refuses to send live email while it is empty),
- a working one-click unsubscribe link, and the technical headers mail apps use for their own
  "unsubscribe" button,
- a subject line that says what the email is about.
- one plain line that the email is an offer ("This email is an offer from Prop Archive."). CAN-SPAM
  asks for that on any sales email, business to business included.

When someone unsubscribes, bounces, or replies, they go on a suppression list and never get another
email from this system, even if they show up again from a new source. You can re-enable a person by
hand in their lead panel, and only you can.

## Direct mail (postcards, letters)

Mailing an owner at the address in public property records is fine. The system uses Lob when a key
is present, otherwise it gives you a print-ready batch. Same suppression rules apply.

## LinkedIn and Instagram

Their terms forbid scraping their sites, automated logins and bots that send messages. So the system
never touches their sites. It finds profile links through licensed data APIs and public web search,
writes the message for you, and puts it in the "Waiting for you" queue. You open the profile and
send it yourself with one click to copy. Nothing goes out on these channels without your hands.

## Phone (TCPA)

No automated texting and no robocalls. Phone numbers go into a call queue with a short script. You
dial.

Pennsylvania adds its own rules (the Telemarketer Registration Act, 73 P.S. 2241 and on, changed by
Act 47 of 2026, in force about Oct 19, 2026). In plain words, from docs/RESEARCH.md, not legal
advice:

- Only call or text someone who talked with you or asked about Prop Archive. Any other sales call is
  telemarketing, which needs state registration first ($500 and a $50,000 bond). After Oct 19 the
  talk has to be within the last 12 months, or you need their signed written consent.
- The federal Do Not Call rules still apply: if that talk was over 3 months ago, check the list.
- 9 AM to 7 PM, never on a Sunday or a legal holiday. Open with your name, Prop Archive and why you
  are calling.
- Take no payment on the phone. If they say stop (STOP, QUIT, END, CANCEL, UNSUBSCRIBE), stop and
  mark them.
- Whether landlord software counts as "consumer goods or services" under the Act is a question for
  a lawyer.

## Public records

Philadelphia OPA property assessments and L&I rental licenses are open data published by the city.
They are the main lead source. We store the public fields and the owner's mailing address.

## Dry run and Live

The system starts in dry run: everything is found, scored, written and queued, but no email or mail
goes to a lead. The two exceptions only ever reach you: "Send me a test" on a sequence, and the
one-line notice when a lead replies. You switch to Live in Settings > Danger, with a confirm dialog
that lists what would go out from the saved settings. Sequences that only ever ran in dry run start
over from step 1 at that moment, so the first live round really sends.
Human channels (LinkedIn, Instagram, calls) behave the same in both modes: they only ever reach the
queue.

## At most once

Every outgoing message has a unique key (enrollment plus step). If the server crashes mid-send and
restarts, it will not send the same step twice. Jobs take a lock before they run.

## Do not contact

A lead marked "Do not contact", on the suppression list, bounced, or who has replied is never
contacted again until you re-enable them by hand.
