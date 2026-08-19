// Tests for js/qr.js — the inlined QR encoder that puts the join/screen
// URL on the lobby screens. Structural checks against the QR spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { qrEncode, drawQr } from "../js/qr.js";

test("qrEncode: version 1 for short text (21×21), square 0/1 matrix", () => {
  const m = qrEncode("ABC");
  assert.equal(m.length, 21);
  for (const row of m) {
    assert.equal(row.length, 21);
    for (const v of row) assert.ok(v === 0 || v === 1);
  }
});

test("qrEncode: version scales with payload length", () => {
  // Data capacity at EC L minus the 2 header bytes: v1=17, v2=32, v5=106.
  assert.equal(qrEncode("x".repeat(17)).length, 21);
  assert.equal(qrEncode("x".repeat(18)).length, 25);
  assert.equal(qrEncode("x".repeat(106)).length, 37);
});

test("qrEncode: null when the text exceeds version 5", () => {
  assert.equal(qrEncode("x".repeat(107)), null);
});

test("qrEncode: deterministic", () => {
  const url = "https://example.github.io/geoparty/screen.html?room=KWPFRT";
  assert.deepEqual(qrEncode(url), qrEncode(url));
});

test("qrEncode: finder patterns stamped in all three corners", () => {
  const m = qrEncode("https://example.com/?room=KWPFRT");
  const size = m.length;
  const checkFinder = (top, left) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const expected =
          r === 0 || r === 6 || c === 0 || c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
            ? 1 : 0;
        assert.equal(
          m[top + r][left + c], expected,
          `finder mismatch at (${top + r},${left + c})`
        );
      }
    }
  };
  checkFinder(0, 0);
  checkFinder(size - 7, 0);
  checkFinder(0, size - 7);
});

test("qrEncode: timing patterns alternate; dark module present", () => {
  const m = qrEncode("GEOPARTY");
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, `row timing at ${i}`);
    assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, `col timing at ${i}`);
  }
  assert.equal(m[size - 8][8], 1); // the fixed dark module
});

test("drawQr: paints on a canvas-like surface; hides when text is too long", () => {
  let fills = 0;
  const makeStubCanvas = () => ({
    width: 0,
    height: 0,
    style: {},
    getContext: () => ({
      fillStyle: "",
      fillRect: () => { fills++; },
    }),
  });

  const canvas = makeStubCanvas();
  drawQr(canvas, "https://example.com/?room=KWPFRT");
  assert.ok(canvas.width > 0 && canvas.width === canvas.height);
  assert.ok(fills > 1, "expected background + modules to be painted");
  assert.notEqual(canvas.style.display, "none");

  const tooLong = makeStubCanvas();
  drawQr(tooLong, "x".repeat(200));
  assert.equal(tooLong.style.display, "none");
});
