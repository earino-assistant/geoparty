// report-ui.js — "Image not working? Report it" (field-observability plan
// §10), reconciled with docs/ui-ux-design-review.md.
//
// PM decision on the plan conflict: the pano is the product's cleanest
// screen and gets NO permanent chrome. Reportability is preserved three
// ways instead, none of which add a resident element to a healthy round:
//
//   1. REACTIVE — when an imagery failure/slow/degraded condition is
//      actually detected, the page's existing toast gains one inline
//      "Report" action for the life of that toast. No new surface, no
//      stacking: the toast was already going to appear.
//   2. CALM STATE — the 🍪 analytics/diagnostics settings surface (the
//      reopened consent banner) carries a quiet "Report an image problem"
//      link. This is the path for `gesture_blocked`, the one class with no
//      automatic signal: the viewer renders, so no toast ever fires.
//   3. AUTOMATIC — classified failures are already reported by the wrapper
//      with no user action at all, behind analytics consent.
//
// Users who declined (or have not chosen) get the explicit one-time
// diagnostic consent dialog of §10.4 before anything is sent, and their
// stored "no" is never altered.

import {
  sendDiagnosticReport,
  analyticsConsentState,
  posthogSessionId,
} from "./consent.js";
import { CONSENT_ACCEPTED, makeImageryError } from "./analytics.js";
import { buildReportBundle, makeRefCode } from "./imagery.js";
import { imagerySession, noteReportSent } from "./viewer-ui.js";

let refCounter = 0;
let sheet = null;

/* ================================================================
 * 1. Reactive: an inline action inside the page's existing toast
 * ================================================================ */

// Renders `message` into an existing toast element and appends one inline
// Report action. Returns the element so the caller's show/hide timer is
// untouched.
export function toastWithReport(el, message, ctx) {
  if (!el) return el;
  el.textContent = "";
  el.classList.add("has-action");
  const text = document.createElement("span");
  text.textContent = message;
  const action = document.createElement("button");
  action.type = "button";
  action.className = "toast-action";
  action.textContent = "Report";
  action.addEventListener("click", (e) => {
    e.preventDefault();
    el.classList.remove("show");
    openReportSheet(ctx);
  });
  el.append(text, action);
  return el;
}

// Plain-text reset, so the next ordinary toast on the page is unaffected.
export function toastPlain(el, message) {
  if (!el) return el;
  el.classList.remove("has-action");
  el.textContent = message;
  return el;
}

/* ================================================================
 * 2. The sheet
 * ================================================================ */

const COPY = {
  consented: {
    title: "Report an image problem",
    body: "This sends an anonymous snapshot of what went wrong — what " +
      "failed to load, how long it took, and your browser type. Never your " +
      "location, guesses, or names.",
    send: "Send report",
    cancel: "No thanks",
  },
  oneTime: {
    title: "Send one report about this image?",
    body: "You said no to sharing play stats — we’ve respected that and collected " +
      "nothing. To fix this image problem we’d need to send one anonymous " +
      "report: what failed, timings, and your browser type. Never your " +
      "location, guesses, or names. This is one report, not ongoing " +
      "tracking — your “no” stays in place.",
    send: "Send one report",
    cancel: "No thanks",
  },
  failed: "Couldn’t send the report — you may be offline or blocking " +
    "analytics. Nothing left your phone.",
};

function ensureSheet() {
  if (sheet) return sheet;
  sheet = document.createElement("div");
  sheet.id = "reportSheet";
  sheet.className = "report-sheet hidden";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Report an image problem");

  const card = document.createElement("div");
  card.className = "report-card";
  const h = document.createElement("h3");
  h.className = "report-title";
  const p = document.createElement("p");
  p.className = "report-body";
  const actions = document.createElement("div");
  actions.className = "report-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "report-cancel";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "btn-primary report-send";
  actions.append(cancel, send);
  card.append(h, p, actions);
  sheet.append(card);
  document.body.appendChild(sheet);
  return sheet;
}

function closeSheet() {
  if (sheet) sheet.classList.add("hidden");
}

// The only entry point. `ctx` is { surface } — everything else is read from
// the session's own instrumentation, so no caller can pass free text in.
export function openReportSheet(ctx) {
  const el = ensureSheet();
  const oneTime = analyticsConsentState() !== CONSENT_ACCEPTED;
  const copy = oneTime ? COPY.oneTime : COPY.consented;

  el.querySelector(".report-title").textContent = copy.title;
  el.querySelector(".report-body").textContent = copy.body;
  const cancel = el.querySelector(".report-cancel");
  const send = el.querySelector(".report-send");
  cancel.textContent = copy.cancel;
  send.textContent = copy.send;
  send.disabled = false;

  // Replace listeners wholesale (cloneNode drops old ones) so reopening the
  // sheet can never double-send.
  const freshCancel = cancel.cloneNode(true);
  const freshSend = send.cloneNode(true);
  cancel.replaceWith(freshCancel);
  send.replaceWith(freshSend);

  freshCancel.addEventListener("click", closeSheet);
  freshSend.addEventListener("click", () => {
    freshSend.disabled = true;
    submitReport(ctx, oneTime).then((refCode) => {
      const body = el.querySelector(".report-body");
      const title = el.querySelector(".report-title");
      if (refCode) {
        title.textContent = "Thanks — sent.";
        body.textContent =
          `Your reference code is ${refCode}. Mention it if you get in touch on GitHub.`;
      } else {
        title.textContent = "Not sent";
        body.textContent = COPY.failed;
      }
      freshSend.classList.add("hidden");
      freshCancel.textContent = "Close";
    });
  });

  el.classList.remove("hidden");
}

function submitReport(ctx, oneTime) {
  const session = imagerySession();
  refCounter += 1;
  const seed = posthogSessionId() || `local-${Date.now()}`;
  const refCode = makeRefCode(seed, refCounter);
  const props = buildReportBundle({
    surface: (ctx && ctx.surface) || "unknown",
    ref_code: refCode,
    failures: session.log.failures(),
    net_type: session.netType,
    online: session.online,
    consent: oneTime ? "one_time" : "analytics",
  });
  noteReportSent();

  return sendDiagnosticReport({
    event: "imagery_report",
    props,
    // The exception is what makes the report findable in the issue stream
    // and (from Stage 2 on) what fires the replay trigger for sessions with
    // no prior $exception.
    error: makeImageryError("reported_by_user", props.error_class),
    errorProps: {
      surface: props.surface,
      error_class: props.error_class,
      pool_entry: props.pool_entry,
      net_type: props.net_type,
      online: props.online,
      ref_code: refCode,
    },
  }).then((ok) => (ok ? refCode : null));
}

/* ================================================================
 * 3. Calm state: the 🍪 diagnostics settings surface links here.
 *    consent.js dynamically imports this module on click, so there is no
 *    import cycle and no cost on pages nobody reports from.
 * ================================================================ */

export function openReportFromSettings(surface) {
  openReportSheet({ surface: surface || "unknown" });
}
