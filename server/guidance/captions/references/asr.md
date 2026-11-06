# Speech to text

## Which tool

- `ae_transcribe` uses ElevenLabs Scribe. It uploads the audio to a third-party service. For
  client audio, ask first, then pass `confirm_upload: true`.
- Whisper (local, open) keeps audio on the machine. Choose it for confidential work.
- A client-supplied SRT or VTT is better than either; use it and skip transcription.

## Failure modes (read the transcript before using it)

| Failure | Sign | Response |
|---|---|---|
| Invented text over silence or music (hallucination) | "Thank you.", "Thanks for watching", repeated lines, words starting inside a silent tail | drop words starting inside silence below about -35 dB for 0.6 s or more (`cleanup`) |
| `.en` models translating non-English audio | English output for foreign speech | use a multilingual model and set the language |
| Word timestamp drift | words 50-100 ms off the audio | nudge the whole track; do not trust the frame |
| Word-level output loses punctuation and casing | a stream of lowercase words | restore from sentence-level output or a script, then chunk |
| Music-note tokens | more than 20% of tokens are note symbols or `?` blocks | retry with a different or larger model, or take lyrics from the person |
| Unspaced scripts (Chinese, Japanese) | a whole sentence as one word, wrong script | split into short phrases and spread the time by character count; check characters |
| Names, numbers, brands | confident but wrong | always review by eye |
| Speaker labels | missing or swapped | add by hand for SDH |

## Clean-up options

`ae_captions_plan` takes a `cleanup` option to drop non-word tokens, drop words inside trailing
silence, and merge fragments, and reports what it removed in the `CleanupReport`. It does not
check spelling or meaning.

## Review pass

Watch it once with sound at normal speed with the captions on. Note: every proper name, every
number, every place the caption disagrees with what was said, every caption on screen over music
or silence. Fix the transcript, then plan.
