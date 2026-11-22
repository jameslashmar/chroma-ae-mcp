// panel/tools/ae-window-mac.js
//
// macOS helper for ae_ui_screenshot, run with `osascript -l JavaScript`:
//   main [pid]   the After Effects main window: its CGWindowID, bounds and whether it is on screen,
//                whether this process may record the screen (Screen Recording permission), and
//                whether the screen is locked or the main display asleep (then nothing can be captured)
//
// Reads the window list through CoreGraphics (no Accessibility needed). The capture itself is
// `screencapture -x -o -l <id>`, which records that one window without bringing it to the front.
// Prints one line of JSON.

ObjC.import("CoreGraphics");
ObjC.import("Foundation");

function num(v) {
  try {
    return Number(ObjC.unwrap(v));
  } catch (e) {
    return 0;
  }
}

function str(v) {
  try {
    var s = ObjC.unwrap(v);
    return s === undefined || s === null ? "" : String(s);
  } catch (e) {
    return "";
  }
}

function run(argv) {
  var wantPid = argv[1] ? parseInt(argv[1], 10) : 0;
  var canRecord = true;
  try {
    // macOS 10.15+: false when the responsible app (After Effects, for the panel) has no Screen Recording permission.
    canRecord = $.CGPreflightScreenCaptureAccess() === true;
  } catch (e) {
    canRecord = true;
  }
  var locked = false;
  var asleep = false;
  try {
    var session = ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary()));
    locked = !!session && session.CGSSessionScreenIsLocked === true;
  } catch (e) {
    locked = false;
  }
  try {
    asleep = $.CGDisplayIsAsleep($.CGMainDisplayID()) === true;
  } catch (e) {
    asleep = false;
  }
  // All windows, on screen or not (a minimized window is listed with kCGWindowIsOnscreen false).
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID));
  var n = num(list.count);
  var best = null;
  for (var i = 0; i < n; i++) {
    var w = list.objectAtIndex(i);
    var owner = str(w.objectForKey("kCGWindowOwnerName"));
    var pid = num(w.objectForKey("kCGWindowOwnerPID"));
    if (wantPid ? pid !== wantPid : owner !== "After Effects") continue;
    if (num(w.objectForKey("kCGWindowLayer")) !== 0) continue;
    var b = w.objectForKey("kCGWindowBounds");
    var width = num(b.objectForKey("Width"));
    var height = num(b.objectForKey("Height"));
    if (width < 300 || height < 200) continue;
    var cand = {
      window_id: num(w.objectForKey("kCGWindowNumber")),
      pid: pid,
      onscreen: num(w.objectForKey("kCGWindowIsOnscreen")) === 1,
      x: num(b.objectForKey("X")),
      y: num(b.objectForKey("Y")),
      width: width,
      height: height,
    };
    // The main window is the largest one; an on-screen window wins over a hidden one.
    if (!best || (cand.onscreen && !best.onscreen) || (cand.onscreen === best.onscreen && cand.width * cand.height > best.width * best.height)) best = cand;
  }
  if (!best) return JSON.stringify({ ok: false, error: "ae_window_not_found", can_record: canRecord, locked: locked, asleep: asleep });
  return JSON.stringify({ ok: true, can_record: canRecord, locked: locked, asleep: asleep, window: best });
}
