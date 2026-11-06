import { describe, expect, it } from "vitest";
import { countTtmlCues, formatTime, parseSubtitles, writeSrt, writeTtml, writeVtt, type ExportCue } from "../src/caption-formats.js";

const SAMPLE: ExportCue[] = [
  { start: 1, end: 3.5, lines: ["Hello there,", "friends."] },
  { start: 4, end: 6.25, lines: ["Second one"] },
];

describe("formatTime", () => {
  it("pads, rounds to ms and rolls over hours", () => {
    expect(formatTime(0, ",")).toBe("00:00:00,000");
    expect(formatTime(3725.4567, ".")).toBe("01:02:05.457");
    expect(formatTime(360000, ".")).toBe("100:00:00.000");
    expect(formatTime(-2, ".")).toBe("00:00:00.000");
    expect(formatTime(0.0004, ".")).toBe("00:00:00.000");
    expect(formatTime(0.0005, ".")).toBe("00:00:00.001");
  });
});

describe("writeSrt", () => {
  it("writes numbered cues with CRLF and a blank line between", () => {
    const r = writeSrt(SAMPLE);
    expect(r.text).toBe("1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there,\r\nfriends.\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,250\r\nSecond one\r\n");
    expect(r.text.startsWith("﻿")).toBe(false);
    expect(r.warnings).toEqual([]);
  });
  it("writes <i> for italics and warns once", () => {
    const r = writeSrt([{ ...SAMPLE[0], italic: true }, { ...SAMPLE[1], italic: true }]);
    expect(r.text).toContain("<i>Hello there,</i>\r\n<i>friends.</i>");
    expect(r.warnings).toHaveLength(1);
  });
  it("makes an end that is not after the start 1 ms long", () => {
    expect(writeSrt([{ start: 2, end: 2, lines: ["x"] }]).text).toContain("00:00:02,000 --> 00:00:02,001");
  });
});

describe("writeVtt", () => {
  it("writes the header, period milliseconds and LF", () => {
    expect(writeVtt(SAMPLE).text).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello there,\nfriends.\n\n00:00:04.000 --> 00:00:06.250\nSecond one\n");
  });
  it("escapes, wraps italics and voices, and writes cue settings", () => {
    const r = writeVtt([{ start: 0, end: 1, lines: ["Tom & <Jerry>"], italic: true, speaker: "ANNA", position: { line_pct: 85, align: "center", region_width_pct: 80 } }]);
    expect(r.text).toContain("00:00:00.000 --> 00:00:01.000 line:85% position:50% align:center size:80%\n<v ANNA><i>Tom &amp; &lt;Jerry&gt;</i></v>\n");
  });
  it("leaves the voice out when asked", () => {
    expect(writeVtt([{ start: 0, end: 1, lines: ["Hi"], speaker: "ANNA" }], { speaker_voice: false }).text).not.toContain("<v");
  });
  it("aligns start without a position", () => {
    expect(writeVtt([{ start: 0, end: 1, lines: ["Hi"], position: { align: "start" } }]).text).toContain("1.000 align:start\n");
  });
});

describe("writeTtml", () => {
  it("writes the IMSC text profile with one region for the default position", () => {
    const r = writeTtml(SAMPLE);
    expect(r.text).toContain('xmlns="http://www.w3.org/ns/ttml"');
    expect(r.text).toContain('xmlns:tts="http://www.w3.org/ns/ttml#styling"');
    expect(r.text).toContain('xmlns:ttp="http://www.w3.org/ns/ttml#parameter"');
    expect(r.text).toContain('ttp:timeBase="media"');
    expect(r.text).toContain('imsc1.1/text');
    expect(r.text.match(/<region /g)).toHaveLength(1);
    expect(r.text).toContain('<region xml:id="r1" tts:origin="10% 80%" tts:extent="80% 15%" tts:textAlign="center" tts:displayAlign="after"/>');
    expect(r.text).toContain('<p xml:id="c1" region="r1" begin="00:00:01.000" end="00:00:03.500">Hello there,<br/>friends.</p>');
    expect(countTtmlCues(r.text)).toBe(2);
  });
  it("makes one region per distinct position and escapes XML", () => {
    const r = writeTtml([
      { start: 0, end: 1, lines: ['A & "B"'], italic: true, position: { line_pct: 10, align: "start" } },
      { start: 2, end: 3, lines: ["x"], position: { line_pct: 10, align: "start" } },
      { start: 4, end: 5, lines: ["y"] },
    ]);
    expect(r.text.match(/<region /g)).toHaveLength(2);
    expect(r.text).toContain('tts:origin="10% 10%" tts:extent="80% 15%" tts:textAlign="start" tts:displayAlign="before"');
    expect(r.text).toContain('<span tts:fontStyle="italic">A &amp; &quot;B&quot;</span>');
  });
});

describe("parseSubtitles", () => {
  it("reads SRT with a BOM and CRLF", () => {
    const text = "﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>there</i>\r\nfriends\r\n\r\n2\r\n00:01:00,5 --> 01:00:00,000\r\n{\\an8}Top\r\n";
    const r = parseSubtitles(text);
    expect(r.format).toBe("srt");
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0]).toMatchObject({ n: 1, id: "1", start: 1, end: 2.5, lines: ["Hello there", "friends"], italic: true });
    expect(r.cues[1]).toMatchObject({ start: 60.5, end: 3600, lines: ["Top"] });
  });
  it("reads VTT with a header, NOTE/STYLE blocks, ids, settings, voice and entities", () => {
    const text = [
      "WEBVTT - title",
      "",
      "NOTE a comment",
      "over two lines",
      "",
      "STYLE",
      "::cue { color: red }",
      "",
      "intro",
      "00:01.000 --> 00:03.000 line:85% align:center",
      "<v Anna>Tom &amp; Jerry</v>",
      "second line",
      "",
      "01:00:00.000 --> 01:00:01.000",
      "Late",
      "",
    ].join("\n");
    const r = parseSubtitles(text);
    expect(r.format).toBe("vtt");
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0]).toMatchObject({ id: "intro", start: 1, end: 3, settings: "line:85% align:center", speaker: "Anna", lines: ["Tom & Jerry", "second line"] });
    expect(r.cues[0].raw_lines[0]).toBe("<v Anna>Tom &amp; Jerry</v>");
    expect(r.cues[1]).toMatchObject({ start: 3600, end: 3601, lines: ["Late"] });
  });
  it("keeps a cue with no text and warns about blocks without timing", () => {
    const r = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n\ngarbage block\n");
    expect(r.cues).toHaveLength(1);
    expect(r.cues[0].lines).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
  it("round-trips the writers", () => {
    for (const w of [writeSrt(SAMPLE), writeVtt(SAMPLE)]) {
      const r = parseSubtitles(w.text);
      expect(r.cues.map((c) => [c.start, c.end, c.lines])).toEqual(SAMPLE.map((c) => [c.start, c.end, c.lines]));
    }
  });
});
