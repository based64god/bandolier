(function () {
  "use strict";

  var root = document.documentElement;

  /* ---------- Theme ---------- */
  var STORAGE_KEY = "bandolier-docs-theme";
  var stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    /* localStorage unavailable */
  }
  if (stored === "light" || stored === "dark") {
    root.setAttribute("data-theme", stored);
  } else if (
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    root.setAttribute("data-theme", "light");
  }

  var themeToggle = document.querySelector(".theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (e) {
        /* ignore */
      }
    });
  }

  /* ---------- Mobile nav ---------- */
  var navToggle = document.querySelector(".nav-toggle");
  var sidebar = document.querySelector(".sidebar");
  if (navToggle && sidebar) {
    navToggle.addEventListener("click", function () {
      var open = sidebar.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    sidebar.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        sidebar.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- Copy buttons ---------- */
  var blocks = document.querySelectorAll(".code-block");
  blocks.forEach(function (block) {
    var btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "Copy";
    btn.addEventListener("click", function () {
      var code = block.querySelector("code");
      if (!code) return;
      var text = code.innerText;
      var done = function () {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          done();
        } catch (e) {
          /* ignore */
        }
        document.body.removeChild(ta);
      }
    });
    block.appendChild(btn);
  });

  /* ---------- Scroll spy ---------- */
  var links = Array.prototype.slice.call(
    document.querySelectorAll(".sidebar a[href^='#']"),
  );
  var byId = {};
  links.forEach(function (a) {
    var id = a.getAttribute("href").slice(1);
    if (id) byId[id] = a;
  });
  var targets = Object.keys(byId)
    .map(function (id) {
      return document.getElementById(id);
    })
    .filter(Boolean);

  if (targets.length) {
    var current = null;
    var setActive = function (id) {
      if (id === current) return;
      current = id;
      links.forEach(function (a) {
        a.classList.remove("active");
      });
      if (byId[id]) byId[id].classList.add("active");
    };

    // Highlight the last section whose top has scrolled above a line just
    // below the fixed topbar. Falls back to the first section at the very top
    // and the last one once the page is scrolled to the bottom.
    var LINE = 110;
    var onScroll = function () {
      var active = targets[0].id;
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].getBoundingClientRect().top <= LINE) {
          active = targets[i].id;
        } else {
          break;
        }
      }
      var nearBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
      if (nearBottom) active = targets[targets.length - 1].id;
      setActive(active);
    };

    var ticking = false;
    window.addEventListener(
      "scroll",
      function () {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(function () {
          onScroll();
          ticking = false;
        });
      },
      { passive: true },
    );
    onScroll();
  }
})();
