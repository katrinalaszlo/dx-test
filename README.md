# dx-test

**Inspector-level scrutiny of the end-user experience, automated.**

dx-test reads your product's codebase, generates a client-facing example app and test flows, then walks every flow like a real user — catching bugs with full context.

It's what a perfectionist PM does manually: walk the app, find what breaks, screenshot it, trace the root cause, fix it, re-test. Automated.

## What it does

1. **`generate`** — Point it at your product folder. It reads your routes, docs, and config, then generates test flows (happy paths + error paths).

2. **`walk`** — Runs the flows against your running app. Opens a real browser, hits real APIs, navigates real pages. Captures console errors, network failures, screenshots, and error states.

3. **Report** — Outputs a JSON bug report with everything a dev needs to fix it: what the user was doing, what broke, the error, and a screenshot.

## Quick start

```bash
npx dx-test generate ./path-to-your-product
npx dx-test walk --url http://localhost:3000
```

## Install

```bash
npm install -g dx-test
```

Or use directly:

```bash
npx dx-test generate ./my-api
npx dx-test walk --url http://localhost:3000
```

## How it works

### Generate

```bash
dx-test generate ./my-product
```

Reads your codebase and produces:
- `dx-test-app/analysis.json` — product analysis (routes, language, docs found)
- `dx-test-app/flows.json` — generated test flows with steps and expectations

Supports: Express, Spring Boot, Go, Python route patterns. Finds routes in `routes/`, `controllers/`, and `api/` directories.

### Walk

```bash
dx-test walk --url http://localhost:3000
```

Two phases:

**Phase 1: API testing** — Hits every discovered route directly. Reports 500s (server errors), unexpected 400s, and dead routes (404s).

**Phase 2: UI testing** — Opens a browser, loads the app, discovers navigation links, visits every page. Checks for console errors, broken error states, and unhandled exceptions.

Output: `dx-test-reports/report-{timestamp}.json` with full bug details + screenshots.

## Options

```
dx-test generate <path> [options]
  -o, --output <dir>    Output directory (default: ./dx-test-app)

dx-test walk [options]
  -u, --url <url>       App URL (default: http://localhost:3000)
  -r, --report <dir>    Report directory (default: ./dx-test-reports)
```

## Philosophy

This tool is built with the [Divergent framework](https://github.com/katrinalaszlo/divergent) — a set of principles for agentic engineering based on information architecture.

The core idea: **every testing tool checks whether code works. Nobody checks whether someone can successfully use your product.** dx-test tests the experience, not just the code.

### Defaults vs. divergences

dx-test uses defaults everywhere it can (Playwright for browser automation, standard route pattern detection, JSON reports) and diverges only where it matters:

- **Tests experience, not code** — bugs are "user got confused" not "assertion failed"
- **Bug reports, not test results** — output is actionable tickets with context, not pass/fail
- **Real apps, not mocks** — real browser, real API calls, real pages
- **PM workflow** — walk → find → capture → fix → re-walk

## Example output

```
dx-test — Walking flows

Target: http://localhost:5002
Flows: 117 | Routes: 183

Phase 1: API Route Testing

  GET /alerts → 200
  POST /billing/create-checkout → 400
    {"error":"Account not found"}
  POST /integrations/stripe/sync → 500 SERVER ERROR
    {"error":"Failed to sync Stripe data"}

API Results: 97 passed, 36 failed, 3 errors

Phase 2: UI Testing

  /signup — OK
  /login — OK
  /events — OK
  /data-sources — 2 console errors, error text visible

--- Walk Complete ---
API routes tested: 134
UI pages visited: 13
Bugs: 41
```

## Built by

[Kat Laszlo](https://github.com/katrinalaszlo)

## License

MIT
