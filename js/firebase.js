// firebase.js — Firebase init + typed helpers for room read/write.
// Firebase JS SDK 10.x, modular, pinned CDN imports (app + database only).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../config.js";
import { roomsRoot } from "./channel.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// The one namespace decision, made once at module load from the URL: beta
// pages (/beta/) get "rooms-beta", production and every file:// dev checkout
// get "rooms" (js/channel.js, beta-deployment-plan §5.2). roomRef() is the
// single choke point every room read/write/subscribe/transaction routes
// through, so this one line hard-isolates the two channels' data — a beta
// that changes room shape can never feed a production phone.
const ROOMS_ROOT = roomsRoot(location.pathname, location.protocol);

export function roomRef(code, path = "") {
  return ref(db, `${ROOMS_ROOT}/${code}${path ? "/" + path : ""}`);
}

export async function readRoom(code) {
  const snap = await get(roomRef(code));
  return snap.exists() ? snap.val() : null;
}

export function writeRoom(code, state) {
  return set(roomRef(code), state);
}

// Multi-path update relative to the room root, e.g.
// updateRoom("KWPF", { phase: "reveal", "round/score": 4200 })
export function updateRoom(code, patch) {
  return update(roomRef(code), patch);
}

export function deleteRoom(code) {
  return remove(roomRef(code));
}

// Subscribe to full room state. Returns an unsubscribe function.
export function subscribeRoom(code, callback) {
  return onValue(roomRef(code), (snap) => {
    callback(snap.exists() ? snap.val() : null);
  });
}

// Head-to-head: atomically claim a free team slot. The transaction only
// commits if the slot is still empty, so two phones racing for t2 can't
// both land on it — the loser retries on the next free slot.
export async function claimTeamSlot(code, teamId, team) {
  const res = await runTransaction(roomRef(code, `teams/${teamId}`), (cur) => {
    if (cur !== null) return undefined; // taken — abort
    return team;
  });
  return res.committed;
}

// Screen presence: the ONLY thing the screen ever writes (spec §1, §14.10).
export function writeScreenHeartbeat(code) {
  return set(roomRef(code, "screenHeartbeat"), Date.now());
}

// Host-side watch on the one field the screen owns.
export function subscribeHeartbeat(code, callback) {
  return onValue(roomRef(code, "screenHeartbeat"), (snap) => {
    callback(snap.exists() ? snap.val() : null);
  });
}

// Connection status via the SDK's special path; drives the "reconnecting"
// pill on both views (spec §12). Returns an unsubscribe function.
export function onConnectionChange(callback) {
  return onValue(ref(db, ".info/connected"), (snap) => {
    callback(snap.val() === true);
  });
}
