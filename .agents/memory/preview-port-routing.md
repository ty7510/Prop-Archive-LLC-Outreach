---
name: Managed Preview routing
description: Why this workspace needs public port 5000 despite a Vite client on 5173.
---

Use port 5000 for Replit's managed webview while preserving the user-requested Vite port 5173 and API port 5300 behind a development-only forwarding adapter.

**Why:** On 2026-10-11, a validated mapping from 5173 to external 80 worked until workflow startup reset it to 5000. The console workflow then timed out despite Vite reporting readiness on 5173. A managed webview on 5000 worked, including Vite WebSockets.

**How to apply:** Do not repeatedly try direct 5173 public mapping in this workspace. Production should serve the built client and API directly on the supplied PORT, falling back to 5000; the forwarding adapter is development-only.
