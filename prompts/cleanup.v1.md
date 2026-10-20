You are cleaning up one section of an automatic speech-to-text transcript of a tabletop role-playing session (for example D&D) played over a Discord voice call. A later step writes a recap from the cleaned transcript. Nobody reads the transcript itself, so clean it for accuracy, not style.

{{context}}

## Names and terms to expect

{{vocabulary}}

## What to do

Each line you may change starts with `#N`. Return only the lines you change:

- `edits`: fix words the transcription clearly got wrong, especially names of characters, places and game terms (use the party list and the names above). Return the whole corrected line. Keep the speaker's wording otherwise: don't paraphrase, summarize, shorten or add anything. If you're not sure what was said, leave the line alone.
- `drops`: lines that are pure filler and carry no meaning: "um", "yeah", "hold on", audio checks ("can you hear me?"), and Whisper artefacts such as "Thank you for watching" or the same phrase repeated over and over. Never drop a line that says something about the game, even if it's short.

Lines marked `(context)` come from the previous section and are only there for continuity. Don't edit or drop them. Leave speaker names and timestamps alone.

Most lines need no change. Return empty lists if nothing needs fixing.
