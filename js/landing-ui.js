// landing-ui.js — DOM glue for the one front door (M1/M4). Three jobs:
//   1. Hero: a slowly-drifting street-level pano behind the logo + one
//      sentence + two CTAs (delight first, architecture never).
//   2. "Start a party": the unified chooser — the host picks the room type
//      by experience ("Everyone on their own phone" / "One phone + the TV").
//   3. "Have a code? Join": one join path. The code is read from the room
//      (which knows its mode) and routed to the right experience; Firebase
//      is dynamically imported only when a code actually needs routing, so
//      the landing itself stays light and works offline.
// Routing/copy decisions live in frontdoor.js (pure, tested).

import { MAPILLARY_TOKEN } from "../config.js";
import { isValidRoomCode } from "./game.js";
import {
  joinHref,
  cleanCodeInput,
  HERO_PANOS,
  heroSequence,
} from "./frontdoor.js";
import { track } from "./consent.js";

const $ = (id) => document.getElementById(id);
const PANELS = { cta: "ld-cta", choose: "ld-choose", join: "ld-join" };

function showPanel(which) {
  for (const [key, id] of Object.entries(PANELS)) {
    $(id).classList.toggle("hidden", key !== which);
  }
  if (which === "join") $("ldCode").focus();
}

/* ---------------- One join path: code -> the right experience --------- */

let routing = false;
async function routeCode(code) {
  if (routing) return;
  routing = true;
  const err = $("ldJoinErr");
  err.textContent = "";
  $("ldJoinNote").textContent = "Finding your room…";
  $("btnLdJoin").disabled = true;
  let mode = null;
  try {
    const { readRoom } = await import("./firebase.js");
    const state = await Promise.race([
      readRoom(code),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    if (!state) {
      err.textContent = "Room not found — check the code.";
      $("ldJoinNote").textContent = "";
      $("btnLdJoin").disabled = false;
      routing = false;
      return;
    }
    mode = state.mode === "h2h" ? "h2h" : "couch";
  } catch {
    // Offline / blocked / slow: default to the phones experience, which
    // handles a missing or mismatched room with its own error copy.
    mode = "h2h";
  }
  track("front_door_join", { mode });
  location.href = joinHref(mode, code);
}

function submitCode() {
  const code = cleanCodeInput($("ldCode").value);
  if (!isValidRoomCode(code)) {
    $("ldJoinErr").textContent = "Codes are 6 letters — check the TV or the invite.";
    return;
  }
  routeCode(code);
}

/* ---------------- Hero pano: drift, degrade, never block -------------- */

function startHeroPano() {
  if (typeof mapillary === "undefined") return; // offline: gradient stays
  let viewer;
  try {
    viewer = new mapillary.Viewer({
      accessToken: MAPILLARY_TOKEN,
      container: "heroPano",
      component: {
        cover: false,
        bearing: false,
        zoom: false,
        direction: false,
        sequence: false,
        keyboard: false,
      },
    });
  } catch {
    return;
  }
  const seq = heroSequence(
    HERO_PANOS, Math.floor(Math.random() * HERO_PANOS.length));
  (async () => {
    for (const id of seq) {
      try {
        await viewer.moveTo(id);
        $("heroPano").classList.add("live");
        startDrift(viewer);
        return;
      } catch { /* dead image — try the next candidate */ }
    }
  })();
}

function startDrift(viewer) {
  if (window.matchMedia &&
      matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Slow ping-pong pan (~1 min per sweep): wraps nicely on spherical
  // imagery and stays in-frame on flat imagery alike.
  let x = 0.35;
  let dir = 1;
  setInterval(() => {
    x += dir * 0.0006;
    if (x > 0.85 || x < 0.15) dir = -dir;
    try { viewer.setCenter([x, 0.5]); } catch { /* mid-load; next tick */ }
  }, 50);
}

/* ---------------- Boot ---------------- */

$("btnStartParty").addEventListener("click", () => showPanel("choose"));
$("btnHaveCode").addEventListener("click", () => showPanel("join"));
$("btnChooseBack").addEventListener("click", () => showPanel("cta"));
$("btnJoinBack").addEventListener("click", () => showPanel("cta"));

// The chooser cards are real links (frontdoor.PARTY_CHOICES targets are in
// the HTML hrefs); the click just records which experience was picked.
$("choicePhones").addEventListener("click", () =>
  track("party_choice", { choice: "phones" }));
$("choiceTv").addEventListener("click", () =>
  track("party_choice", { choice: "tv" }));

$("btnLdJoin").addEventListener("click", submitCode);
$("ldCode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitCode();
});
$("ldCode").addEventListener("input", () => {
  $("ldCode").value = cleanCodeInput($("ldCode").value);
  $("ldJoinErr").textContent = "";
});

// ?room=CODE on the front door (a shared root link, or a code typed on the
// TV's browser): route it straight through the one join path.
const urlCode = cleanCodeInput(
  new URLSearchParams(location.search).get("room"));
if (isValidRoomCode(urlCode)) {
  showPanel("join");
  $("ldCode").value = urlCode;
  routeCode(urlCode);
}

startHeroPano();
