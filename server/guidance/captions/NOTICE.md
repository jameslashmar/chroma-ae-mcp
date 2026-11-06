# Sources and licences

This skill is Chroma's own synthesis, written in its own words. Standards are cited by number
and link; no style guide is quoted at length. Researched 2026-11-06.

## Standards and guides (facts and numbers, linked)

| Source | Used for |
|---|---|
| [Netflix English (USA) Timed Text Style Guide](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide) | 20 / 17 cps, 42 characters, 2 lines, duration limits, SDH conventions |
| [Netflix Subtitle Timing Guidelines](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines) | minimum gap, closing gaps, shot-change rules |
| [BBC Subtitle Guidelines](https://www.bbc.co.uk/accessibility/forproducts/guides/subtitles/) | words per minute, line length, gaps, synchronisation, speaker colours |
| [DCMP Captioning Key](https://dcmp.org/learn/597-captioning-key---text) | 32 characters, minimum and maximum duration, presentation rates |
| [Ofcom TV access services](https://www.ofcom.org.uk/tv-radio-and-on-demand/information-for-industry/guidance/tv-access-services) | UK broadcast subtitling duties and quality expectations |
| [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) (1.2.2, 1.2.4, 1.4.3) | caption requirements and the 4.5:1 text contrast |
| ITU-R BT.1359-1 | audio/video sync tolerances |

## Skills and projects whose ideas were adapted

| Source | Licence | Used for |
|---|---|---|
| [github/awesome-copilot: caption-qa](https://github.com/github/awesome-copilot) | MIT | the idea of a per-standard lint (cps, line length, duration, gaps), "retime before rewording", default-standard rule |
| [vargHQ/skills: caption-styles](https://github.com/vargHQ/skills) | MIT | caption style families for social, and how they differ in chunk size |
| [clueso-ai/skills: add-ai-captions, add-animated-captions](https://github.com/clueso-ai/skills) | Apache-2.0 | workflow order (transcribe, review, style, burn in) and animated word-highlight options |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) (captions references and rules) | Apache-2.0, (c) HeyGen | Whisper failure modes (invented text over silence, `.en` models translating, over 20% music-note tokens), word grouping by energy, the plain-sidecar habit |
| [Remotion captions](https://www.remotion.dev/docs/captions) | documentation, linked only | what `createTikTokStyleCaptions` does |

## Ideas only (no licence stated in the downloaded copy; nothing copied)

45ck/content-machine karaoke-ass-captions, AI-Builder-Club karaoke-captions, HUSS41N
shorts-text-safe-zones, JosiahSiegel viral-video-animated-captions, appariciojunior captions,
browser-use video-use, calesthio captions-media-accessibility, damionrashford ffmpeg-captions,
katareayush video-captions, lattifai omnicaptions, social-media-skills captions-and-clipping,
video-db video-subtitles. Read for the shape of the problem (karaoke timing, safe zones, ffmpeg
burn-in); every rule here was re-derived from the published standards above.

A commercial caption product's marketing page was read for feature ideas only (word-level
editing, per-standard checks). Nothing copied.

## Numbers computed here

Contrast figures for a black box behind white text were computed with the WCAG relative
luminance formula (`references/sdh-and-speakers.md` states the background they assume).
Platform UI zones are approximate, from ad specs and third-party templates.
