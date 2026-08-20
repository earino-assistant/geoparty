// consent.js — GDPR opt-in gate + PostHog bootstrap, shared by every page
// (index, host, player, screen). All logic lives in analytics.js (pure,
// tested); this module is only the browser glue:
//   - renders the consent banner for first-time visitors,
//   - injects the PostHog script ONLY after an explicit accept,
//   - shows a small 🍪 control to change the choice later,
//   - exports track() for the UI modules to instrument features with.
// Docs: docs/analytics.md (events/KPIs) and PRIVACY.md (what & why).

import {
  createAnalytics,
  getConsent,
  CONSENT_ACCEPTED,
  POSTHOG_SCRIPT_URL,
} from "./analytics.js";

// §9.3 remote kill switch: recording is linked to this PostHog feature flag
// project-side; the client honours it too, so flipping it off stops replay
// in every open tab without a deploy.
export const REPLAY_FLAG = "replay-imagery-debug";

// Inject posthog-js directly (no inline snippet — CSP-friendlier). Called at
// most once per page, and never before an explicit accept OR an explicit
// one-time diagnostic consent. Injecting the bundle captures nothing on its
// own: only init() starts anything.
let scriptPromise = null;

function injectPosthogScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.posthog) { resolve(); return; }
    const s = document.createElement("script");
    s.src = POSTHOG_SCRIPT_URL;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("PostHog script failed to load"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

// Init the page's primary instance with the verbatim owner-provided
// key/options from analytics.js.
function loadPosthogScript(projectKey, initOptions) {
  return injectPosthogScript().then(() => {
    if (!window.posthog.__loaded) {
      window.posthog.init(projectKey, initOptions);
    }
    return window.posthog;
  });
}

// §10.4 one-time diagnostic report: a SECOND, named posthog instance with
// memory persistence, no autocapture and no recording. It never touches the
// stored consent flag and never becomes the page's primary instance, so a
// decliner's "no" survives the report untouched.
const ONE_SHOT_INSTANCE = "gpDiag";

function loadPosthogOneShot(projectKey, initOptions) {
  return injectPosthogScript().then(() => {
    const existing = window.posthog && window.posthog[ONE_SHOT_INSTANCE];
    if (existing) return existing;
    const inst = window.posthog.init(projectKey, initOptions, ONE_SHOT_INSTANCE);
    return inst || window.posthog[ONE_SHOT_INSTANCE] || null;
  });
}

const analytics = createAnalytics({
  storage: window.localStorage,
  loadPosthog: loadPosthogScript,
  loadPosthogOneShot,
});

// The one function feature code calls. Safe anywhere: without consent (or
// with a bad event/props shape) it's a validated no-op.
export const track = (event, props) => analytics.track(event, props);

// Handled failures → PostHog issues, behind the identical consent gate.
export const trackError = (error, props) => analytics.trackError(error, props);

// Force this session to record (see analytics.startRecording / plan §9.3).
export const startRecording = () => analytics.startRecording();

export const analyticsConsentState = () => analytics.consentState();
export const hasAnalyticsConsent = () => analytics.hasConsent();

// PostHog's own session id — the seed the report flow derives its support
// reference code from, so a code found on a support email resolves to a
// session (and its replay) in one search. Empty without consent.
export function posthogSessionId() {
  try {
    return (window.posthog && typeof window.posthog.get_session_id === "function")
      ? window.posthog.get_session_id() : "";
  } catch { return ""; }
}

// The report flow's single send. With accepted consent this is the ordinary
// gated path; otherwise it is the explicit one-shot of §10.4 — and the
// caller must already have shown the one-time consent dialog.
export const sendDiagnosticReport = (bundle) => analytics.sendDiagnostic(bundle);

/* ================================================================
 * §11 Release stamping — register the deployed SHA as super properties
 * ================================================================ */

let releaseStamped = false;

function stampRelease(ph) {
  if (!ph || releaseStamped) return;
  releaseStamped = true;
  // Absent release.json (dev checkout, file://) is the normal local case:
  // everything from a working copy is simply "dev".
  fetch("release.json", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((meta) => {
      if (meta && typeof meta.short === "string") {
        analytics.register({
          release: meta.short,
          commit: typeof meta.commit === "string" ? meta.commit : "",
          deployed_at:
            typeof meta.deployed_at === "string" ? meta.deployed_at : "",
        });
      } else {
        analytics.register({ release: "dev" });
      }
    })
    .catch(() => analytics.register({ release: "dev" }));
  applyReplayKillSwitch(ph);
}

// Second lever on the kill switch: if the flag is explicitly off for this
// user, stop recording client-side too (the project-side link is the first).
function applyReplayKillSwitch(ph) {
  if (!ph || typeof ph.onFeatureFlags !== "function") return;
  try {
    ph.onFeatureFlags(() => {
      if (typeof ph.isFeatureEnabled !== "function") return;
      if (ph.isFeatureEnabled(REPLAY_FLAG) === false &&
          typeof ph.stopSessionRecording === "function") {
        ph.stopSessionRecording();
      }
    });
  } catch { /* older bundle: the project-side link still governs */ }
}

/* ================================================================
 * Banner + settings control (injected — page HTML untouched)
 * ================================================================ */

let banner = null;
let gear = null;

function ensureBanner() {
  if (banner) return banner;
  banner = document.createElement("div");
  banner.id = "consentBanner";
  banner.className = "consent-banner";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", "Analytics consent");

  const text = document.createElement("p");
  text.append(
    "\u{1F30D} Help make GeoParty better? We’d like to collect ",
    "anonymous play stats — game mode, rounds, scores, distances — ",
    "plus technical diagnostics and an anonymised session replay of the ",
    "screens you see, so we can fix broken imagery. Never your map guesses, ",
    "names, anything you type, or the street view itself. ",
    "EU-hosted, no ads, change your mind anytime.",
  );
  const status = document.createElement("span");
  status.className = "consent-status";
  text.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "consent-actions";
  const decline = document.createElement("button");
  decline.id = "consentDecline";
  decline.textContent = "No thanks";
  const accept = document.createElement("button");
  accept.id = "consentAccept";
  accept.className = "btn-primary";
  accept.textContent = "Sounds good";
  actions.append(decline, accept);

  // The calm-state report path (plan §10.1 as reconciled with the UI/UX
  // review): no permanent chrome on the pano, but a findable link on the
  // diagnostics settings surface. Hidden on the first-run banner — a
  // first-time visitor has nothing to report yet — and shown only when the
  // banner is REOPENED from the 🍪 control.
  const report = document.createElement("button");
  report.id = "consentReport";
  report.type = "button";
  report.className = "consent-report hidden";
  report.textContent = "\u{1F4F7} Image not working? Report it";
  report.addEventListener("click", () => {
    closeBanner();
    import("./report-ui.js")
      .then((m) => m.openReportFromSettings(surfaceName()))
      .catch(() => { /* module blocked/offline: nothing to do */ });
  });

  banner.append(text, actions, report);

  accept.addEventListener("click", () => {
    analytics.accept().then(stampRelease);
    closeBanner();
  });
  decline.addEventListener("click", () => {
    analytics.decline();
    closeBanner();
  });

  document.body.appendChild(banner);
  return banner;
}

// Which page is asking — the report bundle's `surface` property. Derived
// from the document, never from anything a user typed.
function surfaceName() {
  const path = (location.pathname || "").toLowerCase();
  if (path.includes("host")) return "host";
  if (path.includes("player")) return "player";
  if (path.includes("daily")) return "daily";
  if (path.includes("screen")) return "tv";
  return "landing";
}

function openBanner() {
  const el = ensureBanner();
  const status = el.querySelector(".consent-status");
  const consent = getConsent(window.localStorage);
  status.textContent = consent
    ? ` Currently: ${consent === CONSENT_ACCEPTED ? "on" : "off"}.`
    : "";
  el.querySelector(".consent-report")
    .classList.toggle("hidden", consent === null);
  el.classList.remove("hidden");
  if (gear) gear.classList.add("hidden");
}

function closeBanner() {
  if (banner) banner.classList.add("hidden");
  ensureGear().classList.remove("hidden");
}

// The revoke/change control: a quiet cookie button in the corner once a
// choice has been made. Reopens the banner.
function ensureGear() {
  if (gear) return gear;
  gear = document.createElement("button");
  gear.id = "consentSettings";
  gear.className = "consent-settings";
  gear.type = "button";
  gear.textContent = "\u{1F36A}";
  gear.setAttribute("aria-label", "Analytics and cookie settings");
  gear.title = "Analytics settings";
  gear.addEventListener("click", openBanner);
  document.body.appendChild(gear);
  return gear;
}

// Boot: first-timers get the banner; returning visitors get their prior
// choice honored (init() only loads PostHog if they had accepted).
if (getConsent(window.localStorage) === null) {
  openBanner();
} else {
  analytics.init().then(stampRelease);
  ensureGear();
}
