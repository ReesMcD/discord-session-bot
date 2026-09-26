# Testing on the Mac with Claude Code (Remote Control)

This guide is for running the first live tests on your Mac, with Claude Code doing the work on the
machine. You follow along from the Claude app on your phone or on the web. It's written for you
and for Claude Code. Claude Code also reads [CLAUDE.md](CLAUDE.md) automatically.

Full setup details are in the [README](README.md#setup). This file covers the order to do things
in, what to check, and what to send back.

## 0. Start a Remote Control session on the Mac

Remote Control runs Claude Code on your Mac, and you drive it from the Claude app. It has to be
started on the Mac itself:

```sh
# one-time: install Claude Code (https://code.claude.com/docs) and sign in
cd ~
git clone https://github.com/ReesMcD/discord-session-bot.git
cd discord-session-bot
claude remote-control
```

The session then shows up in the Claude Code app, where you can pick it up from anywhere.

**Keep the Mac awake** for long tests. Run this in a second terminal and leave it open:

```sh
caffeinate -dimsu
```

## 1. Secrets: do this part yourself

Don't paste API keys or the Discord token into the chat. Open the files on the Mac and fill them in
by hand:

```sh
cp .env.example .env && open -e .env                    # DISCORD_TOKEN, GROQ_API_KEY, ANTHROPIC_API_KEY
cp config.example.yaml config.yaml && open -e config.yaml
```

In `config.yaml`, set at least:
- `recording.ignore_users`: your music bot's user ID;
- `speakers`: names for each person's ID;
- `summary.context`: a line about what the calls are.

(The README's [Discord bot](README.md#4-create-the-discord-bot-only-for-recording-with-the-bot) section shows how to get the IDs.)

## 2. Test plan

Hand each step to Claude, e.g. *"Do step 2.1 of TESTING.md and report the result."* Tick them off
as you go.

### 2.1 Install and check (5 min)

```sh
brew install node ffmpeg      # skip what's already installed
npm install
npm run doctor -- --online
npm test
```

- [ ] `doctor` shows no `✗` lines. The Discord line lists your server.
- [ ] `npm test` passes.

If `doctor` fails, fix what it says before going on.

### 2.2 Transcription and summary with a Craig recording (optional, 10 min)

This checks Groq and Claude without the bot. Record a few minutes in Craig, download the **FLAC**
multi-track zip, and put it on the Mac.

```sh
npm run import:craig -- ~/Downloads/craig-XXXX.zip --summarize
```

- [ ] `data/sessions/craig-<id>/transcript.md` exists, with the right names, sensible text, and timestamps that match the call.
- [ ] `summary.md` exists and follows your include/exclude rules.

### 2.3 Voice-receive test with the bot (the main one, 20 min)

This is the go/no-go test: can the bot hear Discord's end-to-end encrypted voice?

1. Get 2+ people into a voice channel, with the music bot playing something.
2. Copy the voice channel's ID and start the recorder with a time limit:

   ```sh
   npm run spike:receive -- --channel <voiceChannelId> --minutes 20
   ```

   > **For Claude Code:** this runs for 20 minutes, longer than a foreground command may run.
   > Start it **in the background** and check its output while it runs. Don't stop it early unless
   > it errors.

3. During the call:
   - [ ] talk normally, sometimes over each other;
   - [ ] about halfway through, have someone **leave and rejoin** (this changes the encryption keys, the riskiest moment);
   - [ ] keep the music bot playing.
4. When it finishes, render the audio and transcribe it:

   ```sh
   npm run spike:mix -- <session folder printed at the end>
   npm run transcribe -- <session folder> --summarize
   ```

**It passes if:**
- [ ] everyone who talked is in the report (`REC` lines), and the music bot is listed as `SKIP` and has no audio folder;
- [ ] `render/mix.wav` sounds like the call: clear, no robotic garbling, voices in sync;
- [ ] audio continues after the leave and rejoin (check the report around that time);
- [ ] `Decrypt-failure debug lines` is small (a handful around the leave and rejoin is expected);
- [ ] `transcript.md` reads correctly.

## 3. What to send back

Paste these into this chat (the cloud session that built the code), or into a new one:

- the **report** printed at the end of `spike:receive`;
- `data/sessions/<session>/report.json`;
- if anything went wrong: `debug.log` from the session folder (it can be big, so the last ~200 lines are fine) and the exact error text;
- a quick verdict on how `mix.wav` and `transcript.md` sound and read.

Don't send: `.env`, audio files, or anything with keys in it. Transcripts are fine if everyone on
the call is OK with that.

## If something breaks

- Start with `npm run doctor -- --online` and the README's [Troubleshooting](README.md#troubleshooting) table.
- **The bot joins but records nobody:** that's the main risk this test exists to find. Send
  `debug.log` and `report.json`. There's a fallback plan: a Python recorder that writes the same
  files, with everything after recording unchanged.
- **Stop a stuck recording:** Ctrl+C (or ask Claude to stop the background task). What was
  already recorded is kept.
