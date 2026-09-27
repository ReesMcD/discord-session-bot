# discord-session-bot

Record Discord voice calls with each speaker on a separate track, turn them into a timestamped,
speaker-labelled transcript, and summarize them with Claude. It all runs on your own machine.

```
[00:12:04] Rees: Okay, so the plan is we hit the warehouse at midnight.
[00:12:09] Sam: Fine by me, but who's bringing the rope?
```

## Install the Mac app (no terminal needed)

The easiest way to run it is **Session Bot.app**: a menu bar app that contains the bot, the
transcription and summary steps, and the web app.

1. **Download** the latest `Session-Bot-….dmg` from the
   [Releases page](https://github.com/ReesMcD/discord-session-bot/releases/latest). It's for
   Apple Silicon Macs. Open it and drag **Session Bot** into **Applications**.
2. **First launch:** the app isn't signed with an Apple Developer ID, so macOS blocks it the first
   time. Open it once, then go to **System Settings → Privacy & Security** and click
   **Open Anyway**. On older macOS, right-click the app and choose **Open** instead. You only do
   this once per version.
3. **Add your keys:** the app opens a welcome screen. Paste your Discord bot token, Groq key and
   Anthropic key ([where to get them](#3-create-your-api-keys),
   [how to make the Discord bot](#4-create-the-discord-bot-only-for-recording-with-the-bot)).
   They're stored encrypted in your Keychain.
4. **Use it from the menu bar** (the ◎ icon at the top of the screen):
   - **Join & Record ▸** lists your voice channels and who's in them. Pick one and it starts recording.
   - The icon turns red and shows the elapsed time. **Stop Recording** ends it, and the session is transcribed (and summarized, if you choose) automatically.
   - **Open Session Bot** opens the app window: sessions, transcripts, summaries and settings.
   - **Open at Login** keeps it running after restarts. The Mac won't sleep while it's recording.
5. **On your phone:** open the app's **Settings → Keys & phone** tab for the steps. They use
   Tailscale, and your phone signs in with the password shown there.

Your recordings, transcripts, summaries and settings are in `~/Library/Application Support/Session Bot/`.
The app shows a notice in its menu when a new version is out. Download it and drag it into
Applications again; your data stays.

Every push to `main` also builds the app. The build is under **Actions → Mac app → the latest
run → Artifacts**, and you need to be signed in to GitHub to download it. Tagged versions
(`v0.2.0`, …) are published on the Releases page.

## What works today

| Feature | Where | Status |
|---|---|---|
| Record a call: join a voice channel, one track per speaker, ignore bots/people | Mac app menu bar, or the app's Record tab | Ready, awaiting the first live test ([TESTING.md](TESTING.md)) |
| Transcribe (Groq Whisper) | Automatic after a recording, or the session's **Transcribe** button, or `npm run transcribe` | Ready |
| Label speakers on shared accounts | **Label speakers** button, or `npm run disambiguate` | Ready |
| Summarize (Claude) | **Summarize** button (or automatic), or `npm run summarize` | Ready |
| Import a [Craig](https://craig.chat) recording | `npm run import:craig` | Ready |
| Web app on your phone | Tailscale → `http://<Mac name>:4400` | Ready |
| Discord slash commands (`/record`, `/stop`) | none yet | Planned; the menu bar does this for now |
| Auto-publishing (e.g. to GitHub) | none yet | Phase 3 |

**Testing on a Mac with Claude Code?** Follow [TESTING.md](TESTING.md).

The sections below are for running from source with Node (development, or if you'd rather not use the app).

---

## Setup

These steps assume a Mac (Apple Silicon or Intel). Linux works too; install the same tools with
your package manager. Every command below is run from the project folder.

### 1. Install the tools

You need **Node.js 22.12 or newer**, **ffmpeg** and **git**. With [Homebrew](https://brew.sh):

```sh
brew install node ffmpeg git
node --version     # must print v22.12.0 or higher
ffmpeg -version    # any recent version
```

### 2. Get the code

```sh
git clone https://github.com/ReesMcD/discord-session-bot.git
cd discord-session-bot
npm install
npm run check:deps                   # should end with "Voice dependencies OK"
```

### 3. Create your API keys

You only need the keys for the steps you'll use.

| Key | Used for | Where to get it |
|---|---|---|
| `GROQ_API_KEY` | Transcription | [console.groq.com/keys](https://console.groq.com/keys) → **Create API Key** |
| `ANTHROPIC_API_KEY` | Summaries | [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys) → **Create key**. The key (it starts with `sk-ant-`) is shown only once, so copy it straight away. The account needs billing or credits set up. |
| `DISCORD_TOKEN` | Recording with the bot | See step 4. Not needed if you only import Craig recordings. |
| `APP_PASSWORD` | The web app | Make one up (8+ characters). The app asks for it on every device. |

### 4. Create the Discord bot (only for recording with the bot)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, and give it a name.
2. Open the **Bot** tab → **Reset Token** → copy the token. It goes in `.env` as `DISCORD_TOKEN`.
   Treat it like a password. If it leaks, reset it here.
3. The bot needs no privileged intents. Leave **Presence**, **Server Members** and **Message Content** off.
4. Open **OAuth2 → URL Generator**:
   - **Scopes:** `bot`
   - **Bot permissions:** **View Channels**, **Connect**, **Send Messages**, **Attach Files**
5. Open the generated URL in your browser and add the bot to your server.
6. In the Discord app, turn on **User Settings → Advanced → Developer Mode**. Now you can right-click things and choose **Copy ID**:
   - the **voice channel** you want to record: you'll pass this to the recorder;
   - your **music bot** (or anyone who should never be recorded): this goes in `config.yaml`;
   - **each person**, if you want to set the names that appear in transcripts.

### 5. Fill in `.env` (secrets)

```sh
cp .env.example .env
open -e .env       # or any editor
```

```ini
DISCORD_TOKEN=...          # from step 4 (only for recording with the bot)
GROQ_API_KEY=...           # from step 3
ANTHROPIC_API_KEY=...      # from step 3
DATA_DIR=./data            # where recordings, transcripts and summaries are saved
CONFIG_PATH=./config.yaml
```

`.env` is git-ignored, so it never gets committed.

### 6. Fill in `config.yaml` (settings)

```sh
cp config.example.yaml config.yaml
```

The settings worth filling in on day one:

```yaml
recording:
  ignore_users:
    - "234395307759108106"     # your music bot's user ID: never recorded

speakers:                      # names used in transcripts (defaults to Discord display names)
  "123456789012345678": Rees
  "223456789012345678": Sam

transcription:
  language: en                 # set it if everyone speaks one language
  prompt: "Names and terms: Rees, Sam, Waterdeep, Strahd."   # helps Whisper spell names right

transcript:
  timezone: America/New_York

summary:
  context: |
    Weekly D&D campaign. Rees is the DM; Sam plays Thorin.
  include:
    - Main topics discussed
    - Decisions made
    - Action items and who owns them
  exclude:
    - Small talk and off-topic banter
```

Every setting is optional, and anything you leave out uses a sensible default. The full list is in
[Configuration](#configuration). If you make a typo, the next command stops with an error naming
the setting.

### 7. Check everything works

```sh
npm run doctor              # checks Node, ffmpeg, voice libraries, .env and config.yaml
npm run doctor -- --online  # also tests each API key (and lists the servers the bot is in)
npm test                    # all tests should pass
```

`doctor` prints a line per check (`✓` fine, `!` warning, `✗` must fix), each with the fix.

---

## Usage

Every recording becomes a **session folder**: `data/sessions/<session-id>/`. Commands take either
the full path or just the folder name (e.g. `craig-aBcD1234`).

### A. Import a Craig recording

[Craig](https://craig.chat) is a Discord bot that records each person on a separate track.

1. Invite Craig to your server and record with `/join`. Stop with `/stop`.
2. Open the download link Craig sends and download the **FLAC** multi-track option (a `.zip` with one file per person).
3. Run:

```sh
npm run import:craig -- ~/Downloads/craig-XXXX.zip               # import + transcribe
npm run import:craig -- ~/Downloads/craig-XXXX.zip --summarize   # import + transcribe + summarize
```

It reads who's who from Craig's `info.txt` and skips anyone in `recording.ignore_users`. It then
splits each person's track into utterances wherever there's silence, and transcribes them. You
can pass an already-unzipped folder instead of the `.zip`.

### B. Record with the bot (test version)

This is the test that checks the bot can hear Discord's end-to-end encrypted voice. It records
until you press Ctrl+C, or for a set number of minutes:

```sh
npm run spike:receive -- --channel <voiceChannelId>
npm run spike:receive -- --channel <voiceChannelId> --minutes 20
```

When it stops, it prints a report per speaker and the folder it saved to. To listen back:

```sh
npm run spike:mix -- <session>          # renders render/mix.wav and one WAV per speaker
open data/sessions/<session>/render/mix.wav
```

**For the first run**, please include:
- 2+ people talking;
- the music bot playing;
- someone leaving and rejoining partway;
- ~15+ minutes in total.

It passes if:
- everyone who spoke has audio and the music bot has none;
- `mix.wav` sounds like the call;
- recording survives the leave and rejoin.

If anything's off, send the report plus the session's `debug.log` and `report.json`.

### C. Transcribe

```sh
npm run transcribe -- <session>                 # → transcript.md
npm run transcribe -- <session> --summarize     # → transcript.md + summary.md
```

How it works:
- Each speaker's utterances are grouped into batches of up to 10 minutes and sent to Groq's Whisper.
- Every line is placed back at the moment it was actually said.
- Common Whisper inventions over silence ("Thanks for watching!") are dropped.

Batches already transcribed are reused, so re-running doesn't cost anything.

**Changed a speaker's name or the line-joining settings?** Run `npm run merge -- <session>`. It
rebuilds `transcript.md` in a second without calling the API.

### D. Summarize

```sh
npm run summarize -- <session>            # → summary.md
npm run summarize -- <session> --force    # redo everything, ignoring saved work
```

It runs in two passes:
1. The transcript is read in 20-minute chunks, pulling out whatever matches your `summary.include` rules and dropping anything matching `summary.exclude`.
2. Claude writes one summary: a section per include rule, at your chosen `detail` level, with `[HH:MM:SS]` references if `cite_timestamps` is on.

**Tuning:** edit `summary:` in `config.yaml` and run it again. Chunks whose inputs didn't change
are reused, so changing only `detail` or `cite_timestamps` just redoes the final write-up.

### E. Shared accounts (two people on one mic)

The bot records one track per Discord **account**. If two people share an account (or one person
plays several roles, like a DM who narrates and voices NPCs), their lines all come out under one
name. You can't split them apart from the audio, but Claude can usually tell from context who's
speaking. List the identities in `config.yaml`:

```yaml
speakers:
  "123456789012345678":
    name: Rees
    disambiguate:
      - "DM — narrates the world and voices NPCs"
      - "Hamqueef — a player character"
```

The text before ` — ` is the name used in transcripts; the rest is a hint for Claude.
`npm run summarize` then runs an extra pass first:

- Each of that account's lines is labelled with one identity. Claude sees the whole conversation, not just this account.
- `transcript.speakers.md` is written next to `transcript.md`. Lines are shown as `Hamqueef (?)`
  when Claude was guessing, and as `Rees (unclear)` when it couldn't tell.
- The summary is built from the relabelled transcript. `transcript.md` itself stays exactly as recorded.

To check the labels without summarizing, run `npm run disambiguate -- <session>`. Short replies
like "Yeah" are often guesses; that's expected and rarely matters for the summary. Accounts
without `disambiguate` are unaffected. Their lines are joined into turns as usual, while a shared
account's lines are kept separate so each one can be labelled.

### F. The web app

A small web app to browse sessions, read transcripts and summaries, run each step, and edit every
setting (ignore list, speaker names, shared accounts, summary rules, prompts). It runs on the Mac
and works in any browser, including your phone.

**On the Mac:**

```sh
npm run web:build      # once, and again after pulling updates
npm run app            # keep this running; Ctrl+C to stop
```

Open <http://localhost:4400> and sign in with `APP_PASSWORD` from `.env`.

**On your phone:** use [Tailscale](https://tailscale.com), a free private network between your own devices:

1. Install Tailscale on the Mac and on your phone, and sign in to the same account on both.
2. In the Tailscale app, note the Mac's name (e.g. `mac-mini`).
3. On the phone, open `http://mac-mini:4400`. Use *Add to Home Screen* to make it feel like an app.

If macOS asks whether `node` may accept incoming connections, allow it.

What's in it:

- **Sessions**: every recording, newest first. Each session has:
  - its **Summary**, **Speakers labelled** and **Transcript** (searchable, filter by speaker, download);
  - buttons for **Transcribe**, **Rebuild transcript**, **Label speakers** and **Summarize**, with a live log.
- **Settings**:
  - **Recording & people**: pick people to ignore or name from anyone seen in past recordings, and turn on *Shared account* for a Discord account several people use.
  - **Summary**, **Transcription**: the rest of the options.
  - **Prompts**: edit Claude's instructions. The built-in prompts are kept, so you can always revert.
  - **YAML**: raw editing of `config.yaml`.

  Saving keeps the comments in `config.yaml`.
- **Record**: for now it shows which keys are set. Joining a voice channel from here is the next update.

**Security:** the app controls a bot that records people, so it always needs the password, and
it's only reachable on your Mac and your Tailscale devices. Don't expose port 4400 to the internet.

**Later on Vercel:** the pages can be hosted on Vercel, but the bot can't. It needs a
long-running voice connection and local disk, which Vercel doesn't offer, so the bot and API
stay on the Mac (or an always-on server). The pages are built to call the API from another
site: build with `VITE_API_URL=https://<your API address>` and list the Vercel URL in
`APP_CORS_ORIGINS`.

### What's in a session folder

```
data/sessions/<session-id>/
  transcript.md             ← the transcript
  transcript.speakers.md    ← relabelled transcript (only with shared accounts)
  summary.md                ← the summary
  session.json              when/where it was recorded
  participants.json         Discord names at recording time
  audio/<userId>/<start>.ogg  one file per utterance (open with VLC)
  transcripts/<userId>.json  per-speaker transcription with exact times
  segments.json             merged transcript, machine-readable
  summary/meta.json         model, prompt versions, token usage of the last summary
  transcription/, summary/extract/   saved intermediate results (make re-runs free)
```

---

## Configuration

`config.yaml`. Every key is optional; defaults are shown. Discord IDs can be quoted or not.

| Setting | Default | What it does |
|---|---|---|
| `recording.ignore_users` | `[]` | User IDs never recorded (music bots, etc.) |
| `recording.ignore_bots` | `true` | Skip every bot account |
| `recording.silence_ms` | `1000` | Silence that ends an utterance (also used to split Craig tracks) |
| `recording.audio_retention_days` | `30` | How long to keep audio once processed (used once the full bot lands) |
| `speakers` | `{}` | `userId: Name` for transcripts (otherwise the Discord display name), or `userId: {name, disambiguate: [...]}` for a [shared account](#e-shared-accounts-two-people-on-one-mic) |
| `transcription.provider` | `groq` | `groq` or `openai` |
| `transcription.model` | per provider | Groq: `whisper-large-v3-turbo`; OpenAI: `whisper-1` |
| `transcription.base_url` | per provider | Any OpenAI-compatible transcription server |
| `transcription.language` | auto-detect | e.g. `en`; more accurate when set |
| `transcription.prompt` | none | Names/terms Whisper should spell correctly |
| `transcription.batch_minutes` | `10` | Audio per upload (max 20; Groq's free tier caps uploads at 25 MB) |
| `transcription.concurrency` | `2` | Parallel uploads |
| `transcription.min_utterance_ms` | `400` | Ignore sounds shorter than this |
| `transcript.merge_gap_seconds` | `2` | Join a speaker's consecutive lines if they paused at most this long |
| `transcript.max_line_seconds` | `60` | …but never into a line longer than this |
| `transcript.timezone` | machine's | Time zone for dates in the header |
| `summary.model` | `claude-opus-5` | Any Claude model ID (`claude-sonnet-5` is cheaper) |
| `summary.detail` | `medium` | `low` (highlights), `medium` (organised notes), `high` (thorough) |
| `summary.cite_timestamps` | `true` | Add `[HH:MM:SS]` after each point |
| `summary.include` | topics, decisions, action items, open questions | What to capture; one section each |
| `summary.exclude` | `[]` | What to leave out even if it matches an include rule |
| `summary.context` | none | Background for Claude: what the calls are, who's who |
| `summary.chunk_minutes` | `20` | Size of each piece of the transcript read in the first pass |
| `summary.extract_effort` / `synthesize_effort` | `medium` / `high` | How hard Claude thinks in each pass (`low` … `max`) |
| `summary.fallbacks` | `true` | If Claude declines a request, retry it on Anthropic's recommended backup model |
| `summary.prompts_dir` | none | Folder with your own `extract.md` / `synthesize.md` / `disambiguate.md` (start from `prompts/*.v1.md`) |

Secrets never go in `config.yaml`; they live in `.env`.

## Costs

Both APIs charge by usage, so check current pricing before relying on these rough figures.

- **Transcription (Groq, `whisper-large-v3-turbo`):** billed per hour of *speech*, not call
  length. That's about $0.04 per hour of audio, so typically a few cents per call.
- **Summary (Claude):** a 3-hour call is roughly 40–50k tokens of transcript. Expect well under
  a few dollars on `claude-opus-5`, and less on `claude-sonnet-5`. `summary/meta.json` records
  the exact token counts for each run.

## Troubleshooting

| Problem | Fix |
|---|---|
| Mac app: "Session Bot can't be opened" / "developer cannot be verified" | System Settings → Privacy & Security → **Open Anyway** (once per version). |
| Mac app: "Session Bot is damaged and can't be opened" | macOS quarantine on unsigned downloads. In Terminal: `xattr -dr com.apple.quarantine "/Applications/Session Bot.app"`, then open it. |
| Mac app: "Port 4400 is already in use" | Another copy is running (or `npm run app`). Quit it. |
| Mac app: menu says "Discord bot is off" | Add the token under Settings → Keys & phone. |
| macOS asks whether Session Bot may accept incoming connections | Allow it if you want phone access; deny if you only use it on the Mac. |
| Not sure what's wrong | Run `npm run doctor -- --online` first; it checks the tools, keys and config, and says how to fix each problem. |
| The app says "Web UI not built yet" | Run `npm run web:build`, then restart `npm run app`. |
| Phone can't open the app | Both devices signed in to Tailscale? Is `npm run app` still running on the Mac? Allow `node` in the macOS firewall prompt. |
| `DISCORD_TOKEN is not set` / `No API key for groq` / `ANTHROPIC_API_KEY is not set` | Add the key to `.env`, and run commands from the project folder (that's where `.env` is read). |
| `Discord login failed` | The token is wrong or was reset. Copy a fresh one from the Developer Portal → Bot. |
| `Voice connection did not become Ready` | The bot needs **View Channels** and **Connect** on that voice channel. Also check the channel ID. |
| `No audio captured from anyone` | People were muted, or voice receive isn't working. Send `debug.log`. |
| `ffmpeg … not found` / `spawn ffmpeg ENOENT` | `brew install ffmpeg`, or set `FFMPEG_PATH` in `.env`. |
| Transcription `413` / file too large | Lower `transcription.batch_minutes`. |
| Transcription `401` | Wrong `GROQ_API_KEY`. |
| Names spelled wrong in the transcript | Add them to `transcription.prompt` and re-run `transcribe`. Changing the prompt (or language) re-transcribes automatically. |
| `Model not found` | Check `summary.model` is a valid Claude model ID. |
| `Claude declined the … step` | Rare. Check `summary.context` and rules, or keep `summary.fallbacks: true`. |
| `config.yaml is invalid` | The message names the setting. The usual causes are a typo in a key name or bad indentation. |
| `… already has audio; delete it to re-import` | That Craig recording was already imported. Delete `data/sessions/craig-<id>` to redo it. |

## Development

```sh
npm run typecheck
npm test              # ffmpeg-based tests are skipped if ffmpeg isn't installed (or set FFMPEG_PATH)
npm run check:deps    # voice/DAVE native libraries load on this machine
```

GitHub Actions runs all three on Linux and Apple Silicon macOS for every push.

```
src/
  audio/          Ogg Opus writer/reader, ffmpeg decode
  recording/      per-utterance recorder, ignore filters
  spike/          the recording test (receive.ts) and listening tool (mix.ts)
  import/         Craig import, silence detection
  transcription/  Transcriber interface, Groq/OpenAI client, batching, timestamp mapping
  transcript/     merge into transcript.md
  summary/        chunking, Claude calls, two-pass summarizer
  config/         config.yaml schema + loader
  session/        session folder layout (the contract between every step)
  cli/            the npm run commands
prompts/          versioned summary prompts
```

The roadmap and design decisions are in [PLAN.md](PLAN.md).
