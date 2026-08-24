// recap-ui.js — thin DOM glue for the recap carousel (Daily done screen +
// party game-over). No decisions: scenes/captions/eager count come from the
// caller's pure functions; maps render via renderRevealScene only, so the
// imagery rule holds. This is the ONLY carousel builder — daily-ui, host-ui
// and player-ui all delegate to it (docs/party-recap-spec.md §3). The behavior
// here is moved verbatim from daily-ui.js's old renderRecap, not reinvented:
// card DOM, lazy-init via IntersectionObserver with the eager-first-N fix, the
// scroll-engagement latch, and teardown.

import { renderRevealScene } from "./revealmap-ui.js";
import { recapEagerCount } from "./recap.js";

// Build the carousel into `carousel`, showing `box`. Returns a handle whose
// destroy() is idempotent: disconnects the observer, destroys every map
// handle, clears the carousel DOM, re-hides the box, and drops the scroll
// latch.
//
//   box        — the .recap container element (shown/hidden here)
//   carousel   — the .recap-carousel element (cards appended here)
//   cards      — pure card objects
//   sceneFor   — (card) => scene   (pure, caller-supplied)
//   captionFor — (card) => string  (pure, caller-supplied)
//   onEngage   — () => void        (fired ONCE, on first scroll; optional)
export function createRecapCarousel({ box, carousel, cards, sceneFor, captionFor, onEngage }) {
  let observer = null;
  let handles = [];
  let engaged = false;

  const onScroll = () => {
    if (engaged) return;
    engaged = true;
    if (onEngage) onEngage();
  };

  const handle = {
    destroy() {
      if (observer) { observer.disconnect(); observer = null; }
      for (const h of handles) { try { h?.destroy(); } catch { /* gone */ } }
      handles = [];
      if (carousel) {
        carousel.removeEventListener("scroll", onScroll);
        carousel.textContent = "";
      }
      if (box) box.classList.add("hidden");
      engaged = false;
    },
  };

  if (!cards || cards.length === 0) {
    if (box) box.classList.add("hidden");
    return handle;   // inert
  }

  const pending = new Map();   // card element -> { card, mapEl }
  for (const card of cards) {
    const el = document.createElement("div");
    el.className = "recap-card";
    el.dataset.round = String(card.round);
    const mapEl = document.createElement("div");
    mapEl.className = "recap-card-map";
    const cap = document.createElement("div");
    cap.className = "recap-caption";
    cap.textContent = captionFor(card);
    el.append(mapEl, cap);
    carousel.appendChild(el);
    pending.set(el, { card, mapEl });
  }

  const initCard = (el) => {
    const p = pending.get(el);
    if (!p) return;
    pending.delete(el);
    handles.push(renderRevealScene(p.mapEl, sceneFor(p.card)));
  };

  if (typeof IntersectionObserver === "function") {
    // Eagerly render the leading cards (insertion order = visual order) so a
    // second card's real map peeks in and makes the swipe affordance obvious;
    // the rest stay lazy. This never fires engagement — only a scroll does.
    const eager = recapEagerCount(pending.size);
    for (const el of [...pending.keys()].slice(0, eager)) initCard(el);
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { initCard(e.target); observer.unobserve(e.target); }
      }
    }, { root: carousel, threshold: 0.25 });
    for (const el of pending.keys()) observer.observe(el);
  } else {
    for (const el of [...pending.keys()]) initCard(el);
  }

  carousel.addEventListener("scroll", onScroll, { passive: true });
  box.classList.remove("hidden");
  return handle;
}
