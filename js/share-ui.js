// share-ui.js — browser glue for the S1 share artifact and the Add a TV
// link, shared by the couch host and the h2h phones (the artifact also by
// the Daily Challenge). Same ladder everywhere: Web Share sheet where the
// platform has one, clipboard otherwise, and as a last resort the text
// lands in the toast so it can be copied by hand. The card text is built by
// share.js and the TV link by tvlink.js (both pure, tested).

import { track } from "./consent.js";
import { shareToastText } from "./share.js";

// text: the finished card (link included). mode: "couch" | "h2h" | "daily"
// — rides on the result_shared event. toast: the calling page's toast fn.
// extra: optional aggregate props merged onto result_shared (G5 passes
// { challenge: true } when the card carries a ghost duel link, §7.1).
export async function shareResult(text, mode, toast, extra) {
  const props = { mode, ...(extra || {}) };
  if (navigator.share) {
    try {
      await navigator.share({ text });
      track("result_shared", { ...props, method: "share" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user closed the sheet
      // Share sheet unavailable/failed: fall through to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(shareToastText(extra));
    track("result_shared", { ...props, method: "copy" });
  } catch {
    toast(text); // clipboard blocked: at least show what to send
  }
}

// The lobby "Send the TV link" affordance (both modes). url is the screen
// link built by tvlink.screenLink(..., "link") so the arrival is attributed
// on screen_joined; code rides in the share text as the human anchor.
export async function shareTvLink(url, code, mode, toast) {
  if (navigator.share) {
    try {
      await navigator.share({
        title: "GeoParty",
        text: `Put GeoParty on the TV — room ${code}`,
        url,
      });
      track("tv_link_shared", { mode, method: "share" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user closed the sheet
      // Share sheet unavailable/failed: fall through to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("TV link copied — open it on any screen 📺");
    track("tv_link_shared", { mode, method: "copy" });
  } catch {
    toast(`Open this on the TV: ${url}`);
  }
}
