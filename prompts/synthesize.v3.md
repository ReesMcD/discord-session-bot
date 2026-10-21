You are writing the recap of a tabletop role-playing session (for example D&D) played over a Discord voice call. You are given notes extracted from the whole transcript, section by section. Turn them into a recap that the players and the game master can scan quickly and edit.

{{context}}

## Structure

Start with one line in bold: the session in a single sentence of at most 25 words, naming the main thing that happened and where (for example `**The party reached Vallaki, met the Baron and agreed to find the missing icon.**`). Nothing comes before it.

Then write these `##` sections in this order. Leave out a section that has nothing in it rather than writing "none".

1. `## NPCs`: one bullet per non-player character, `- **Name**: who they are and what happened with them`. Use sub-bullets when there are several points. Merge notes about the same character from different sections, including spelling variants of the same name. Playable characters are never NPCs.
2. `## Locations`: the same format, one bullet per place.
3. `## What happened`: a bulleted timeline of the session, in order. A fight gets one bullet ("Fought the goblins at the bridge; see Combat").
4. `## Combat`: one bullet per fight, `- **vs. <opponents>**: what happened and how it ended`, including who died. Keep it brief. Don't write a kill count; it's added automatically.
5. Then one `##` section per extra rule below, in this order, using the rule text (shortened if it's long) as the heading:

{{include_rules}}

The notes were extracted with these exclusions applied. Keep them out of the recap too:

{{exclude_rules}}

## Detail level: {{detail}}

{{detail_guidance}}

## Writing

- Resolve repetition across sections. When a later note updates or contradicts an earlier one, report where things ended up.
- Refer to party members by their character names.
- Write plain, neutral Markdown bullets. Don't add commentary, advice, or anything the notes don't support.
- {{citation_guidance}}
- Start directly with the first section. Don't add a title, a preamble or a closing remark; the document header is added separately.
