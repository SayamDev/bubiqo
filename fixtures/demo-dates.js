/**
 * Keeps the demo pages evergreen.
 *
 * These pages stand in for real ones, and a real invoice is not six months
 * overdue. Hardcoded dates rot: a demo recorded in March reads as a pile of
 * missed deadlines by September. Each date here is written relative to today, so
 * the pages are always as fresh as the day you open them.
 *
 * This is demo scaffolding, not part of Bubiqo. The extension reads whatever the
 * page renders, exactly as it would on any other site.
 */
(function () {
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  function inDays(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
  }

  function longDate(d) {
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function isoDate(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  document.querySelectorAll("[data-in-days]").forEach((el) => {
    const days = Number(el.getAttribute("data-in-days"));
    const date = inDays(days);
    el.textContent = el.getAttribute("data-format") === "iso" ? isoDate(date) : longDate(date);
  });
})();
