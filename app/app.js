/* Cairnline AI — interactions (no dependencies) */
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- mobile nav ---- */
  var toggle = document.getElementById("navToggle");
  var links = document.getElementById("navLinks");
  if (toggle && links) {
    var setOpen = function (open) {
      links.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    toggle.addEventListener("click", function () {
      setOpen(!links.classList.contains("is-open"));
    });
    links.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 760) setOpen(false);
    });
  }

  /* ---- pricing: monthly / annual (20% off) ---- */
  var opts = document.querySelectorAll(".switch__opt");
  var prices = document.querySelectorAll(".price");
  opts.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var period = btn.dataset.period;
      opts.forEach(function (b) {
        var on = b === btn;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      prices.forEach(function (p) {
        var value = period === "annual" ? p.dataset.annual : p.dataset.monthly;
        if (value) p.textContent = "$" + value;
      });
    });
  });

  /* ---- FAQ: one open at a time ---- */
  var faq = document.getElementById("faqList");
  if (faq) {
    var items = faq.querySelectorAll("details");
    items.forEach(function (d) {
      d.addEventListener("toggle", function () {
        if (!d.open) return;
        items.forEach(function (other) {
          if (other !== d) other.open = false;
        });
      });
    });
  }

  /* ---- reveal on scroll ---- */
  var revealables = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var siblings = Array.prototype.slice.call(
            el.parentElement ? el.parentElement.children : [el]
          );
          var index = Math.max(0, siblings.indexOf(el));
          el.style.transitionDelay = Math.min(index, 5) * 60 + "ms";
          el.classList.add("is-in");
          io.unobserve(el);
        });
      },
      { rootMargin: "160px 0px 12% 0px", threshold: 0.01 }
    );
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---- forms ---- */
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function note(el, text, ok) {
    el.textContent = text;
    el.classList.toggle("is-ok", !!ok);
    el.classList.toggle("is-bad", !ok && !!text);
  }

  var form = document.getElementById("contactForm");
  var formNote = document.getElementById("formNote");
  if (form && formNote) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var data = new FormData(form);
      var bad = null;
      ["name", "email", "message"].forEach(function (key) {
        var input = form.elements[key];
        var wrap = input.closest(".field");
        var value = String(data.get(key) || "").trim();
        var invalid = !value || (key === "email" && !EMAIL.test(value));
        wrap.classList.toggle("is-bad", invalid);
        input.setAttribute("aria-invalid", String(invalid));
        if (invalid && !bad) bad = input;
      });
      if (bad) {
        note(formNote, "Please fill in your name, a valid email and a message.", false);
        bad.focus();
        return;
      }
      note(formNote, "Thanks — your message is ready to send. We reply within one business day.", true);
      form.reset();
    });
  }

  var news = document.getElementById("newsForm");
  var newsNote = document.getElementById("newsNote");
  if (news && newsNote) {
    news.addEventListener("submit", function (e) {
      e.preventDefault();
      var value = String(new FormData(news).get("email") || "").trim();
      if (!EMAIL.test(value)) {
        note(newsNote, "Enter a valid email address.", false);
        news.elements.email.focus();
        return;
      }
      note(newsNote, "You're on the list.", true);
      news.reset();
    });
  }

  /* ---- year ---- */
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---- active nav link while scrolling ---- */
  var sections = ["features", "how-to-use", "pricing", "trade-lens", "dashboard", "about"];
  var navLinks = Array.prototype.slice.call(document.querySelectorAll("#navLinks a"));
  if (navLinks.length && "IntersectionObserver" in window) {
    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          navLinks.forEach(function (a) {
            a.classList.toggle("is-active", a.getAttribute("href") === "#" + entry.target.id);
          });
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    sections.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }
})();
