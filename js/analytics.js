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
};

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
  game_created: {
    mode: "string", num_teams: "int", num_rounds: "int", round_seconds: "int",
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
  round_started: {
    room: "string", mode: "string", round_number: "int", advance: "string",
  },
  guess_submitted: {
    room: "string", mode: "string", team_id: "string",
    distance_km: "float1", time_bonus: "int", total_score: "int",
    time_seconds: "float1", super_sure: "bool",
  },
  reveal_shown: { room: "string", mode: "string", round_number: "int" },
  // One event per SUPER SURE bet, fired from the host phone at the reveal
  // (a burned bet has no guess_submitted — a forfeit is not a guess — and
  // win/lose is only known at reveal). outcome: "won" | "lost" | "burned";
  // round_total is the raw round total at stake (0 when burned).
  super_sure_resolved: {
    mode: "string", round_number: "int", rounds: "int",
    outcome: "string", round_total: "int",
  },
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
  result_shared: { mode: "string", method: "string" },
  // S2 Daily Challenge. day_number is the public puzzle index ("Daily #37")
  // — a calendar fact shared by every player that day, never an identity.
  daily_challenge_started: { day_number: "int" },
  // rounds_played counts rounds with a pin (0–5; forfeits excluded);
  // best_distance_km is the run's closest guess (absent when all forfeit).
  daily_challenge_completed: {
    day_number: "int", score: "int", rounds_played: "int",
    best_distance_km: "float1",
  },
  consent_given: {},
  consent_denied: {},
  next_game: { mode: "string" },
});

// Defense in depth: even if a call site (or a future schema edit) tries to
// pass location-ish or identity-ish data, these key patterns are stripped
// before the allowlist is consulted.
const BANNED_KEY_RE = /lat|lng|lon|coord|pin|guess$|name|email|device|user/i;
const STRING_MAX = 40;

// Validate one (event, props) pair against the schema. Returns
// { event, props } with only clean allowlisted properties, or null when the
// event itself is unknown — callers drop nulls silently.
export function sanitizeEvent(event, props) {
  const schema = EVENT_SCHEMA[event];
  if (!schema) return null;
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
  return { event, props: clean };
}

/* ================================================================
 * The gated tracker. All effects are injected so this is testable:
 *   storage     — localStorage-shaped
 *   loadPosthog — (projectKey, initOptions) => Promise<posthog-like>;
 *                 the browser impl injects the script tag and inits.
 * Nothing calls loadPosthog until consent is CONSENT_ACCEPTED.
 * ================================================================ */

const QUEUE_MAX = 100; // events buffered while the script is in flight

export function createAnalytics({ storage, loadPosthog }) {
  let posthog = null;
  let loadPromise = null;
  let optedOut = false;
  const queue = [];

  const consent = () => getConsent(storage);

  function flushQueue() {
    while (queue.length && posthog) {
      const { event, props } = queue.shift();
      posthog.capture(event, props);
    }
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
            console.warn("analytics: PostHog failed to load", e);
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

    // User accepted: persist, load PostHog (first time), record the choice.
    accept() {
      setConsent(storage, CONSENT_ACCEPTED);
      return ensureLoaded().then((ph) => {
        if (!ph) return null;
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
