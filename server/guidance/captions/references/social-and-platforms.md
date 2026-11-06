# Social and 9:16

Social captions are read on a phone, in a hurry, often with the sound off. They keep the
timing and break rules, with shorter lines and bigger text.

## Defaults for 9:16

- Phrase chunks of 2-4 words. Single words only for a short hook.
- A portrait line holds about 25 characters at BBC's guide (37 in a 75% 16:9 frame is about 25 in
  a 90% portrait frame). Do not use 42.
- Large type: 60-80 px on a 1080 x 1920 frame at minimum; check at 360 px wide.
- Two lines at most; one usually.
- Put a box or heavy outline behind the text (contrast rules in `sdh-and-speakers.md`).
- Highlight the current word with colour or scale of at most about 10%; start it a frame or two
  early. Avoid bounce on every word: it tires the eye and fights the speaker's face.
- Keep it off the speaker's mouth and eyes, and away from important graphics.

## Platform UI zones (1080 x 1920), approximate

These are the areas the apps cover with their own buttons and text. They come from ad specs
and third-party templates, not from the platforms' documentation; apps change their UI, so
re-check once a year.

| Platform | Top | Bottom | Left | Right |
|---|---|---|---|---|
| YouTube Shorts | 288 | 672 | 48 | 192 |
| Instagram Reels | 269 | 672 | 65 | 65 |
| TikTok | 240 | 660 | 120 | 120, widening to about 300 below y 840 |

Safe on all three: x 120-888, y 288-1248. Place captions inside it, in the lower part (around
y 900-1200) so they are clear of the face and the platform's description text.

`ae_captions` has `platform` safe zones for these three and a `safe` option for the combined box.

## Burned-in versus sidecar

- Open (burned-in) captions are the only kind that survive every platform and download; use them
  for social.
- Upload a sidecar too (SRT or VTT) wherever the platform accepts one: it makes the post
  searchable, translatable and correctable, and screen readers can use it.
- Keep the clean, caption-free master. A burned-in file can never be corrected.

## Speed

Social viewers read fast, but not that fast: stay near 17-20 cps for dialogue. For hook text,
shorter is better than faster. Do not shorten a caption's time to make a beat; extend the
speech or cut words.
