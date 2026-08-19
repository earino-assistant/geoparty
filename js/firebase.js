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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "../config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export function roomRef(code, path = "") {
  return ref(db, `rooms/${code}${path ? "/" + path : ""}`);
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
