# File formats

Always ship a plain sidecar next to a burned-in version. It can be fixed, translated, searched
and read by assistive tech. The burned-in file cannot.

| Format | Use | Gotchas |
|---|---|---|
| SRT | the universal sidecar | see below |
| WebVTT (.vtt) | web video, HTML5 `<track>` | see below |
| TTML / IMSC | broadcast and streaming delivery | see below |
| SCC (CEA-608) | US broadcast and legacy | see below |

## SRT

- Numbered cues, a timecode line, text, a blank line.
- Timecode `00:00:01,000 --> 00:00:03,500`: a comma before the milliseconds.
- UTF-8 (no byte-order mark if the player is picky).
- No styling standard. `<i>` works in many players but is not part of the format; test the
  target. Colours and positions do not travel.
- Cue numbers must run in order, times must not go backwards.

## WebVTT

- First line `WEBVTT`, then a blank line.
- Timecode with a period: `00:00:01.000 --> 00:00:03.500`; hours may be dropped.
- Cue settings after the times: `line`, `position`, `align`, `size`.
- `<v Name>` voice spans identify speakers; `<i>`, `<b>`, `<c.class>` allowed.
- Style with `::cue` CSS. Support differs by player.
- `NOTE` blocks are comments.

## TTML and IMSC

- XML. Regions use `tts:origin` and `tts:extent` in percent, so they scale with the frame.
- `ttp:timeBase` (media, smpte); `ttp:frameRate` for frame timing; check the profile
  (IMSC1 text or image) the receiver needs.
- Styles are explicit in the file; BBC's guide gives the EBU-TT-D details for online delivery.
- A schema-valid file can still be rejected by a platform's own checker.

## SCC (CEA-608)

- Frame-based timecode, usually 29.97 drop-frame (semicolon before frames).
- 32 columns by 15 rows on screen; for pop-on captions, 2-4 lines are usable in practice.
- Heavy character restrictions; no full Unicode. Treat it as a delivery conversion, not an
  authoring format.

## After Effects

After Effects has no native SRT or VTT import. The chroma-ae MCP parses transcripts in Node
(`ae_captions` takes cues; `ae_captions_read` gives them back) and builds text layers. A caption
set in After Effects can be exported again as SRT, VTT or TTML with `ae_captions_export`. For
Premiere, `ae_export_mogrt` makes a caption template; Premiere's own caption track takes
SRT or VTT.
