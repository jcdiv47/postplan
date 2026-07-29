// postplan dashboard — view toggle and filter.
//
// Loaded from <head> WITHOUT defer, so the saved view is applied to <html>
// before the first paint. That means <body> does not exist yet: everything that
// touches the DOM below waits for DOMContentLoaded.

(function () {
  "use strict";

  var KEY = "postplan.view";
  var root = document.documentElement;

  function applyView(view) {
    var rows = view === "rows";
    root.classList.toggle("view-rows", rows);
    root.classList.toggle("view-cards", !rows);
  }

  try {
    var saved = localStorage.getItem(KEY);
    if (saved) applyView(saved);
  } catch (e) {
    // Private browsing or storage disabled — the server-rendered default stands.
  }

  document.addEventListener("DOMContentLoaded", function () {
    var toolbar = document.getElementById("toolbar");
    if (toolbar) toolbar.hidden = false;

    var buttons = Array.prototype.slice.call(document.querySelectorAll(".view-btn"));

    function syncButtons() {
      var current = root.classList.contains("view-rows") ? "rows" : "cards";
      buttons.forEach(function (btn) {
        btn.setAttribute("aria-pressed", String(btn.dataset.view === current));
      });
    }

    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        applyView(btn.dataset.view);
        try { localStorage.setItem(KEY, btn.dataset.view); } catch (e) { /* ignore */ }
        syncButtons();
      });
    });
    syncButtons();

    var filter = document.getElementById("filter");
    var drafts = Array.prototype.slice.call(document.querySelectorAll(".draft"));
    var count = document.getElementById("count");
    var noMatches = document.getElementById("no-matches");
    if (!filter || !drafts.length) return;

    filter.addEventListener("input", function () {
      var q = filter.value.trim().toLowerCase();
      var shown = 0;
      drafts.forEach(function (el) {
        var hit = !q || el.dataset.search.indexOf(q) !== -1;
        el.hidden = !hit;
        if (hit) shown++;
      });
      if (noMatches) noMatches.hidden = shown !== 0;
      if (count) {
        count.textContent = q
          ? shown + " of " + drafts.length + " drafts"
          : drafts.length + (drafts.length === 1 ? " draft" : " drafts");
      }
    });
  });
})();
