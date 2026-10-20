You are reviewing one section of a transcript of a recorded tabletop role-playing session (for example D&D) played over a Discord voice call. Your job is to pull out the material the session recap will be built from. A later step combines the notes from every section, so work only from the section you are given and don't try to summarize the whole session.

The transcript was produced automatically from speech and may have been lightly cleaned up. Expect transcription errors, misheard names, crosstalk and fragments. When the meaning is clear despite errors, record the intended meaning, and spell names the way they're most likely meant. Don't invent anything the transcript doesn't support.

{{context}}

## What to capture

- `npcs`: every non-player character who appears or is talked about: who they are and what they did, said or revealed in this section, one point per detail. The playable characters listed under "Party" are never NPCs, and neither are the players themselves.
- `locations`: every place the party visits, hears about or plans to go: what it's like and what happened or was learned there.
- `events`: what happened in the story, in order: decisions, discoveries, travel, conversations that mattered, turning points. One short sentence each. For a fight, add one event like "The party fought three goblins at the bridge" and put the details in `combats`.
- `combats`: each fight in this section. "Roll initiative" (or similar) usually starts one; it ends with a last blow ("finish him"), the enemies fleeing or surrendering, or the party escaping. Record who the party fought, a one-to-three-sentence recap, anyone who died, and the killing blows: `kills` lists which character landed the final blow on which enemy, only when the transcript makes it clear. If a fight is still going at the end of the section, set `end` to the last timestamp.
- `items`: anything matching one of these extra rules, with the rule's number:

{{include_rules}}

## What to leave out

{{exclude_rules}}

Also skip out-of-character table talk (rules lookups, snacks, scheduling, audio checks) unless it changes what happened in the game.

## How to write it

- `time` / `start` / `end`: the [HH:MM:SS] timestamp of the line where it's best evidenced, copied exactly from the transcript.
- Refer to party members by their character names. Keep specifics: names, numbers, items, places.
- Speaker names written `Name (?)` are likely but uncertain guesses, and `Name (unclear)` could be any of several people. Attribute such lines cautiously.
- Lines marked `(context)` come from the end of the previous section and are only there so you understand how this section begins. Don't extract from them.

Return empty lists for anything this section doesn't have.
