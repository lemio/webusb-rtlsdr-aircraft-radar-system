// Tests for error correction, in particular soft-decision decoding (SDD).
//
// Run from the repository root with:  node --test
//
// 1. Synthetic signals with a known number of weakly received wrong bits.
// 2. Replays of real signals exported from the app ("Export messages" or
//    "Export buffer" in the signal panel) placed in tests/fixtures/. A replay
//    checks that messages which decoded cleanly still decode identically, and
//    reports how repairs changed compared to the decoder that exported them —
//    so the decoder can be improved against real recordings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { Demodulator } from "../demodulator.js";

const MESSAGES = {
  identification: "8d4840d6202cc371c32ce0576098",
  position: "8d40621d58c382d690c8ac2863a7",
  velocity: "8d485020994409940838175b284f",
};

const hexBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bitOf = (bytes, b) => (bytes[b >> 3] >> (7 - (b % 8))) & 1;
// A message's content: everything but the 24 parity bits (3 bytes, 6 hex digits).
const content = (hex) => hex.slice(0, -6);

// Mode S parity (CRC-24, generator 0xfff409) over the data bits.
function parity(bytes, dataBits) {
  let r = 0;
  for (let i = 0; i < dataBits + 24; i++) {
    r = (r << 1) | (i < dataBits ? bitOf(bytes, i) : 0);
    if (r & 0x1000000) r ^= 0x1fff409;
  }
  return r;
}

// A DF11 all-call reply from `icao` to a radar with `interrogatorCode`.
function allCallReply(icao, interrogatorCode) {
  const bytes = hexBytes(`5d${icao}000000`);
  const p = parity(bytes, 32) ^ interrogatorCode;
  bytes.set([p >> 16, (p >> 8) & 0xff, p & 0xff], 4);
  return toHex(bytes);
}

// Deterministic noise.
function random(seed) {
  let state = seed;
  const next = () => (state = (state * 16807) % 2147483647) / 2147483647;
  return () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
}

// A buffer of interleaved uint8 I/Q samples with one message at `offset`.
// `weakWrongBits` are received in the wrong half, only slightly stronger than
// the right half, the way a weak or interfered bit arrives.
function synthesize(hex, { amplitude = 50, noise = 2, weakWrongBits = [], strongWrongBits = [], seed = 1 } = {}) {
  const samples = 1000;
  const offset = 100;
  const bytes = hexBytes(hex);
  const amp = new Float32Array(samples);
  for (const p of [0, 2, 7, 9]) amp[offset + p] = amplitude;
  for (let b = 0; b < bytes.length * 8; b++) {
    const first = offset + 16 + b * 2;
    const [right, wrong] = bitOf(bytes, b) ? [first, first + 1] : [first + 1, first];
    if (weakWrongBits.includes(b)) {
      amp[right] = amplitude * 0.2;
      amp[wrong] = amplitude * 0.32;
    } else if (strongWrongBits.includes(b)) {
      amp[wrong] = amplitude;
    } else {
      amp[right] = amplitude;
    }
  }
  const gauss = random(seed);
  const data = new Uint8Array(samples * 2);
  let phase = 0;
  for (let s = 0; s < samples; s++) {
    phase += 0.35;
    data[s * 2] = clamp(127.5 + amp[s] * Math.cos(phase) + gauss() * noise);
    data[s * 2 + 1] = clamp(127.5 + amp[s] * Math.sin(phase) + gauss() * noise);
  }
  return data;
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

function decode(demodulator, data) {
  const valid = [];
  const corrupt = [];
  demodulator.process(data, data.length, (mm) => valid.push(mm), (mm) => corrupt.push(mm));
  return { valid, corrupt };
}

// --- Synthetic ----------------------------------------------------------------

test("a clean message decodes without repair", () => {
  const { valid } = decode(new Demodulator(), synthesize(MESSAGES.position));
  assert.equal(valid.length, 1);
  assert.equal(toHex(valid[0].msg), MESSAGES.position);
  assert.equal(valid[0].fixMethod, null);
});

test("one wrong bit is repaired by the checksum alone", () => {
  const { valid } = decode(new Demodulator(), synthesize(MESSAGES.position, { strongWrongBits: [60] }));
  assert.equal(valid.length, 1);
  assert.equal(toHex(valid[0].msg), MESSAGES.position);
  assert.equal(valid[0].fixMethod, "crc");
  assert.deepEqual(valid[0].fixedBits, [60]);
});

for (const wrong of [[47, 83]]) {
  test(`${wrong.length} weak wrong bits are repaired by SDD`, () => {
    const { valid } = decode(new Demodulator(), synthesize(MESSAGES.identification, { weakWrongBits: wrong }));
    assert.equal(valid.length, 1);
    assert.equal(toHex(valid[0].msg), MESSAGES.identification);
    assert.equal(valid[0].fixMethod, "sdd");
    assert.deepEqual(valid[0].fixedBits, wrong);
  });
}

for (const wrong of [[20, 47, 83], [20, 47, 60, 83], [20, 33, 47, 60, 83]]) {
  test(`${wrong.length} weak wrong bits: SDD only repairs an aircraft already seen`, () => {
    const demodulator = new Demodulator();
    const unknown = decode(demodulator, synthesize(MESSAGES.velocity, { weakWrongBits: wrong }));
    assert.equal(unknown.valid.length, 0, "not repaired for an unknown aircraft");
    assert.equal(unknown.corrupt.length, 1);

    decode(demodulator, synthesize(MESSAGES.velocity, { seed: 2 })); // Seen with a clean checksum.
    const known = decode(demodulator, synthesize(MESSAGES.velocity, { weakWrongBits: wrong, seed: 3 }));
    assert.equal(known.valid.length, 1, "repaired once the aircraft is known");
    assert.equal(toHex(known.valid[0].msg), MESSAGES.velocity);
    assert.equal(known.valid[0].fixMethod, "sdd");
    assert.deepEqual(known.valid[0].fixedBits, wrong);
  });
}

test("an all-call reply carrying a radar's interrogator code is valid once the aircraft is confirmed", () => {
  const hex = allCallReply("4840d6", 76);
  const demodulator = new Demodulator();
  assert.equal(decode(demodulator, synthesize(hex)).valid.length, 0, "a first reply from an unknown aircraft is not accepted");

  // A second reply from the same address confirms it (as would a clean message).
  const { valid } = decode(demodulator, synthesize(hex, { seed: 3 }));
  assert.equal(valid.length, 1);
  assert.equal(valid[0].msgtype, 11);
  assert.equal(valid[0].icao, 0x4840d6);
  assert.equal(valid[0].interrogatorCode, 76);
  assert.equal(valid[0].fixMethod, null);
});

test("a damaged all-call reply is only repaired for an aircraft already seen", () => {
  const hex = allCallReply("4840d6", 38);
  const demodulator = new Demodulator();
  const unknown = decode(demodulator, synthesize(hex, { strongWrongBits: [20] }));
  assert.equal(unknown.valid.length, 0, "not repaired for an unknown aircraft");

  decode(demodulator, synthesize(MESSAGES.identification, { seed: 2 })); // 4840d6 seen with a clean checksum.
  const known = decode(demodulator, synthesize(hex, { strongWrongBits: [20], seed: 3 }));
  assert.equal(known.valid.length, 1, "repaired once the aircraft is known");
  assert.equal(known.valid[0].icao, 0x4840d6);
  assert.equal(known.valid[0].interrogatorCode, 38);
  assert.deepEqual(known.valid[0].fixedBits, [20]);
});

test("pure noise never produces messages", () => {
  const demodulator = new Demodulator();
  decode(demodulator, synthesize(MESSAGES.position)); // Make an aircraft known, the harder case.
  let messages = 0;
  for (let run = 0; run < 40; run++) {
    const gauss = random(1000 + run);
    const data = new Uint8Array(128000 * 2);
    const noise = 4 + (run % 4) * 6;
    for (let i = 0; i < data.length; i++) data[i] = clamp(127.5 + gauss() * noise);
    messages += decode(demodulator, data).valid.length;
  }
  assert.equal(messages, 0);
});

// --- Replays of exported recordings ------------------------------------------

const fixtures = new URL("./fixtures/", import.meta.url);
const files = existsSync(fixtures) ? readdirSync(fixtures).filter((f) => f.endsWith(".json")) : [];

const SNIPPET_SAMPLES = 320; // Snippets are padded to one size (the demodulator keeps its buffer).

for (const file of files) {
  const recording = JSON.parse(readFileSync(new URL(file, fixtures), "utf8"));

  test(`replay ${file}`, (t) => {
    // One demodulator for the whole recording, in order, so aircraft seen
    // earlier count as known, as in the app.
    const demodulator = new Demodulator();
    const entries = recording.format.endsWith("iq-buffer")
      ? replayBuffer(demodulator, recording)
      : replayMessages(demodulator, recording);

    const summary = { clean: 0, stillRepaired: 0, newlyRepaired: 0, lostRepair: 0, stillCorrupt: 0, changed: 0 };
    for (const { before, after } of entries) {
      const beforeValid = before.crcOk;
      if (beforeValid && !before.fixMethod) {
        summary.clean++;
        assert.ok(after?.crcOk, `clean message ${before.hex} no longer decodes`);
        assert.equal(content(toHex(after.msg)), content(before.hex), "clean message decodes differently");
      } else if (beforeValid) {
        if (!after?.crcOk) summary.lostRepair++;
        else if (content(toHex(after.msg)) !== content(before.hex)) summary.changed++;
        else summary.stillRepaired++;
      } else if (after?.crcOk) {
        summary.newlyRepaired++;
      } else {
        summary.stillCorrupt++;
      }
    }
    t.diagnostic(`${entries.length} messages: ${JSON.stringify(summary)}`);
    assert.equal(summary.changed, 0, "a repaired message now decodes to different content");
  });
}

function replayMessages(demodulator, recording) {
  return recording.messages.map((message) => {
    const samples = Buffer.from(message.samples, "base64");
    const data = new Uint8Array(SNIPPET_SAMPLES * 2).fill(127);
    data.set(samples.subarray(0, data.length));
    const offset = message.sampleOffset - message.snippetStart;
    const { valid, corrupt } = decode(demodulator, data);
    const after = [...valid, ...corrupt].find((mm) => mm.sampleOffset === offset);
    return { before: message.decoded, after };
  });
}

function replayBuffer(demodulator, recording) {
  const data = new Uint8Array(Buffer.from(recording.samples, "base64"));
  const { valid, corrupt } = decode(demodulator, data);
  return recording.messages.map((message) => ({
    before: message.decoded,
    after: [...valid, ...corrupt].find((mm) => mm.sampleOffset === message.sampleOffset),
  }));
}
