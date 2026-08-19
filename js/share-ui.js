// share-ui.js — browser glue for the S1 share artifact, shared by the couch
// host, the h2h phones, and the Daily Challenge. Same ladder as the h2h
// invite: Web Share sheet where the platform has one, clipboard otherwise,
// and as a last resort the text lands in the toast so it can be copied by
// hand. The card text itself is built by share.js (pure, tested).

import { track } from "./consent.js";

// text: the finished card (link included). mode: "couch" | "h2h" | "daily"
// — rides on the result_shared event. toast: the calling page's toast fn.
export async function shareResult(text, mode, toast) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      track("result_shared", { mode, method: "share" });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user closed the sheet
      // Share sheet unavailable/failed: fall through to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Result copied — paste it anywhere 📋");
    track("result_shared", { mode, method: "copy" });
  } catch {
    toast(text); // clipboard blocked: at least show what to send
  }
}
