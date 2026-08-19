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

// Load posthog-js directly (no inline snippet) and init with the verbatim
// owner-provided key/options passed down from analytics.js. Called at most
// once, and never before the user accepts.
function loadPosthogScript(projectKey, initOptions) {
  return new Promise((resolve, reject) => {
    if (window.posthog && window.posthog.__loaded) {
      resolve(window.posthog);
      return;
    }
    const s = document.createElement("script");
    s.src = POSTHOG_SCRIPT_URL;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = () => {
      try {
        window.posthog.init(projectKey, initOptions);
        resolve(window.posthog);
      } catch (e) {
        reject(e);
      }
    };
    s.onerror = () => reject(new Error("PostHog script failed to load"));
    document.head.appendChild(s);
  });
}

const analytics = createAnalytics({
  storage: window.localStorage,
  loadPosthog: loadPosthogScript,
});

// The one function feature code calls. Safe anywhere: without consent (or
// with a bad event/props shape) it's a validated no-op.
export const track = (event, props) => analytics.track(event, props);

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
    "never your map guesses, names, or anything about you. ",
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
  banner.append(text, actions);

  accept.addEventListener("click", () => {
    analytics.accept();
    closeBanner();
  });
  decline.addEventListener("click", () => {
    analytics.decline();
    closeBanner();
  });

  document.body.appendChild(banner);
  return banner;
}

function openBanner() {
  const el = ensureBanner();
  const status = el.querySelector(".consent-status");
  const consent = getConsent(window.localStorage);
  status.textContent = consent
    ? ` Currently: ${consent === CONSENT_ACCEPTED ? "on" : "off"}.`
    : "";
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
  analytics.init();
  ensureGear();
}
