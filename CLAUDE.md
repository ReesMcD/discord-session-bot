# CLAUDE.md

Self-hosted Discord bot: records voice calls per speaker → timestamped transcript (Groq Whisper) →
summary (Claude). TypeScript, Node ≥ 22.12, ESM, run with `tsx`. Roadmap in PLAN.md, setup in
README.md, **live-testing steps in TESTING.md**.

## Commands

- `npm run doctor [-- --online]`: environment check; run it first when anything fails
- `npm run typecheck` · `npm test` (node:test; ffmpeg tests skip without ffmpeg / `FFMPEG_PATH`)
- `npm run spike:receive -- --channel <id> --minutes N`: voice-receive test recorder
- `npm run spike:mix -- <session>` · `npm run transcribe -- <session> [--summarize]` · `npm run merge -- <session>`
- `npm run import:craig -- <zip|folder> [--summarize]` · `npm run summarize -- <session> [--force]`
- `npm run disambiguate -- <session>`: label who's speaking on shared accounts (`speakers.<id>.disambiguate`)
- `npm run web:build` then `npm run app`: web app on :4400 (needs `APP_PASSWORD`). `npm run web:typecheck` checks the UI.
- Web UI lives in `web/` (React + Vite, its own tsconfig). API in `src/app/` (Hono). Keep them separable: the UI may later be hosted on Vercel, but the bot/API never can.
- Mac app: `electron/` (menu bar, window, Keychain keys); `npm run mac:typecheck`, `npm run mac:dev`, `npm run mac:dist` (→ `release/*.dmg`). `electron/menuModel.ts` holds the menu logic (tested without Electron). CI builds it on macOS and runs `--smoke-test` (`.github/workflows/mac-app.yml`); pushing a `v*` tag publishes a GitHub Release.
- The recorder used by the app is `src/recording/SessionRecorder.ts` (driven by `src/bot/BotService.ts`); `src/spike/receive.ts` is the standalone M0 test version of the same logic.

## Rules

- Never print, commit or paste the contents of `.env`. Never commit `.env`, `config.yaml` or `data/`
  (all git-ignored). Ask the user to type secrets into files themselves.
- `spike:receive` and big transcriptions run longer than a foreground command is allowed; start them
  in the background and poll their output.
- The session folder layout (`src/session/layout.ts`) is the contract between recording,
  transcription, merge and summary; keep it backwards compatible.
- `@discordjs/voice` is pinned to 0.19.2 on purpose (DAVE receive fix). Don't upgrade it casually.
- Before committing: `npm run typecheck && npm test`.

## Core engineering rules

These apply to every project regardless of language or stack. The project-specific sections above
add to or override them.

### Philosophy
- Simplicity first. The best code is the code you didn't have to write.
  Prefer the smallest change that cleanly solves the problem.
- Follow Clean Code, Clean Architecture, and SOLID — as tools, not dogma.
  Apply a principle when it reduces complexity, not to demonstrate it.
- YAGNI wins ties. Build for extension only where change is likely or already
  happening. No speculative abstractions, interfaces with one implementation,
  or config for things nobody has asked to configure.
- Rule of three: duplicate once if needed; abstract on the third occurrence.

### Code Quality
- Small, single-purpose functions and classes. If a name needs "and" in it,
  split it.
- Names should reveal intent. No abbreviations, no generic names
  (data, manager, helper, utils) unless the scope makes the meaning obvious.
- Depend on abstractions at architectural boundaries (data access, external
  services, I/O) so core logic stays independent of frameworks and infra.
  Inside a module, concrete code is fine.
- Keep business/domain logic separate from transport, persistence, and UI.
- Use established design patterns where they fit the problem naturally.
  Don't force a pattern; name it in a comment only if it's non-obvious.
- Fail loudly and early. Validate inputs at boundaries; no silent catches.
- Comments explain *why*, not *what*. If code needs a comment to explain
  what it does, rewrite the code first.
- Match the existing style and conventions of the codebase over personal
  preference.

### Working in Existing Code
- Leave code better than you found it, scoped to what you're touching.
  Fix small violations (naming, dead code, obvious duplication) in the
  files you're already modifying.
- When you encounter older or unfamiliar code in your path, review it
  against these rules before building on it.
- For anything larger than a local cleanup — structural refactors,
  cross-module changes, pattern changes — STOP and flag it with a short
  summary of the issue and proposed fix. Do not refactor beyond the task
  scope without approval.
- Never mix refactoring and behavior changes in the same step. Refactor
  under passing tests, then change behavior.

### Testing
- Test what matters, not everything. Prioritize:
  1. Core business logic and domain rules
  2. Integration points: database access, external APIs, service boundaries
  3. Bug fixes — every fix gets a regression test reproducing the bug
  4. Edge cases and failure paths on critical flows
- Skip trivial tests: getters/setters, framework behavior, pass-through code.
- Tests should verify behavior, not implementation. A refactor that
  preserves behavior should not break tests.
- Tests must be deterministic, isolated, and readable. A test is
  documentation; name it after the behavior it verifies.
- Mock at boundaries (network, DB, clock), not internal collaborators.
- Run the relevant tests before declaring a task done. If they can't be
  run, say so explicitly.

### Process
- Before non-trivial changes, briefly state the plan and which files will
  be touched.
- Ask when requirements are ambiguous rather than guessing.
- Don't add dependencies without stating why an existing one or a few lines
  of code won't do.
- When done, summarize what changed, what was tested, and anything flagged
  for follow-up.
