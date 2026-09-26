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

## Rules

- Never print, commit or paste the contents of `.env`. Never commit `.env`, `config.yaml` or `data/`
  (all git-ignored). Ask the user to type secrets into files themselves.
- `spike:receive` and big transcriptions run longer than a foreground command is allowed; start them
  in the background and poll their output.
- The session folder layout (`src/session/layout.ts`) is the contract between recording,
  transcription, merge and summary; keep it backwards compatible.
- `@discordjs/voice` is pinned to 0.19.2 on purpose (DAVE receive fix). Don't upgrade it casually.
- Before committing: `npm run typecheck && npm test`.
