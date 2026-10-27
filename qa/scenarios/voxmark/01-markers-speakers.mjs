// qa/scenarios/voxmark/01-markers-speakers.mjs
// Scenario 1: createCompMarkers sets comments, speaker label colours, durations,
// and hidden voxmarkVoice / voxmarkText parameters.

export const VOXMARK_LABEL_CYCLE = [9, 11, 8, 13, 2, 14, 10, 6];

export const TWO_SPEAKERS = [
  {
    start: 0.5,
    end: 2.5,
    text: "[Ana] Hello there",
    speaker: "Ana",
    speakerIndex: 0,
  },
  {
    start: 3.0,
    end: 5.5,
    text: "[Ben] Good to be here",
    speaker: "Ben",
    speakerIndex: 1,
  },
  {
    start: 6.0,
    end: 8.2,
    text: "[Ana] Let us begin the review",
    speaker: "Ana",
    speakerIndex: 0,
  },
  {
    start: 9.0,
    end: 11.5,
    text: "[Ben] Sounds like a plan",
    speaker: "Ben",
    speakerIndex: 1,
  },
];

export default {
  name: "VoxMark 01: markers and speaker colours",
  fixtures: { comp: { w: 1920, h: 1080, fps: 25, seconds: 15 } },
  load: [
    // Same order as the panel: hostscript.jsx (JSON polyfill) is the manifest ScriptPath,
    // then host-adapter.js pipes in the AE shim.
    "H:/Github_repos/AFX-VoxMark/src/jsx/hostscript.jsx",
    "H:/Github_repos/AFX-VoxMark/src/jsx/hostscript-aeft.jsx",
  ],

  async run(ae) {
    const res = await ae.call("createCompMarkers", [
      JSON.stringify(TWO_SPEAKERS),
      0,
      true,
    ]);
    if (!res || res.created !== TWO_SPEAKERS.length) {
      throw new Error(
        `Expected createCompMarkers to create ${TWO_SPEAKERS.length} markers, got: ${JSON.stringify(res)}`
      );
    }
  },

  async assert(ae, t) {
    const m = await ae.read.markers();
    t.markerCount(m, 4);

    for (let i = 0; i < TWO_SPEAKERS.length; i++) {
      const expected = TWO_SPEAKERS[i];
      const expectedLabel =
        VOXMARK_LABEL_CYCLE[expected.speakerIndex % VOXMARK_LABEL_CYCLE.length];
      t.markerMatches(m[i], {
        comment: expected.text,
        label: expectedLabel,
        time: expected.start,
        duration: expected.end - expected.start,
        voxmarkVoice: expected.speaker,
        voxmarkText: expected.text,
      });
    }
  },
};
