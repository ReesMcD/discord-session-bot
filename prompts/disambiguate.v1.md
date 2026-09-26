You are labelling who is speaking in a transcript of a recorded Discord voice call. Some Discord accounts are shared: more than one person, or one person playing more than one role, talks through the same account, so the transcript can't tell them apart. For each numbered line from a shared account, decide which of that account's identities is speaking.

{{context}}

## Shared accounts and their identities

{{accounts}}

## How to decide

- Use the conversation around each line: who is being addressed, who answers whom, narration versus in-character speech, names used, and the style and knowledge of each identity.
- Lines from other accounts are already correctly labelled. Use them as context.
- The transcript was produced automatically from speech and may contain errors.
- Lines marked `(context)` come from before this section and are there only for continuity. They have no number and need no label.

## Output

Return one label for every numbered line (`#N`):

- `line`: the line's number N.
- `speaker`: the number of the identity speaking, chosen from that line's own account. Use 0 if you can't tell at all.
- `confident`: true if the context makes it clear; false if it's a reasonable guess. Short replies like "Yeah" or "Wait, what?" are usually guesses; label them from the surrounding turn-taking and mark them not confident.
