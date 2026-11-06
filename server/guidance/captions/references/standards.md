# Standards

Pick one standard per deliverable and say which. Numbers below are from the guides linked in the
last column; check the live page before a contractual delivery, as platforms revise them.

| Standard | Reading speed | Line length | Lines | Duration | Gap | Source |
|---|---|---|---|---|---|---|
| Netflix English, adult | 20 cps | 42 characters | 2 | min 5/6 s (20 frames at 24 fps), max 7 s | 2 frames minimum | [style guide](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide) |
| Netflix English, children's | 17 cps | 42 | 2 | same | same | same |
| BBC | 160-180 wpm, about 0.33 s a word | 37 broadcast (Teletext-derived); online 68% of a 16:9 frame | 2 | not fixed | if left, 1 s minimum, 1.5 s better | [BBC guidelines](https://www.bbc.co.uk/accessibility/forproducts/guides/subtitles/) |
| DCMP Captioning Key | 130-160 wpm by level | 32 | 2 | min 40 frames, max 6 s | not fixed | [DCMP text](https://dcmp.org/learn/597-captioning-key---text), [rate](https://dcmp.org/learn/601-captioning-key---presentation-rate) |
| Ofcom (UK broadcast) | no per-cue limits | - | - | sets access-service quotas and quality expectations | - | [Ofcom](https://www.ofcom.org.uk/tv-radio-and-on-demand/information-for-industry/guidance/tv-access-services) |
| WCAG 2.2 | no numbers | - | - | - | - | [1.2.2](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html), [1.2.4](https://www.w3.org/WAI/WCAG22/Understanding/captions-live.html), [1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) |

Notes:
- BBC's 160-180 wpm is for live subtitles (raised from 130-150) and is the recommended speed for
  prerecorded work too; the per-word time (0.33-0.375 s) and the 1 s gap are guidance. Report
  them as warnings, not failures. The 37-character figure is the broadcast limit, reduced when
  coloured text is used. Check the current page before quoting a limit to a client.
- Netflix's timing guide also closes small gaps: where two captions are 3 to 11 frames apart at
  24 fps, close the gap to 2 frames. Shot-change rules are in `timing-and-breaks.md`.
- Characters per second (cps) counts every character in the caption, spaces included, divided by
  the time on screen. Words per minute (wpm) counts words. 20 cps is roughly 200 wpm at 6 letters a
  word, which is why Netflix is looser than the BBC.
- DCMP's three levels (lower, middle, upper) set 130, 140 and 160 wpm.

## WCAG in one paragraph

1.2.2 Captions (Prerecorded), level A: synchronised captions for the audio in prerecorded video,
except where the video is a clearly labelled media alternative for text. 1.2.4 Captions (Live),
level AA: captions for live audio. 1.4.3 Contrast (Minimum), level AA: text at least 4.5:1 against
its background (3:1 for large text); this applies to captions you style yourself. WCAG sets no
reading speed. Use a broadcast or streaming standard for that.

## Audio and caption sync

ITU-R BT.1359-1 gives the tolerances for audio against picture (as recalled from the
Recommendation; confirm the figures before quoting them): detectable at about +45 ms when audio
leads and -125 ms when audio lags, acceptable up to about +90 ms and -185 ms. Captions are
judged against the speaker's lips by the same eyes, so a start within about 2 frames of speech
onset is safe, and the 50-100 ms drift in word timestamps (`asr.md`) sits at the edge of
detectable. A caption that is early reads better than one that is late.
