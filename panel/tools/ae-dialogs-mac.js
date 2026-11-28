// panel/tools/ae-dialogs-mac.js
//
// macOS counterpart of ae-dialogs.ps1, run with `osascript -l JavaScript`:
//   list                                  open dialogs and sheets of After Effects
//   respond <handle> <button> [check] [title] [text]
//                                         press a button (AXPress, no focus change),
//                                         optionally ticking a checkbox first; the
//                                         title must still match when given, and the
//                                         dialog text must still start with [text]
//
// Reads AE's windows through System Events, so the app running it (After
// Effects, for the panel) needs Accessibility permission. Prints one line of
// JSON in the same shape as the PowerShell script.
//
// A handle is window index * 100 + sheet index (0 for the window itself);
// macOS has no window handles that System Events exposes.

function errorJson(e) {
  var msg = String((e && e.message) || e);
  if (/-1719|-25211|-1743/.test(msg) && !/assistive|not allowed|not authori[sz]ed|-25211|-1743/i.test(msg)) {
    // A bare -1719 is "Invalid index": the window is gone.
    return JSON.stringify({ ok: false, error: "dialog_not_found" });
  }
  if (/-1719|-25211|-1743|assistive|not allowed|not authori[sz]ed/i.test(msg)) {
    return JSON.stringify({
      ok: false,
      error:
        "accessibility_permission_needed: allow After Effects in System Settings > Privacy & Security > Accessibility (and Automation > System Events), then try again. (" +
        msg +
        ")",
    });
  }
  return JSON.stringify({ ok: false, error: msg });
}

function attr(el, name) {
  try {
    return el.attributes.byName(name).value();
  } catch (e) {
    return null;
  }
}

function safe(fn, fallback) {
  try {
    var v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// A control's label. AE 26 on macOS leaves name and title empty on its own
// buttons and puts the label in AXDescription ("Cancel", "Don’t Save").
function label(el) {
  return String(
    safe(function () { return el.name(); }, "") ||
      safe(function () { return el.title(); }, "") ||
      attr(el, "AXTitle") ||
      attr(el, "AXDescription") ||
      ""
  );
}

// Labels compared case-blind and with typographic apostrophes made plain,
// so "Don't Save" finds AE's "Don’t Save".
function sameLabel(a, b) {
  function norm(s) {
    return String(s || "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  }
  return norm(a) === norm(b);
}

// Descendants with the given AXRole, in reading order. AE paints its dialogs
// as AXLayoutArea elements whose controls are plain UI elements (and may sit
// in a nested layout area or group), so the typed collections (buttons(),
// staticTexts()) can miss them.
function byRole(el, role, depth) {
  var out = [];
  var kids = safe(function () { return el.uiElements(); }, []);
  for (var i = 0; i < kids.length; i++) {
    var r = String(attr(kids[i], "AXRole") || "");
    if (r === role) out.push(kids[i]);
    else if (depth > 0 && (r === "AXLayoutArea" || r === "AXGroup")) out = out.concat(byRole(kids[i], role, depth - 1));
  }
  return out;
}

function texts(el) {
  var out = [];
  var st = byRole(el, "AXStaticText", 2);
  for (var i = 0; i < st.length; i++) {
    var v = safe(function () { return st[i].value(); }, "") || attr(st[i], "AXDescription") || safe(function () { return st[i].name(); }, "");
    if (v) out.push(String(v));
  }
  var ta = byRole(el, "AXTextArea", 2);
  for (var j = 0; j < ta.length; j++) {
    var tv = safe(function () { return ta[j].value(); }, "");
    if (tv) out.push(String(tv));
  }
  return out.join("\n");
}

function describe(el, handle) {
  var subrole = String(attr(el, "AXSubrole") || "");
  var role = String(attr(el, "AXRole") || "");
  var modal = attr(el, "AXModal") === true;
  var isSheet = role === "AXSheet";
  if (!modal && !isSheet && subrole !== "AXDialog" && subrole !== "AXSystemDialog") return null;
  var buttons = byRole(el, "AXButton", 2).map(function (b) {
    return {
      name: label(b),
      automationId: "",
      enabled: safe(function () { return b.enabled(); }, true) === true,
    };
  });
  var checkboxes = byRole(el, "AXCheckBox", 2).map(function (c) {
    return { name: label(c), checked: safe(function () { return c.value(); }, 0) === 1 };
  });
  var pos = safe(function () { return el.position(); }, [0, 0]);
  var size = safe(function () { return el.size(); }, [0, 0]);
  return {
    handle: handle,
    title: String(safe(function () { return el.name(); }, "") || attr(el, "AXTitle") || ""),
    class: subrole || role,
    isModal: modal || isSheet || subrole === "AXDialog" || subrole === "AXSystemDialog",
    text: texts(el),
    buttons: buttons,
    checkboxes: checkboxes,
    boundingRect: { x: pos[0], y: pos[1], width: size[0], height: size[1] },
    screenshot: null,
  };
}

function aeProcess(se) {
  var procs = se.applicationProcesses.whose({ name: { _contains: "After Effects" } })();
  if (procs.length === 0) return null;
  return procs[0];
}

// The process's top-level elements that can be dialogs. AE 26 on macOS
// reports no AXWindows at all: its windows, dialogs included, are AXLayoutArea
// children of the process (subrole AXDialog, AXModal true for a prompt).
// Ordinary Cocoa windows are AXWindow children; the menu bar is left out.
function topLevel(proc) {
  var kids = safe(function () { return proc.uiElements(); }, null);
  if (!kids) return proc.windows();
  var out = [];
  for (var i = 0; i < kids.length; i++) {
    var r = String(attr(kids[i], "AXRole") || "");
    if (r === "AXWindow" || r === "AXLayoutArea" || r === "AXSheet") out.push(kids[i]);
  }
  return out;
}

function elementFor(proc, handle) {
  var wi = Math.floor(handle / 100);
  var si = handle % 100;
  var wins = topLevel(proc);
  if (wi < 1 || wi > wins.length) return null;
  var w = wins[wi - 1];
  if (si === 0) return w;
  var sheets = safe(function () { return w.sheets(); }, []);
  if (si > sheets.length) return null;
  return sheets[si - 1];
}

function run(argv) {
  var mode = argv[0] || "list";
  try {
    var se = Application("System Events");
    var proc = aeProcess(se);
    if (mode === "list") {
      if (!proc) return JSON.stringify({ ok: true, ae_pid: null, dialogs: [] });
      var out = [];
      var wins = topLevel(proc);
      for (var i = 0; i < wins.length; i++) {
        var d = describe(wins[i], (i + 1) * 100);
        if (d) out.push(d);
        var sheets = safe(function () { return wins[i].sheets(); }, []);
        for (var j = 0; j < sheets.length && j < 99; j++) {
          var s = describe(sheets[j], (i + 1) * 100 + j + 1);
          if (s) out.push(s);
        }
      }
      return JSON.stringify({ ok: true, ae_pid: proc.unixId(), dialogs: out });
    }
    if (mode === "respond") {
      if (!proc) return JSON.stringify({ ok: false, error: "ae_not_running" });
      var handle = parseInt(argv[1], 10);
      var buttonName = String(argv[2] || "");
      var check = argv[3] ? String(argv[3]) : "";
      var title = argv[4] ? String(argv[4]) : "";
      var textGuard = argv[5] ? String(argv[5]) : "";
      var el = elementFor(proc, handle);
      if (!el) return JSON.stringify({ ok: false, error: "dialog_not_found" });
      if (title && String(safe(function () { return el.name(); }, "") || "") !== title) {
        return JSON.stringify({ ok: false, error: "dialog_changed: the window at this handle has a different title now; list the dialogs again" });
      }
      if (textGuard && texts(el).indexOf(textGuard) !== 0) {
        return JSON.stringify({ ok: false, error: "dialog_changed: the text of the window at this handle is different now; list the dialogs again" });
      }
      // Plain values, taken before pressing: the specifiers re-resolve by index.
      var titleBefore = String(safe(function () { return el.name(); }, "") || "");
      var winCountBefore = topLevel(proc).length;
      var sheetCountBefore = Math.floor(handle / 100) >= 1 ? safe(function () { return topLevel(proc)[Math.floor(handle / 100) - 1].sheets().length; }, 0) : 0;
      var checked = null;
      if (check) {
        var boxes = byRole(el, "AXCheckBox", 2);
        var box = null;
        for (var b = 0; b < boxes.length; b++) {
          if (sameLabel(label(boxes[b]), check)) box = boxes[b];
        }
        if (!box) return JSON.stringify({ ok: false, error: "checkbox_not_found" });
        if (safe(function () { return box.value(); }, 0) !== 1) box.actions.byName("AXPress").perform();
        checked = check;
      }
      var buttons = byRole(el, "AXButton", 2);
      var target = null;
      for (var k = 0; k < buttons.length; k++) {
        if (sameLabel(label(buttons[k]), buttonName)) target = buttons[k];
      }
      if (!target) return JSON.stringify({ ok: false, error: "button_not_found" });
      target.actions.byName("AXPress").perform();
      delay(0.3);
      var still = elementFor(proc, handle);
      var closed = !still;
      if (!closed) {
        var titleAfter = String(safe(function () { return still.name(); }, "") || "");
        var winCountAfter = topLevel(proc).length;
        var sheetCountAfter = safe(function () { return topLevel(proc)[Math.floor(handle / 100) - 1].sheets().length; }, 0);
        closed = titleAfter !== titleBefore || winCountAfter < winCountBefore || sheetCountAfter < sheetCountBefore;
      }
      return JSON.stringify({ ok: true, handle: handle, pressed: buttonName, checked: checked, closed: closed });
    }
    return JSON.stringify({ ok: false, error: "unknown_mode" });
  } catch (e) {
    return errorJson(e);
  }
}
