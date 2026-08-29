// analytics.js — pure analytics core: consent state, the event schema, and
// the PostHog gating logic. No DOM, no network in here (same discipline as
// game.js / h2h.js) — the browser glue lives in consent.js, and everything
// in this file is unit-tested in tests/analytics.test.js.
//
// Privacy invariants enforced here (see PRIVACY.md):
//   - Nothing is captured, and PostHog is never even LOADED, before the
//     user explicitly accepts (GDPR opt-in).
//   - Every event goes through a per-event property allowlist: unknown
//     events are dropped, unknown/banned/badly-typed properties stripped.
//     Raw coordinates can never leave the device.
//   - Exceptions (field observability, docs/field-observability-plan.md)
//     ride the SAME gate: trackError() mirrors track() — consent check, then
//     an EXCEPTION_PROPS allowlist — and before_send scrubs query strings
//     and long digit runs out of every URL/stack that leaves the device.
//   - The one exception to "capture only after accept" is the explicit,
//     user-initiated one-time diagnostic report (§10.4): two taps, one
//     bundle, memory-only persistence, no replay, stored "no" untouched.

import { scrubUrl, scrubErrorMessage } from "./imagery.js";

/* ================================================================
 * PostHog project config (public embeddable key, EU-resident instance —
 * same trust model as the Mapillary/Firebase keys in config.js).
 * The three init values are owner-provided; keep them as-is.
 * ================================================================ */

export const POSTHOG_PROJECT_KEY =
  "phc_Au8ogwiWbfcWqhbP6iE8ayyT5JSQtambPHFSffykdvkE";

// Deliberately NOT frozen: posthog.init() mutates the options object it is
// given (it writes defaults like `debug` onto it), so a frozen object makes
// init throw and analytics silently stay off. tests/analytics.test.js
// asserts extensibility to keep it that way.
export const POSTHOG_INIT_OPTIONS = {
  api_host: "https://eu.i.posthog.com",
  defaults: "2026-05-30",
  person_profiles: "identified_only",
  // Autocapture is restricted to button/link clicks: their labels are static
  // UI strings. Team names (user input) live in list items and headings,
  // which autocapture must never lift into $el_text.
  autocapture: { element_allowlist: ["button", "a"] },

  // Field observability (plan §4.1). Every key below still sits behind the
  // consent gate: posthog-js is not loaded at all until the user accepts,
  // so none of this can run for a decliner.

  // Error tracking: window.onerror + unhandledrejection become issues. Our
  // own console.warn/error stay OUT of the issue stream — replay captures
  // them in context instead, which is where they are actually readable.
  capture_exceptions: {
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
    capture_console_errors: false,
  },

  // Web Vitals autocapture ($web_vitals: LCP/CLS/INP/FCP) — the "imagery is
  // slow" complaint needs a page-level baseline next to the viewer timings.
  capture_performance: { web_vitals: true },

  // Session replay. Retention follows the staged policy (plan §9.2) and is
  // a project-settings dial; the masking below is identical in every stage
  // and is the part that must never be loosened.
  session_recording: {
    maskAllInputs: true,                  // nothing typed, ever (team names)
    // Team names + room codes in the UI, plus Leaflet's tooltips (which
    // carry team-name pin labels on the reveal maps).
    maskTextSelector: "[data-ph-mask], .leaflet-tooltip",
    // Owner decision 2026-08-28 (docs/decisions/2026-08-28-replay-privacy.md):
    // a guess and where a player navigated are
    // GAMEPLAY, not personal information, and blanking them made imagery bugs
    // undebuggable. So `.leaflet-container` is no longer blocked — the guess
    // map and the reveal map are visible in recordings, tiles and all. This
    // supersedes the older "a tile URL is a coordinate, therefore block every
    // map" rationale that used to live here.
    // IDENTITY masking is untouched by that decision: maskAllInputs still
    // covers everything typed, `[data-ph-mask]` still covers team names and
    // room codes, and `.leaflet-tooltip` above still text-masks the pin
    // labels rendered INSIDE these now-visible maps (they carry team names).
    // `[data-ph-block]` stays as the escape hatch for any future element that
    // must not be recorded at all.
    blockSelector: "[data-ph-block]",
    // Same decision, applied to the pano: the WebGL canvas is recorded too,
    // so a black/frozen pano is visible in the replay instead of being an
    // empty box. NOTE the shape — posthog-js reads
    // `captureCanvas.recordCanvas`, so the bare `captureCanvas: true` is
    // silently a no-op (it falls through to the project-side dial, which is
    // off). Measured 2026-08-28: the object form below produces real pano
    // pixels; the boolean form produced zero canvas frames.
    // posthog-js forces `preserveDrawingBuffer: true` on every WebGL context
    // created AFTER init, which is why the Mapillary viewer needs no change —
    // but it also means a viewer built before opt-in keeps a non-preserving
    // context and yields no frames until it is rebuilt.
    // 2 fps at quality 0.5 is the debuggability/bandwidth trade: enough to
    // see "the pano never painted", ~40 KB per frame at desktop size.
    captureCanvas: { recordCanvas: true, canvasFps: 2, canvasQuality: "0.5" },
    recordHeaders: false,
    recordBody: false,
    // Timing/status/allowlisted-path only. Mapillary access tokens ride in
    // query params, so the strip below is mandatory before replay ships.
    maskCapturedNetworkRequestFn: (req) => maskNetworkRequest(
      req,
      typeof location !== "undefined" ? location.hostname : "",
    ),
  },
  // Console output synced into replays: the warns our skip loops already
  // print are the story of a failing round.
  enable_recording_console_log: true,

  // Belt-and-braces URL hygiene on every event, exception and pageview:
  // query strings and long digit runs (image ids) never leave the device.
  before_send: sanitizeBeforeSend,
};

/* ================================================================
 * Replay / network / URL sanitizers (pure — tested)
 * ================================================================ */

// Hosts whose request TIMING may appear in a replay waterfall. Anything
// else is dropped entirely rather than recorded with a stripped name.
// Deliberately NOT here: tile.openstreetmap.org. A tile URL is
// `/{z}/{x}/{y}.png` — literally a coordinate — so map tile requests are
// dropped from the waterfall entirely rather than recorded with a stripped
// query string.
export const NETWORK_HOST_ALLOWLIST = Object.freeze([
  "graph.mapillary.com",
  "unpkg.com",
  "eu.i.posthog.com",
  "eu-assets.i.posthog.com",
]);

// Suffix matches for hosts that are sharded per-region/per-CDN-node.
const NETWORK_HOST_SUFFIXES = Object.freeze([
  ".fbcdn.net",                 // Mapillary imagery CDN (scontent-*.fbcdn.net)
  ".firebasedatabase.app",      // the room sync socket
  ".mapillary.com",
]);

function hostOf(name) {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(name || ""));
  if (!m) return null;               // relative URL → our own origin
  return m[1].split("@").pop().split(":")[0].toLowerCase();
}

// posthog-js calls this for every captured network request. Returning null
// drops the entry. `selfHost` keeps our own static assets (release.json,
// the location pool) visible in the waterfall.
export function maskNetworkRequest(req, selfHost) {
  if (!req || typeof req.name !== "string") return null;
  const host = hostOf(req.name);
  const allowed =
    host === null ||
    (selfHost && host === String(selfHost).toLowerCase()) ||
    NETWORK_HOST_ALLOWLIST.includes(host) ||
    NETWORK_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx));
  if (!allowed) return null;
  req.name = scrubUrl(req.name);
  // Defense in depth: posthog-js only sends these when recordHeaders /
  // recordBody are on, but a future default flip must not leak.
  delete req.requestHeaders;
  delete req.responseHeaders;
  delete req.requestBody;
  delete req.responseBody;
  return req;
}

const URL_PROPS = Object.freeze([
  "$current_url", "$pathname", "$referrer", "$referring_domain",
  "$initial_current_url", "$initial_pathname", "$initial_referrer",
  "$session_entry_url", "$session_entry_pathname", "$session_entry_referrer",
]);

// before_send hook: scrub URL-shaped properties and exception frames on
// EVERY outgoing event. Never returns null — dropping stays the schema's
// job (sanitizeEvent), and silently eating events would hide bugs.
export function sanitizeBeforeSend(event) {
  if (!event || !event.properties) return event;
  const props = event.properties;
  for (const key of URL_PROPS) {
    if (typeof props[key] === "string") props[key] = scrubUrl(props[key]);
  }
  const list = props.$exception_list;
  if (Array.isArray(list)) {
    for (const ex of list) {
      if (!ex || typeof ex !== "object") continue;
      if (typeof ex.value === "string") ex.value = scrubErrorMessage(ex.value);
      if (typeof ex.type === "string") ex.type = scrubErrorMessage(ex.type);
      const frames = ex.stacktrace && ex.stacktrace.frames;
      if (!Array.isArray(frames)) continue;
      for (const f of frames) {
        if (!f || typeof f !== "object") continue;
        if (typeof f.filename === "string") f.filename = scrubUrl(f.filename);
        if (typeof f.abs_path === "string") f.abs_path = scrubUrl(f.abs_path);
        if (typeof f.module === "string") f.module = scrubUrl(f.module);
      }
    }
  }
  if (typeof props.$exception_message === "string") {
    props.$exception_message = scrubErrorMessage(props.$exception_message);
  }
  return event;
}

// §10.4 one-time diagnostic init: the same options with everything ambient
// switched off. A fresh object every call — posthog.init() mutates it, and
// this path must never share state with the consented init.
export function oneShotInitOptions() {
  return {
    api_host: POSTHOG_INIT_OPTIONS.api_host,
    defaults: POSTHOG_INIT_OPTIONS.defaults,
    person_profiles: "identified_only",
    persistence: "memory",          // no cookies, no localStorage
    disable_session_recording: true, // one report is not a recording
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_exceptions: false,
    capture_performance: false,
    advanced_disable_feature_flags: true,
    disable_surveys: true,
    before_send: sanitizeBeforeSend,
  };
}

// The posthog-js bundle, loaded directly (no inline snippet — CSP-friendlier
// and nothing runs before consent). EU assets host per the official snippet.
export const POSTHOG_SCRIPT_URL =
  "https://eu-assets.i.posthog.com/static/array.js";

/* ================================================================
 * Consent flag (the only thing we store before opt-in)
 * ================================================================ */

export const CONSENT_KEY = "geoparty_analytics_consent";
export const CONSENT_ACCEPTED = "accepted";
export const CONSENT_DECLINED = "declined";

// storage is localStorage-shaped ({getItem,setItem}); anything but the two
// exact legal values (missing, tampered, legacy) reads as "not chosen yet".
export function getConsent(storage) {
  let raw = null;
  try { raw = storage.getItem(CONSENT_KEY); } catch { return null; }
  return raw === CONSENT_ACCEPTED || raw === CONSENT_DECLINED ? raw : null;
}

export function setConsent(storage, value) {
  if (value !== CONSENT_ACCEPTED && value !== CONSENT_DECLINED) {
    throw new TypeError(`invalid consent value: ${value}`);
  }
  try { storage.setItem(CONSENT_KEY, value); } catch { /* private mode */ }
}

/* ================================================================
 * Event schema — the single source of truth for what we may send.
 * Docs: docs/analytics.md. Property types:
 *   "string" — short string (room codes, team ids, mode), ≤40 chars
 *   "int"    — finite number, rounded to an integer
 *   "float1" — finite number, rounded to one decimal
 *   "bool"   — strictly boolean; anything else is stripped, not coerced
 * ================================================================ */

export const EVENT_SCHEMA = Object.freeze({
  // M1 one front door: which experience the "Start a party" chooser picked
  // ("phones" | "tv"), and a code routed through the landing's single join
  // path ("h2h" | "couch") — both fired from the landing page.
  party_choice: { choice: "string" },
  front_door_join: { mode: "string" },
  // difficulty (S3) is the host's pool setting: "casual" | "world" |
  // "expert". room is the join key that lets the tier KPI break
  // guess_submitted.distance_km down by the room's difficulty (h2h guesses
  // fire on other phones, so a device/person join can't do it).
  // auto_submit (overnight bundle #2): the h2h room's autoSubmitOnTimeout
  // setting — did the host opt into auto-locking pins at the buzzer, or leave
  // the default "wait for players"? Answers whether the forced-forfeit default
  // was ever what hosts actually wanted. h2h only; absent on couch/daily.
  game_created: {
    room: "string", mode: "string", num_teams: "int", num_rounds: "int",
    round_seconds: "int", difficulty: "string", auto_submit: "bool",
  },
  team_joined: { mode: "string", team_count: "int" },
  // via: how this screen got attached — "qr" (scanned, usually then cast to
  // the TV) | "link" (shared TV link opened) | "typed" (code entered by
  // hand) | "follow" (auto-rejoined the host's next game). Feeds the
  // which-path-attaches-TVs question behind the Add a TV affordance.
  screen_joined: { room: "string", mode: "string", via: "string" },
  // advance: how this round was reached from the previous reveal — "auto"
  // (the S6 soft auto-advance fired) | "manual" (host tapped Next Round).
  // Absent on round 1, which no reveal precedes.
  // screen_attached (S7): was a TV heartbeat live when the round started?
  // Couch only — it splits the game_created → round_started funnel by TV
  // presence, the KPI behind removing the couch screen gate.
  // twist (G2, §7.1): the round's twist id ("blitz"|"frozen"|"blind"|
  // "longhaul"), absent when the round is plain — twist frequency in practice
  // and completion of twisted vs. plain rounds.
  round_started: {
    room: "string", mode: "string", round_number: "int", advance: "string",
    screen_attached: "bool", twist: "string",
  },
  // moved: the pano was navigated off the round's anchor image before this
  // pin (street movement got used) — an image-id comparison, never a place.
  // twist/decoy (G2/G7): distance/time by twist, decoy deployment rate, and
  // the rival-behavior shift on decoyed rounds (join on room + round_number —
  // the reason round_number is added here, §7.1). decoy is a bool flag only;
  // the decoy's coordinates never ride (BANNED_KEY_RE would strip them anyway).
  guess_submitted: {
    room: "string", mode: "string", team_id: "string",
    distance_km: "float1", time_bonus: "int", total_score: "int",
    time_seconds: "float1", super_sure: "bool", moved: "bool",
    round_number: "int", twist: "string", decoy: "bool",
  },
  // forfeits (overnight bundle #2): how many teams closed this round with no
  // pin (timed-out, swept, or gave up). Paired with game_created.auto_submit it
  // measures whether "wait for players" actually cuts forfeits vs. auto-lock.
  // A count only — never who forfeited.
  reveal_shown: {
    room: "string", mode: "string", round_number: "int", forfeits: "int",
  },
  // One event per SUPER SURE bet, fired from the host phone at the reveal
  // (a burned bet has no guess_submitted — a forfeit is not a guess — and
  // win/lose is only known at reveal). outcome: "won" | "lost" | "burned";
  // round_total is the raw round total at stake (0 when burned).
  super_sure_resolved: {
    mode: "string", round_number: "int", rounds: "int",
    outcome: "string", round_total: "int",
  },
  // Guess-modifier discovery funnel (docs/guess-modifier-design.md §A2). The
  // pin-drop callout is teased on every round's first pin (from round 1) while
  // a modifier is unspent; when tapped it opens the modifier's sheet. modifier
  // is "super" | "decoy" | "both" ("both" when more than one is available, so
  // the sheet/callout presents them co-equally). via is "callout" only — the
  // callout is the single door (§A2: the bar chip and cross-offers are
  // retired). These two REPLACE super_sure_sheet_opened (removed) with a
  // per-modifier funnel — its historical data stays queryable in PostHog
  // (docs/analytics.md records the supersession).
  modifier_callout_shown: { mode: "string", modifier: "string", round_number: "int" },
  modifier_sheet_opened: { mode: "string", modifier: "string", via: "string" },
  // A decoy was planted — the decoy's deployment moment (its analogue of
  // super_sure_resolved; a decoy has no won/lost, so plant time IS its
  // resolution). Fired on the planter's phone at plant. rounds mirrors
  // super_sure_resolved for the timing KPI. mode is always "h2h" today; carried
  // for uniformity.
  decoy_planted: { mode: "string", round_number: "int", rounds: "int" },
  // S6: the host held the auto-advance countdown open (wanted more time on
  // the reveal). seconds_left is what remained of the countdown when held —
  // consistently small values mean the default countdown is too short.
  auto_advance_hold: {
    room: "string", mode: "string", round_number: "int", seconds_left: "int",
  },
  // advance mirrors round_started: how the final reveal resolved to the
  // scoreboard ("auto" | "manual"; absent on pool-exhaustion ends).
  game_completed: {
    room: "string", mode: "string", rounds: "int", winner_team: "string",
    winning_score: "int", team_count: "int", advance: "string",
  },
  game_abandoned: { room: "string", mode: "string", rounds_played: "int" },
  // method: "share" (Web Share sheet) | "copy" (clipboard fallback).
  invite_shared: { mode: "string", method: "string" },
  // The lobby "Send the TV link" affordance was used (both modes); method
  // mirrors invite_shared. Pairs with screen_joined.via="link" to show
  // whether handed-over TV links actually get opened.
  tv_link_shared: { mode: "string", method: "string" },
  // S1 share artifact: a post-game result card left the app. mode adds
  // "daily" to the usual pair; method mirrors invite_shared. The card's
  // link is UTM-tagged (utm_source=share) — inbound attribution rides on
  // PostHog's automatic utm_* capture, not on this event.
  // challenge (G5, §7.1): this shared card carries a ghost payload (a duel
  // link) vs. a plain card — the top of the duel funnel.
  result_shared: { mode: "string", method: "string", challenge: "bool" },
  // S2 Daily Challenge. day_number is the public puzzle index ("Daily #37")
  // — a calendar fact shared by every player that day, never an identity.
  // G1/G5/G6 extend it: hard (which board), vs_ghost (a duel run), streak
  // (count BEFORE the run — retention health at the source). No ghost payload
  // byte ever rides — only these aggregate flags/counts.
  daily_challenge_started: {
    day_number: "int", hard: "bool", vs_ghost: "bool", streak: "int",
  },
  // rounds_played counts rounds with a pin (0–5; forfeits excluded);
  // best_distance_km is the run's closest guess (absent when all forfeit).
  // G1/G4/G5/G6/G8 extend it: hard, vs_ghost, streak (after), pb (a personal
  // best was set), aces (this run's sub-1km pins).
  daily_challenge_completed: {
    day_number: "int", score: "int", rounds_played: "int",
    best_distance_km: "float1", hard: "bool", vs_ghost: "bool",
    streak: "int", pb: "bool", aces: "int",
  },
  // G5 Ghost Duels (§7.1). Fired on the RECIPIENT's device at the verdict.
  // margin is a score difference — the same class of aggregate as
  // winning_score; no pin, timing, or payload byte ever rides.
  ghost_duel_completed: {
    day_number: "int", outcome: "string", margin: "int", hard: "bool",
  },
  // G5: a challenge link failed to open into a duel. reason ∈
  // malformed|version|expired|pool — link rot in the wild.
  ghost_link_invalid: { reason: "string" },
  // Daily "Your five places" recap (docs/analytics.md). Fired at most ONCE per
  // done-screen render, when the player actually engages the recap — swiping a
  // carousel card. source ∈ "swipe". vs_ghost/hard tag which board it was.
  // Engagement rate = daily_recap_engaged ÷ daily_challenge_completed.
  // Aggregates only; no place name or coordinate rides (the recap's city names
  // live in the DOM, masked, never on an event).
  daily_recap_engaged: {
    day_number: "int", source: "string", vs_ghost: "bool", hard: "bool",
  },
  // Daily mid-run persistence (docs/daily-persistence-spec.md §10). Fired at
  // the moment of choice on a device that had saved mid-run state:
  // action ∈ "resume" (continued at round rounds_done+1, incl. the 5-round
  // finalize rescue) | "discarded" (the save was invalid/drifted and a fresh
  // run started — the one forced-fresh path). "restart" is RETIRED: the
  // player-facing "Start over" was removed 2026-08-29 (owner directive — once
  // you've started you may only continue), so it has no live call site, though
  // the string still appears on historical events and the field stays free.
  // rounds_done is how many rounds the save held (0 when unparseable). No
  // coordinate, pin, image id, or payload byte rides — aggregates only.
  daily_resumed: {
    day_number: "int", rounds_done: "int", hard: "bool", action: "string",
  },
  // Poisoned-anchor skip (owner hotfix 2026-08-29, daily.js §poisoned-anchor).
  // Fired when a Daily round's anchor failed to load on a transient-but-
  // persistent class (e.g. HTTP 500 is_transient) even after DAILY_ANCHOR_RETRY_MAX
  // same-anchor retries, so the seeded sampler skipped past it to the next
  // entry (skip-with-replacement — the run never dead-ends). pool_entry is the
  // opaque poolDiagId of the SKIPPED entry (never the raw Mapillary id, never a
  // coordinate); attempts is how many load attempts were burned on it before
  // the skip (retries + 1). KPI: daily anchor-skip rate = daily_anchor_skipped
  // ÷ daily_challenge_started — a spike names a freshly-rotted pool entry.
  daily_anchor_skipped: { pool_entry: "string", attempts: "int" },
  // Party game-over "Where were the places" recap (docs/party-recap-spec.md).
  // Fired at most ONCE per game-over render, when the recap is actually
  // engaged — a carousel card scrolled. surface: "host" | "player" (the TV
  // recap is passive — no interaction to measure, no event). Aggregates only:
  // no place name, coordinate, or team name rides; rounds_shown is how many
  // cards the carousel held (≤ settings.roundCount when a device missed
  // rounds). Engagement rate = party_recap_engaged ÷ game_completed.
  party_recap_engaged: {
    room: "string", mode: "string", surface: "string",
    rounds_shown: "int", source: "string",
  },
  // G3 Crown Night (§7.1). Fired by the phase-writing device at a champion.
  // games is how many games the night took to reach first-to-3.
  night_champion: { mode: "string", games: "int" },
  // S5 PWA: the landing page was launched as an installed app (standalone
  // display mode — the manifest's start_url lands there). No properties:
  // the launch itself is the signal; PostHog's device id carries retention.
  pwa_launch: {},
  // S4 sound + motion: the 🔊/🔇 toggle was used. surface: "host" | "player"
  // | "tv" | "daily"; enabled is the state AFTER the tap. Phones default
  // muted and the TV defaults on, so opt-ins (phone → on) and opt-outs
  // (tv → off) directly test the "silence reads as unfinished" hypothesis.
  sound_toggled: { surface: "string", enabled: "bool" },
  consent_given: {},
  consent_denied: {},
  next_game: { mode: "string" },
  // §6 how-to-play page. source is where the link was tapped from —
  // "footer" (landing footer) | "gameover" (a game-over/done screen) — the
  // onboarding-funnel question: does the explainer get found, and from
  // where? howto.html itself has no controller/events beyond this one.
  howto_opened: { source: "string" },
  // Team-roster brief: which entry path filled a couch team-name input at
  // game creation — "typed" (hand-entered) | "pun" (🎲 Surprise me) |
  // "recent" (a Recent teams chip, a type-ahead pick, or the pre-fill from
  // the device's last-used name). Answers whether the pun bank / recent
  // roster actually cut typing, never the name itself.
  team_name_used: { mode: "string", source: "string" },

  /* ---- Field observability (docs/field-observability-plan.md §7.1) ----
   * Aggregates only. `pool_entry` is the opaque diag id from
   * imagery.js#poolDiagId — never the raw Mapillary image id, never a
   * coordinate. Browser/OS/device class ride on PostHog's automatic
   * $browser / $os / $device_type, so no custom property needs them.
   */

  // One per createViewer() call, success or failure.
  viewer_init: {
    surface: "string",      // host|player|tv|tv_panel|daily|landing
    ok: "bool",
    error_class: "string",  // §5 enum; absent when ok
    duration_ms: "int",
    webgl: "bool",          // mapillary.isSupported()
    sdk: "string",          // pinned MapillaryJS tag
  },

  // One per moveTo outcome, and one per round-start skip-loop resolution.
  // NOTE: the plan calls the "resolved after the timeout already fired"
  // flag `late`; it is named `after_timeout` here because BANNED_KEY_RE
  // (/lat|.../) strips any key containing "lat" — including "late" — before
  // the allowlist is consulted. Renaming the property was the safe fix;
  // weakening the coordinate guard was not.
  imagery_load: {
    surface: "string",
    purpose: "string",       // anchor|resume|follow|seed|hero|nav
    ok: "bool",
    after_timeout: "bool",   // resolved after our timeout already fired
    error_class: "string",
    duration_ms: "int",
    skips: "int",            // dead entries burned before this outcome
    pool_entry: "string",    // opaque diag id (§8)
    net_type: "string",      // navigator.connection.effectiveType|"unknown"
    online: "bool",
  },

  // One per (surface, round) when the round leaves play or the viewer dies.
  pano_session: {
    surface: "string",
    round_number: "int",
    looks: "int",            // pov-change bursts (throttled count)
    zoom_changes: "int",
    nav_moves: "int",        // image changes not caused by our own moveTo
    nav_failures: "int",
    // DEPRECATED (issue #2): `navigable` never emits usefully in our setup, so
    // this has been false for every historical session. Retained for continuity
    // but NO LONGER an input to classifySessionHealth — prefer the edge counts
    // below. Do not build new signal on this field.
    nav_available: "bool",   // last `navigable` state seen (deprecated)
    // Issue #2: bounded (0..EDGE_COUNT_CAP) counts of the ROUND ANCHOR image's
    // MapillaryJS navigation edges — spatial (the arrow/step network the
    // "arrows vanished" reports concern) and sequence (along-capture). A count
    // is recorded only when the SDK marks the edge status cached, so "unknown"
    // stays absent rather than a false zero. Aggregates only: no id, no
    // coordinate, no edge payload. Absent when never observed.
    anchor_spatial_edges: "int",
    anchor_sequence_edges: "int",
    // Issue #2 Phase 2: count of setFilter() recovery attempts this round
    // (0..EDGE_RECOVERY_MAX_ATTEMPTS). Absent when recovery never ran (the
    // healthy majority) — pairs with the edge_recovery event below.
    edge_recoveries: "int",
    // §18 (docs/ios-blackout-review.md): a render-death probe condemned this
    // round's canvas (black pano behind a live HUD). Absent-when-false, the
    // edge_recoveries convention — present only on a genuine death, for funnel
    // joins against render_probe / the render_dead exception.
    render_dead: "bool",
    // §18/G3: the round fold was flushed on pagehide (a mid-round abandon:
    // reload/tab close), NOT at a normal round boundary. Absent-when-false;
    // lets dashboards exclude or study torn rounds explicitly.
    partial: "bool",
    reanchors: "int",        // re-anchor writes during active play
    first_move_ms: "int",    // round start → first user interaction
    pointer_downs: "int",    // with looks==0 → gesture_blocked signal
  },

  // Issue #2 Phase 2 (docs/issue-2-phase2-fix.md): one per bounded
  // spatial-edge recovery attempt, capped at EDGE_RECOVERY_MAX_ATTEMPTS (2)
  // per round by the pure state machine in imagery.js. trigger/result are
  // the decideEdgeRecovery / classifyEdgeRecoveryOutcome enums; spatial_after
  // / sequence_after are bounded post-attempt counts (absent when still
  // unknown). Pure aggregates — no id, no coordinate, no edge payload.
  edge_recovery: {
    surface: "string",       // host|player|daily (moveEnabled surfaces only)
    round_number: "int",
    attempt: "int",          // 1-based, ≤ EDGE_RECOVERY_MAX_ATTEMPTS
    trigger: "string",       // "uncached" | "zero"
    result: "string",        // "recovered" | "no_change" | "error"
    spatial_after: "int",
    sequence_after: "int",
    duration_ms: "int",      // setFilter call → outcome classified
    net_type: "string",
    online: "bool",
  },

  // §18 render-death probe (docs/ios-blackout-review.md). One per NON-alive
  // render probe verdict (≤4/round by the probe schedule) — the measurement
  // stream behind the §2.3 "suspect" policy decision and the render-death-rate
  // KPI. Aggregates only: verdict/signal booleans and timings, never a canvas
  // pixel, image id, coordinate, or user input.
  render_probe: {
    surface: "string",       // host|player|tv|tv_panel|daily|landing
    round_number: "int",
    verdict: "string",       // "dead" | "suspect"
    ctx_lost: "bool",        // gl.isContextLost() (absent when unreadable)
    canary_ok: "bool",       // offscreen GPU canary (absent when it didn't run)
    sample: "string",        // "content" | "blank" | "unreadable" | "skipped"
    since_load_ms: "int",    // anchor/resume ok → this probe
    net_type: "string",
    online: "bool",
  },

  // §18. One per bounded viewer-rebuild attempt (≤2/session by the pure
  // bounds). trigger is why the canvas was condemned; result is the outcome of
  // the in-place rebuild + resume. Its own event (not folded into
  // edge_recovery) so the spatial-edge-recovery KPI stays uncontaminated.
  render_recovery: {
    surface: "string",
    round_number: "int",
    attempt: "int",          // 1-based, ≤ RENDER_REBUILD_MAX_PER_SESSION
    trigger: "string",       // "context_lost" | "canary_dead"
    result: "string",        // "recovered" | "rebuild_failed" | "still_dead"
    duration_ms: "int",      // verdict → outcome classified
    net_type: "string",
    online: "bool",
  },

  // One per user-initiated report (§10). consent is "analytics" (the user
  // had already accepted) or "one_time" (the §10.4 one-shot path).
  imagery_report: {
    surface: "string",
    ref_code: "string",      // "GP-XXXXXX"
    error_class: "string",   // last classified failure, or "none"
    pool_entry: "string",
    net_type: "string",
    online: "bool",
    recent_failures: "int",
    consent: "string",
  },
});

/* ================================================================
 * Exception property allowlist (§7.2) + release super properties (§11)
 * ================================================================ */

// trackError() mirrors track(): consent check, then this allowlist. Same
// types as EVENT_SCHEMA, same BANNED_KEY_RE sweep.
export const EXCEPTION_PROPS = Object.freeze({
  surface: "string", purpose: "string", error_class: "string",
  pool_entry: "string", duration_ms: "int", skips: "int",
  net_type: "string", online: "bool", webgl: "bool", ref_code: "string",
});

// Registered once per session after a successful init. `release`/`commit`/
// `deployed_at` come from release.json (async, deploy-written, absent in a
// dev checkout → release "dev"). All three are aggregates by construction;
// BANNED_KEY_RE does not match them.
export const RELEASE_PROPS = Object.freeze({
  release: "string", commit: "string", deployed_at: "string",
});

// Defense in depth: even if a call site (or a future schema edit) tries to
// pass location-ish or identity-ish data, these key patterns are stripped
// before the allowlist is consulted.
const BANNED_KEY_RE = /lat|lng|lon|coord|pin|guess$|name|email|device|user/i;
const STRING_MAX = 40;

// Sanitize a props bag against an allowlist (an EVENT_SCHEMA entry, or
// EXCEPTION_PROPS / RELEASE_PROPS). Unknown keys never survive: we iterate
// the ALLOWLIST, not the input.
export function sanitizeProps(schema, props) {
  const clean = {};
  const src = props || {};
  for (const key of Object.keys(schema)) {
    if (BANNED_KEY_RE.test(key)) continue;
    const v = src[key];
    const type = schema[key];
    if (type === "string") {
      if (typeof v === "string" && v.length > 0 && v.length <= STRING_MAX) {
        clean[key] = v;
      }
    } else if (type === "bool") {
      if (typeof v === "boolean") clean[key] = v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      clean[key] = type === "float1" ? Math.round(v * 10) / 10 : Math.round(v);
    }
  }
  return clean;
}

// Validate one (event, props) pair against the schema. Returns
// { event, props } with only clean allowlisted properties, or null when the
// event itself is unknown — callers drop nulls silently.
export function sanitizeEvent(event, props) {
  const schema = EVENT_SCHEMA[event];
  if (!schema) return null;
  return { event, props: sanitizeProps(schema, props) };
}

// The Error we hand to posthog.captureException is always OUR wrapper, so a
// raw SDK message can never smuggle an image id or a tokened URL into the
// issue title. `errorFactory` is injected so this stays pure/testable.
export function makeImageryError(errorClass, originalMessage, ErrorCtor) {
  const Ctor = ErrorCtor || Error;
  const scrubbed = scrubErrorMessage(originalMessage);
  const err = new Ctor(
    scrubbed ? `ImageryError: ${errorClass} — ${scrubbed}`
      : `ImageryError: ${errorClass}`,
  );
  err.name = "ImageryError";
  return err;
}

/* ================================================================
 * The gated tracker. All effects are injected so this is testable:
 *   storage     — localStorage-shaped
 *   loadPosthog — (projectKey, initOptions) => Promise<posthog-like>;
 *                 the browser impl injects the script tag and inits.
 * Nothing calls loadPosthog until consent is CONSENT_ACCEPTED.
 * ================================================================ */

const QUEUE_MAX = 100; // events buffered while the script is in flight

export function createAnalytics({ storage, loadPosthog, loadPosthogOneShot }) {
  let posthog = null;
  let loadPromise = null;
  let optedOut = false;
  let registered = null;   // release super props, applied on/after load
  const queue = [];

  const consent = () => getConsent(storage);

  function flushQueue() {
    while (queue.length && posthog) {
      const item = queue.shift();
      if (item.kind === "error") {
        captureError(item.error, item.props);
      } else {
        posthog.capture(item.event, item.props);
      }
    }
  }

  // posthog.captureException is only present on a current posthog-js; an
  // older/blocked bundle silently degrades to the aggregated event.
  function captureError(error, props) {
    if (!posthog) return false;
    if (typeof posthog.captureException === "function") {
      posthog.captureException(error, props);
      return true;
    }
    return false;
  }

  function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(() => loadPosthog(POSTHOG_PROJECT_KEY, POSTHOG_INIT_OPTIONS))
        .then((ph) => {
          posthog = ph || null;
          // Consent may have been revoked while the script was in flight:
          // drop the buffer and stop capturing instead of flushing it.
          if (consent() === CONSENT_ACCEPTED) {
            if (registered && posthog && posthog.register) {
              posthog.register(registered);
            }
            flushQueue();
          } else {
            queue.length = 0;
            if (posthog && posthog.opt_out_capturing) {
              posthog.opt_out_capturing();
              optedOut = true;
            }
          }
          return posthog;
        })
        .catch((e) => {
          // Blocked network / ad blocker: analytics silently stays off.
          loadPromise = null;
          queue.length = 0;
          if (typeof console !== "undefined") {
            // Scrubbed for parity with the controllers: this fires only when
            // PostHog never loaded (so no replay can capture it today), but the
            // console-scrub guard covers every production file uniformly and a
            // bare error here would be an un-scrubbed leak shape (review RF-1).
            console.warn("analytics: PostHog failed to load:", scrubErrorMessage(e));
          }
          return null;
        });
    }
    return loadPromise;
  }

  return {
    consentState: consent,
    hasConsent: () => consent() === CONSENT_ACCEPTED,

    // Boot hook: resume capturing when a past session already opted in.
    // Never loads anything otherwise.
    init() {
      return consent() === CONSENT_ACCEPTED
        ? ensureLoaded()
        : Promise.resolve(null);
    },

    // Capture one product event. Returns true only when the event was
    // accepted for delivery (consent given AND the event passed the schema).
    track(event, props) {
      if (consent() !== CONSENT_ACCEPTED) return false;
      const clean = sanitizeEvent(event, props);
      if (!clean) return false;
      if (posthog) {
        posthog.capture(clean.event, clean.props);
      } else {
        if (queue.length < QUEUE_MAX) queue.push(clean);
        ensureLoaded();
      }
      return true;
    },

    // Capture one handled failure as a PostHog issue. Same gate as track():
    // no consent, nothing happens — not even a load. `error` must already be
    // our own scrubbed wrapper (see makeImageryError); props go through the
    // EXCEPTION_PROPS allowlist. Returns true when accepted for delivery.
    trackError(error, props) {
      if (consent() !== CONSENT_ACCEPTED) return false;
      if (!error) return false;
      const clean = sanitizeProps(EXCEPTION_PROPS, props);
      if (posthog) {
        captureError(error, clean);
      } else {
        if (queue.length < QUEUE_MAX) {
          queue.push({ kind: "error", error, props: clean });
        }
        ensureLoaded();
      }
      return true;
    },

    // Release stamping (§11): register release/commit/deployed_at as super
    // properties so every event, exception and replay is release-correlated.
    // Consent-gated like everything else; buffered until the script lands.
    register(props) {
      if (consent() !== CONSENT_ACCEPTED) return false;
      const clean = sanitizeProps(RELEASE_PROPS, props);
      if (!Object.keys(clean).length) return false;
      registered = { ...(registered || {}), ...clean };
      if (posthog && posthog.register) posthog.register(registered);
      return true;
    },

    // §9.3 client-side recording override: when the wrapper classifies a
    // failure or a degraded condition we force this session to record, so a
    // negative sampling decision in Stage 2+ cannot lose the evidence. In
    // learning mode (100% sampling) this is a redundant no-op by design.
    startRecording() {
      if (consent() !== CONSENT_ACCEPTED) return false;
      if (!posthog || typeof posthog.startSessionRecording !== "function") {
        return false;
      }
      try { posthog.startSessionRecording(); } catch { return false; }
      return true;
    },

    // §10.4 — the ONLY capture path outside the accepted-consent gate.
    // User-initiated, explicitly consented in its own dialog, exactly one
    // bundle: memory persistence (no cookies/localStorage), no replay, no
    // autocapture, and the stored consent flag is NEVER touched. When the
    // user has already accepted, this is just the normal gated path.
    sendDiagnostic({ event, props, error, errorProps }) {
      if (consent() === CONSENT_ACCEPTED) {
        const okEvent = this.track(event, props);
        if (error) this.trackError(error, errorProps);
        return Promise.resolve(okEvent);
      }
      const clean = sanitizeEvent(event, props);
      if (!clean || typeof loadPosthogOneShot !== "function") {
        return Promise.resolve(false);
      }
      const cleanErrProps = sanitizeProps(EXCEPTION_PROPS, errorProps);
      return Promise.resolve()
        .then(() => loadPosthogOneShot(POSTHOG_PROJECT_KEY, oneShotInitOptions()))
        .then((ph) => {
          if (!ph) return false;
          ph.capture(clean.event, clean.props);
          if (error && typeof ph.captureException === "function") {
            ph.captureException(error, cleanErrProps);
          }
          // One report, not ongoing tracking: stop immediately.
          if (typeof ph.opt_out_capturing === "function") {
            ph.opt_out_capturing();
          }
          return true;
        })
        .catch(() => false);
    },

    // User accepted: persist, load PostHog (first time), record the choice.
    accept() {
      setConsent(storage, CONSENT_ACCEPTED);
      return ensureLoaded().then((ph) => {
        if (!ph) return null;
        // The script can finish loading AFTER a decline/revoke that raced
        // this acceptance. ensureLoaded() already dropped the queue and
        // opted this session out in that case; this late handler must NOT
        // undo that by re-opting-in or capturing consent_given. Decline
        // always wins — re-check the stored flag before acting on it.
        if (consent() !== CONSENT_ACCEPTED) return null;
        if (optedOut && ph.opt_in_capturing) {
          ph.opt_in_capturing();
          optedOut = false;
        }
        ph.capture("consent_given", {});
        return ph;
      });
    },

    // User declined (or revoked). A first-time decline records nothing —
    // PostHog was never loaded. A revoke after acceptance sends one final
    // consent_denied so the opt-out shows up in the numbers, then stops
    // all capturing.
    decline() {
      const wasAccepted = consent() === CONSENT_ACCEPTED;
      setConsent(storage, CONSENT_DECLINED);
      if (wasAccepted && posthog) {
        posthog.capture("consent_denied", {});
        if (posthog.opt_out_capturing) {
          posthog.opt_out_capturing();
          optedOut = true;
        }
      }
    },
  };
}
