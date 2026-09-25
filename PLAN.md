# discord-session-bot — Plan

Self-hosted Discord bot: `/record` → per-speaker recording → timestamped transcript.
Later phases add AI summarization and pluggable publishing.

## Locked decisions (Phase 1)

| Topic | Decision |
|---|---|
| Runtime | TypeScript, Node ≥ 22.12 (required by `@discordjs/voice` 0.19.2) |
| Host | Mac mini (launchd + `caffeinate`); code stays portable to a Linux VPS |
| Voice | `discord.js` 14.x, `@discordjs/voice` **pinned 0.19.2** (DAVE receive fix from PR #11449), `@snazzah/davey` |
| Transcriber | Hosted Groq (`whisper-large-v3-turbo`, OpenAI-compatible) first; local (mlx-whisper / faster-whisper) after M3 |
| Delivery | `transcript.md` posted as an attachment in the text channel + kept in the local data dir |
| Permissions | Anyone currently in the voice channel can `/record`, `/stop` |
| Config | Local `config.yaml` (repo-backed config source arrives in Phase 3) |

## Phase 1 — Join, record, transcribe

- **M0 DAVE receive spike (go/no-go).** Join, subscribe per speaker, write Ogg/Opus per utterance. Test with 2+ humans, a mid-call join/leave, and the music bot playing. Pass = clean audio, zero files for ignored users. Plan B if it fails: Python recorder sidecar (py-cord / discord-ext-voice-recv) writing the same on-disk format.
- **M1 Recording.** `/record`, `/stop`, `/status`; ignore users/bots before subscribe; start/stop channel messages; reconnect state machine; crash recovery on boot.
- **M2 Transcription.** `Transcriber` interface; per-speaker batching (ffmpeg concat + offset map) so short utterances aren't sent individually; word timestamps remapped to absolute time; hallucination / no-speech filtering.
- **M3 Transcript.** Chronological merge → `[HH:MM:SS] Name: text` with alias mapping; post file to channel.

## Phase 2 — AI summary

Two-pass (chunked extract → synthesize) with Claude, include/exclude rules, detail level, cite_timestamps, versioned prompt templates, `/summarize <session>`. Model configurable.

## Phase 3 — Publishing

`Publisher` interface; `publish:` in config is a list of destinations. GitHub (single commit per session) first; Discord attachment becomes a publisher; others (Drive, Notion, webhook) pluggable. `ConfigSource` interface (local file | GitHub).

## Stable session folder (contract between phases)

```
data/sessions/<id>/
  manifest.json          guild, channel, startedAt, stoppedAt, participants
  audio/<userId>/<startEpochMs>.ogg
  utterances.jsonl       userId, start, end, packets, file
  transcripts/<userId>.json
  segments.json          machine-readable merged transcript
  transcript.md
  meta.json
  state.json             pipeline stage, attempts, lastError
```

Every stage is a standalone, idempotent CLI (`transcribe`, `merge`, later `summarize`, `publish`); `/stop` chains them.

## Known risks

- DAVE key transitions (members joining/leaving) can silently drop packets → brief audio gaps (discord.js #11441, closed not-planned).
- No public confirmation yet of receive working on 0.19.2 specifically — hence M0 gate.
- `@discordjs/voice` 1.0 is in dev; stay pinned.
