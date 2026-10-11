---
name: Outreach project boundaries
description: User constraints on isolation, database engine, and GitHub updates.
---

Keep this outreach project separate from the main Prop Archive app: no main-app custom domain, database, or shared secrets.

**Why:** The user explicitly stated that this is a new, separate outreach project.

**How to apply:** Do not interpret URLs in the outreach content as permission to connect infrastructure to the main app.

Pull GitHub updates using a normal merge, never a rebase; stop on merge conflicts and report the files.

**Why:** The user reports that rebasing gets stuck in this Repl.

**How to apply:** Preserve local Replit setup when integrating upstream changes, without pushing unless authorized.

Keep the SQLite/libsql database engine and schema.

**Why:** The user expressly prohibited engine/schema changes while requesting setup repairs.

**How to apply:** Explain production persistence requirements separately; do not silently migrate to Replit PostgreSQL or disable data-loss safeguards.
