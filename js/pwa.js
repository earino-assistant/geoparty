// pwa.js — pure PWA-launch detection (S5). No DOM, no network: the browser
// facts (matchMedia, navigator.standalone) are injected, so this is unit-
// testable like game.js. The glue in landing-ui.js uses it to fire the
// pwa_launch event — home-screen presence is the retention surface for a
// no-account game, and this is how installs show up in the numbers.

// True when the page is running as an installed app rather than a browser
// tab. Checks the CSS display-mode the OS actually granted (our manifest
// asks for "standalone", but a platform may honor it as fullscreen or
// minimal-ui) plus iOS Safari's legacy navigator.standalone flag.
export const APP_DISPLAY_MODES = Object.freeze([
  "standalone",
  "fullscreen",
  "minimal-ui",
]);

export function isStandaloneDisplay({ matchMedia, navigatorStandalone } = {}) {
  if (navigatorStandalone === true) return true;
  if (typeof matchMedia !== "function") return false;
  for (const mode of APP_DISPLAY_MODES) {
    let m = null;
    try { m = matchMedia(`(display-mode: ${mode})`); } catch { continue; }
    if (m && m.matches === true) return true;
  }
  return false;
}
