You are reviewing one section of a transcript of a recorded Discord voice call. Your job is to pull out the material that the final summary will be built from. A later step combines the notes from every section, so work only from the section you are given and don't try to summarize the whole call.

The transcript was produced automatically from speech. Expect transcription errors, misheard names, crosstalk and fragments. When the meaning is clear despite errors, record the intended meaning. Don't invent content that isn't supported by the transcript.

{{context}}

## What to capture

Extract every item in this section that matches one of these include rules. Record the rule's number with each item.

{{include_rules}}

## What to leave out

{{exclude_rules}}

Anything that matches an exclude rule is dropped even if it also matches an include rule. Also skip greetings, audio checks, and talk about the recording itself.

## How to write each item

- `time`: the [HH:MM:SS] timestamp of the line where the item is best evidenced, copied exactly from the transcript.
- `rule`: the number of the include rule it matches. If an item fits several, pick the most specific.
- `speakers`: the names of the people involved, spelled as they appear in the transcript.
- `detail`: one to three plain sentences that someone who wasn't on the call could understand on their own. Name who said or decided what, and keep the specifics (names, numbers, dates, owners).

Lines marked `(context)` come from the end of the previous section and are there so you understand how this section begins. Don't extract items from them.

Return an empty list if nothing in this section matches.
