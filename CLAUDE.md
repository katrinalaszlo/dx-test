# dx-test

Inspector-level scrutiny of the end-user experience, automated.

## What This Is
Two commands:
1. `generate <path>` — reads a product folder, extracts routes/docs/config, generates test flows (happy + error paths)
2. `walk` — walks the generated flows against a running app, captures bugs with full context

## Git Rules
- ALWAYS create a new branch before making changes. Never work directly on main.
- Before creating a PR, confirm with the user TWICE — they may be experimenting and not ready.
- Feature branches contain ONLY feature-related changes.

## Sacred vs. Sandbox
- The generated example app is a sandbox — fix without asking.
- The user's actual product code is sacred. Fix bugs on a branch. When ready, create a PR for a dev to review. The PR is the handoff.
- Confirm TWICE before creating a PR — user may still be exploring.
- PR descriptions should give the dev full context: what was found, how it was found (which user flow), why it matters, what the fix does, and any historical data implications. Be kind and collaborative — the dev is a teammate, not a subordinate. Log everything so they can understand without asking.

## Stack
- TypeScript, Node, ES modules
- Playwright for browser automation
- CLI via Commander
- No frameworks, no abstractions. Keep it simple.

## Code Style
- No clever abstractions. Readable > DRY.
- No docstrings or comments unless logic isn't self-evident.
- Let errors propagate. No silent catches.
