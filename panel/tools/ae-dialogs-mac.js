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

function texts(el) {
  var out = [];
  var st = safe(function () { return el.staticTexts(); }, []);
  for (var i = 0; i < st.length; i++) {
    var v = safe(function () { return st[i].value(); }, "") || safe(function () { return st[i].name(); }, "");
    if (v) out.push(String(v));
  }
  var ta = safe(function () { return el.textAreas(); }, []);
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
  var buttons = safe(function () { return el.buttons(); }, []).map(function (b) {
    return {
      name: String(safe(function () { return b.name(); }, "") || safe(function () { return b.title(); }, "") || ""),
      automationId: "",
      enabled: safe(function () { return b.enabled(); }, true) === true,
    };
  });
  var checkboxes = safe(function () { return el.checkboxes(); }, []).map(function (c) {
    return { name: String(safe(function () { return c.name(); }, "") || ""), checked: safe(function () { return c.value(); }, 0) === 1 };
  });
  var pos = safe(function () { return el.position(); }, [0, 0]);
  var size = safe(function () { return el.size(); }, [0, 0]);
  return {
    handle: handle,
    title: String(safe(function () { return el.name(); }, "") || ""),
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

function elementFor(proc, handle) {
  var wi = Math.floor(handle / 100);
  var si = handle % 100;
  var wins = proc.windows();
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
      var wins = proc.windows();
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
      var winCountBefore = proc.windows().length;
      var sheetCountBefore = Math.floor(handle / 100) >= 1 ? safe(function () { return proc.windows()[Math.floor(handle / 100) - 1].sheets().length; }, 0) : 0;
      var checked = null;
      if (check) {
        var boxes = safe(function () { return el.checkboxes(); }, []);
        var box = null;
        for (var b = 0; b < boxes.length; b++) {
          if (String(safe(function () { return boxes[b].name(); }, "")).toLowerCase() === check.toLowerCase()) box = boxes[b];
        }
        if (!box) return JSON.stringify({ ok: false, error: "checkbox_not_found" });
        if (safe(function () { return box.value(); }, 0) !== 1) box.actions.byName("AXPress").perform();
        checked = check;
      }
      var buttons = safe(function () { return el.buttons(); }, []);
      var target = null;
      for (var k = 0; k < buttons.length; k++) {
        if (String(safe(function () { return buttons[k].name(); }, "")).toLowerCase() === buttonName.toLowerCase()) target = buttons[k];
      }
      if (!target) return JSON.stringify({ ok: false, error: "button_not_found" });
      target.actions.byName("AXPress").perform();
      delay(0.3);
      var still = elementFor(proc, handle);
      var closed = !still;
      if (!closed) {
        var titleAfter = String(safe(function () { return still.name(); }, "") || "");
        var winCountAfter = proc.windows().length;
        var sheetCountAfter = safe(function () { return proc.windows()[Math.floor(handle / 100) - 1].sheets().length; }, 0);
        closed = titleAfter !== titleBefore || winCountAfter < winCountBefore || sheetCountAfter < sheetCountBefore;
      }
      return JSON.stringify({ ok: true, handle: handle, pressed: buttonName, checked: checked, closed: closed });
    }
    return JSON.stringify({ ok: false, error: "unknown_mode" });
  } catch (e) {
    return errorJson(e);
  }
}
