// qa/scenarios/voxmark/03-selective-purge.mjs
// Scenario 3: removeMarkersAtTimes removes only the transcript markers at the given
// timestamps (within tolerance); a user marker placed at another time survives intact.

export const USER_MARKER = {
  time: 5.0,
  comment: "User note: cut to B-roll",
  duration: 0,
  label: 3,
};

export const TRANSCRIPT_MARKERS = [
  {
    start: 1.0,
    end: 2.5,
    text: "[Ana] First transcript cue",
    speaker: "Ana",
    speakerIndex: 0,
  },
  {
    start: 3.0,
    end: 4.2,
    text: "[Ben] Second transcript cue",
    speaker: "Ben",
    speakerIndex: 1,
  },
  {
    start: 7.5,
    end: 9.0,
    text: "[Ana] Third transcript cue after user note",
    speaker: "Ana",
    speakerIndex: 0,
  },
];

export default {
  name: "VoxMark 03: selective purge",
  fixtures: { comp: { w: 1920, h: 1080, fps: 25, seconds: 15 } },
  load: ["H:/Github_repos/AFX-VoxMark/src/jsx/hostscript-aeft.jsx"],

  async run(ae) {
    // 1. Place a user marker directly on the composition.
    await ae.addCompMarker(USER_MARKER);

    // 2. Add VoxMark transcript markers with clearFirst=false so the user marker stays.
    const createRes = await ae.call("createCompMarkers", [
      JSON.stringify(TRANSCRIPT_MARKERS),
      0,
      false,
    ]);
    if (!createRes || createRes.created !== TRANSCRIPT_MARKERS.length) {
      throw new Error(
        `Expected createCompMarkers to create ${TRANSCRIPT_MARKERS.length} markers, got: ${JSON.stringify(createRes)}`
      );
    }

    // 3. Selectively remove only the transcript marker timestamps.
    const times = TRANSCRIPT_MARKERS.map((m) => m.start);
    const purgeRes = await ae.call("removeMarkersAtTimes", [
      JSON.stringify(times),
      0.05,
    ]);
    if (!purgeRes || purgeRes.removed !== TRANSCRIPT_MARKERS.length) {
      throw new Error(
        `Expected removeMarkersAtTimes to remove ${TRANSCRIPT_MARKERS.length} markers, got: ${JSON.stringify(purgeRes)}`
      );
    }
  },

  async assert(ae, t) {
    const m = await ae.read.markers();
    t.markerCount(m, 1);

    t.markerMatches(m[0], {
      comment: USER_MARKER.comment,
      label: USER_MARKER.label,
      time: USER_MARKER.time,
      duration: 0,
      voxmarkVoice: "",
      voxmarkText: "",
    });
  },
};
