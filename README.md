# discord-session-bot

Self-hosted Discord bot that records voice calls per speaker and produces a timestamped,
speaker-labelled transcript. See [PLAN.md](PLAN.md) for the roadmap.

**Status: M0, the DAVE voice-receive test.** Discord requires end-to-end encrypted voice (DAVE),
and this test checks that `@discordjs/voice` 0.19.2 can actually *receive* encrypted audio before
anything else gets built on top of it.

## Setup (Mac mini)

```sh
brew install node ffmpeg        # Node 22.12+ required
git clone https://github.com/ReesMcD/discord-session-bot && cd discord-session-bot
npm install
cp .env.example .env            # then fill in DISCORD_TOKEN (and GROQ_API_KEY for transcription)
cp config.example.yaml config.yaml   # then add your music bot to recording.ignore_users
npm run check:deps              # confirms the encryption libraries load on this machine
```

### Discord bot

1. <https://discord.com/developers/applications> → **New Application** → **Bot** → **Reset Token**, copy it into `.env`.
2. **OAuth2 → URL Generator**: scope `bot`; permissions **View Channels**, **Connect**, **Send Messages**, **Attach Files**. Open the URL and add the bot to your server.
3. In Discord: **User Settings → Advanced → Developer Mode** on. Right-click a voice channel → **Copy Channel ID**; right-click the music bot → **Copy User ID** (put it under `recording.ignore_users` in `config.yaml`).

No privileged intents are needed.

## Run the M0 test

```sh
npm run spike:receive -- --channel <voiceChannelId>        # Ctrl+C to stop
# or a fixed length:
npm run spike:receive -- --channel <voiceChannelId> --minutes 10
```

During the call, please:

- have **2+ people talk**, including over each other now and then
- have the **music bot play** something
- have someone **leave and rejoin** partway (this triggers a DAVE key change, the riskiest moment)
- ideally run one session for **15+ minutes**

When it stops, it prints a report and writes to `data/sessions/spike-<time>/`:

| File | What |
|---|---|
| `audio/<userId>/<startEpochMs>.ogg` | one file per utterance (playable in VLC) |
| `utterances.jsonl` | timing and packet stats per utterance |
| `debug.log` | every connection / DAVE debug line, plus joins/leaves |
| `report.json` | the summary |

Then render it for listening:

```sh
npm run spike:mix -- data/sessions/spike-<time>
open data/sessions/spike-<time>/render/mix.wav
```

`render/<userId>.wav` is each speaker on their own track, aligned to real time, and `mix.wav` is everyone together.

### Pass criteria

- Every human who spoke has files, and the music bot has **none** (listed as `SKIP` in the report).
- `mix.wav` sounds like the call: intelligible, no robotic garbling, speakers roughly in sync.
- Audio keeps working after someone leaves and rejoins.
- `Decrypt-failure debug lines` is low (a handful around join/leave is expected).

Send me the printed report, and the `debug.log` and `report.json` if anything looks off.

## Transcribe a recording

Needs `GROQ_API_KEY` in `.env` ([console.groq.com](https://console.groq.com) → API Keys).

```sh
npm run transcribe -- data/sessions/spike-<time>     # or just the folder name
```

This writes `transcript.md` into the session folder:

```
[00:00:05] Rees: Okay, is everyone here?
[00:00:08] Sam: Yep, ready when you are.
```

How it works:

- Each speaker's utterances are joined into batches of up to 10 minutes with 1 s of silence between them.
- Each batch is transcribed with word timestamps.
- Every line is mapped back to the moment it was actually said.
- Lines Whisper tends to invent over silence ("Thanks for watching!") are dropped.

Batches that were already transcribed are cached, so re-running is free.

To rename speakers or change how lines are joined, edit `config.yaml` and run
`npm run merge -- <session>`. That rebuilds `transcript.md` without calling the API again.

## Configuration

`config.yaml` (see [config.example.yaml](config.example.yaml)): ignore list, speaker names,
transcription provider/model/language, a vocabulary `prompt` for names Whisper should spell
correctly, and transcript formatting. Every setting is optional. Discord IDs can be quoted or not.
Secrets stay in `.env`.

## Development

```sh
npm run typecheck
npm test            # set FFMPEG_PATH if ffmpeg isn't on PATH; ffmpeg tests are skipped without it
npm run check:deps  # voice/DAVE native libraries load on this machine
```

GitHub Actions runs all of this on Linux and on Apple Silicon macOS for every push.
