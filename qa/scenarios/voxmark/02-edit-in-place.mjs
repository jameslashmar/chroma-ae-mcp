// qa/scenarios/voxmark/02-edit-in-place.mjs
// Scenario 2: updateMarkerTextAtTime changes one marker's comment and voxmarkText,
// preserves its label, duration and voxmarkVoice, and leaves all other markers untouched.

export const VOXMARK_LABEL_CYCLE = [9, 11, 8, 13, 2, 14, 10, 6];

export const INITIAL_MARKERS = [
  {
    start: 0.5,
    end: 3.2,
    text: "[Narrator] This is the opening line.",
    speaker: "Narrator",
    speakerIndex: 0,
  },
  {
    start: 3.6,
    end: 6.4,
    text: "[Guest] Double-click one to fix a wrod.",
    speaker: "Guest",
    speakerIndex: 1,
  },
  {
    start: 7.0,
    end: 9.8,
    text: "[Narrator] And the closing line stays untouched.",
    speaker: "Narrator",
    speakerIndex: 0,
  },
];

export const EDITED_SECOND_TEXT = "[Guest] Double-click one to fix a word.";

export default {
  name: "VoxMark 02: edit in place",
  fixtures: { comp: { w: 1920, h: 1080, fps: 25, seconds: 15 } },
  load: [
    // Same order as the panel: hostscript.jsx (JSON polyfill) is the manifest ScriptPath,
    // then host-adapter.js pipes in the AE shim.
    "H:/Github_repos/AFX-VoxMark/src/jsx/hostscript.jsx",
    "H:/Github_repos/AFX-VoxMark/src/jsx/hostscript-aeft.jsx",
  ],

  async run(ae) {
    await ae.call("createCompMarkers", [
      JSON.stringify(INITIAL_MARKERS),
      0,
      true,
    ]);
    const editRes = await ae.call("updateMarkerTextAtTime", [
      JSON.stringify({
        edits: [{ time: INITIAL_MARKERS[1].start, text: EDITED_SECOND_TEXT }],
      }),
    ]);
    if (!editRes || editRes.updated !== 1 || editRes.missed !== 0) {
      throw new Error(
        `Expected updateMarkerTextAtTime to update 1 marker with 0 missed, got: ${JSON.stringify(editRes)}`
      );
    }
  },

  async assert(ae, t) {
    const m = await ae.read.markers();
    t.markerCount(m, 3);

    // Marker 0: untouched
    t.markerMatches(m[0], {
      comment: INITIAL_MARKERS[0].text,
      label: VOXMARK_LABEL_CYCLE[0],
      time: INITIAL_MARKERS[0].start,
      duration: INITIAL_MARKERS[0].end - INITIAL_MARKERS[0].start,
      voxmarkVoice: "Narrator",
      voxmarkText: INITIAL_MARKERS[0].text,
    });

    // Marker 1: comment and voxmarkText updated; voice, label, time and duration preserved
    t.markerMatches(m[1], {
      comment: EDITED_SECOND_TEXT,
      label: VOXMARK_LABEL_CYCLE[1],
      time: INITIAL_MARKERS[1].start,
      duration: INITIAL_MARKERS[1].end - INITIAL_MARKERS[1].start,
      voxmarkVoice: "Guest",
      voxmarkText: EDITED_SECOND_TEXT,
    });

    // Marker 2: untouched
    t.markerMatches(m[2], {
      comment: INITIAL_MARKERS[2].text,
      label: VOXMARK_LABEL_CYCLE[0],
      time: INITIAL_MARKERS[2].start,
      duration: INITIAL_MARKERS[2].end - INITIAL_MARKERS[2].start,
      voxmarkVoice: "Narrator",
      voxmarkText: INITIAL_MARKERS[2].text,
    });
  },
};
