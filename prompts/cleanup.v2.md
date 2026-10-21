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

## People not on the roster yet

{{unpaired}}

For each person listed above who speaks in this section, add an entry to `unpaired` with their `U` number:

- `role`: `new_player` if they're playing a character (they act in the game, others address them by a character name, they roll for their character), or `guest` if they're only watching or chatting.
- `character`: the name of the character they play, if the transcript makes it clear (e.g. someone says "Garrick, you're up"). Leave it empty if you can't tell; don't guess a name.
- `time`: the [HH:MM:SS] timestamp of the line that shows it most clearly.

Skip people who don't speak in this section, and anyone not listed.
