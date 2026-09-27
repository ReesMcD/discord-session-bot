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
