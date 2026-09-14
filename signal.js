"use strict";

// Visualises the raw I/Q samples from the SDR and how Mode S messages are
// read from them, following Bret Victor's "Learnable Programming":
//
// - make meaning visible: every part of a message is labelled (DF, ICAO,
//   ALT, …) and explains itself on hover, with its bits and decoded value;
// - show the flow: bytes → bits → the two samples each bit is decided from
//   (the stronger one is drawn bright), and the expected preamble pulses;
// - connect representations: hovering a bit, byte or field highlights it
//   here, in the raw hex, and its decoded value in the message table.
//
// Views: an overview of the whole buffer with all messages marked, a detail
// of one message at a fixed scale, and its samples in the I/Q plane. The view
// freezes while the pointer is over it.

import { describeType } from "./messages.js";
import { SOFT_CANDIDATES, SOFT_MAX_FLIPS, SOFT_UNGATED_FLIPS } from "./decoder.js";

const SAMPLE_RATE = 2_000_000; // Samples per second (0.5 µs per sample).
const PREAMBLE_SAMPLES = 16; // 8 µs.
const PREAMBLE_PULSES = [0, 2, 7, 9]; // Samples with energy: 0, 1, 3.5, 4.5 µs.
const CONTEXT_SAMPLES = 16; // Shown before and after a message.
const PX_PER_SAMPLE = 4; // Fixed scale: one bit is 8 px, one byte 64 px.
const DETAIL_SAMPLES = CONTEXT_SAMPLES * 2 + PREAMBLE_SAMPLES + 112 * 2; // Fits a long message.
const MAX_BUFFERS = 32; // Recent buffers kept for the overview (~2 s).
const MAX_HISTORY = 2000; // Recent message snippets kept for export (~1 MB).
const RECORD_SECONDS = 10; // Raw I/Q recording length (4 MB per second).
const CENTER_FREQUENCY = 1_090_000_000;

const SDD_EXPLANATION =
  "<b>SDD · soft-decision decoding</b><br>" +
  "Each bit is decided by comparing its two halves; the closer they are relative to their strength, the less certain the bit (a taller bar here).<br>" +
  "When the checksum fails and no single-bit CRC fix exists, SDD tries flipping combinations of the " +
  `${SOFT_CANDIDATES} least certain bits (<span class="signal-candidate">amber</span>), up to ${SOFT_MAX_FLIPS} at once, ` +
  'and keeps the smallest combination that makes the checksum match (<span class="signal-corrupt">red</span>).<br>' +
  `Repairs of more than ${SOFT_UNGATED_FLIPS} bits are only accepted when they are unambiguous and give the address of an aircraft recently received with a clean checksum.`;

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// What the decoder made of a message, for exported files.
function describeDecoded(mm) {
  return {
    df: mm.msgtype,
    icao: mm.icao.toString(16).padStart(6, "0"),
    bits: mm.msg.length * 8,
    hex: [...mm.msg].map((b) => b.toString(16).padStart(2, "0")).join(""),
    crcOk: mm.crcOk,
    fixMethod: mm.fixMethod ?? null,
    fixedBits: mm.fixedBits ?? null,
    sddCandidates: mm.sddCandidates ?? null,
    bitCertainty: mm.bitCertainty ?? null,
  };
}

function download(name, object) {
  downloadBlob(name, new Blob([JSON.stringify(object)], { type: "application/json" }));
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const CPR_MAX = 131072;
const CHARSET = "?ABCDEFGHIJKLMNOPQRSTUVWXYZ????? ???????????????0123456789??????";

// Vertical layout of the detail view (top, height) in px.
const LANES = {
  hex: [0, 14],
  bits: [15, 10],
  fields: [28, 16],
  magnitude: [48, 104],
  iq: [158, 56],
  uncertainty: [220, 34],
};
const DETAIL_HEIGHT = 256;
const LEGEND_WIDTH = 110; // Room right of the message for lane legends.

const COLORS = {
  ink: "#e8e8e8",
  muted: "#8a8f96",
  faint: "#4a4e55",
  rule: "rgba(255, 255, 255, 0.18)",
  envelope: "rgba(232, 232, 232, 0.55)",
  marker: "rgba(255, 255, 255, 0.22)",
  highlight: "#ffe14d",
  highlightBand: "rgba(255, 225, 77, 0.13)",
  corrupt: "#ff5c5c",
  candidate: "#e0a84a",
  i: "#6ab0ff",
  q: "#ffb35c",
};

const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

const hexOf = (mm) => mm.icao.toString(16).padStart(6, "0");

function bitAt(mm, b) {
  return (mm.msg[b >> 3] >> (7 - (b % 8))) & 1;
}

function bitString(mm, from, to) {
  let s = "";
  for (let b = from; b < to; b++) s += bitAt(mm, b);
  return s;
}

const uint = (mm, from, to) => parseInt(bitString(mm, from, to), 2);

function parityText(mm) {
  if (!mm.crcOk) return "does not match: corrupt (no single-bit CRC fix, and SDD found no repair among the least certain bits)";
  const fixed = mm.fixedBits;
  const code = mm.interrogatorCode ? ` with interrogator code ${mm.interrogatorCode} (the radar that asked is encoded in the low 7 bits)` : "";
  if (!fixed?.length) return `matches the message${code}`;
  const positions = fixed.map((b) => b + 1).join(", ");
  if (mm.fixMethod === "sdd") return `matched${code} after soft-decision decoding flipped bits ${positions} (see the uncertainty lane)`;
  return `matched${code} after the checksum pinpointed bit${fixed.length > 1 ? "s" : ""} ${positions}`;
}

// The parts of a message: bit ranges (0-based, end exclusive), what they
// mean, their decoded value, and which table columns show that meaning.
function messageFields(mm) {
  const df = mm.msgtype;
  const bits = mm.msg.length * 8;
  const [abbreviation, explanation] = describeType(mm);
  const fields = [];
  const add = (name, from, to, label, value = "", columns = []) =>
    fields.push({ name, from, to, label, value, columns });

  add("DF", 0, 5, "Downlink format", `${df}: ${explanation}`, ["type"]);

  if (df === 17 || df === 18) {
    add("CA", 5, 8, "Capability", String(uint(mm, 5, 8)));
    add("ICAO", 8, 32, "Aircraft address", hexOf(mm), ["icao"]);
    const tc = uint(mm, 32, 37);
    add("TC", 32, 37, "Type code", `${tc}: ${abbreviation}`, ["type"]);

    if (tc >= 1 && tc <= 4) {
      add("CAT", 37, 40, "Aircraft category", String(uint(mm, 37, 40)));
      for (let k = 0; k < 8; k++) {
        const from = 40 + 6 * k;
        const code = uint(mm, from, from + 6);
        const char = CHARSET[code];
        add(char === " " ? "␣" : char, from, from + 6, `Callsign character ${k + 1}`, `${code} → “${char}”`, ["flight"]);
      }
    } else if ((tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22)) {
      add("SS", 37, 39, "Surveillance status", String(uint(mm, 37, 39)));
      add("SAF", 39, 40, "Single antenna flag", String(uint(mm, 39, 40)));
      add("ALT", 40, 52, "Altitude",
        mm.altitude ? `${mm.altitude.toLocaleString("en-US")} ft (bit 48 is the Q bit: 25 ft steps, value × 25 − 1000)` : "not available",
        ["alt"]);
      add("T", 52, 53, "UTC synchronised", uint(mm, 52, 53) ? "yes" : "no");
      add("F", 53, 54, "CPR format", uint(mm, 53, 54) ? "odd frame" : "even frame");
      const cpr = (raw, decoded) =>
        `${raw} / 2¹⁷ = ${(raw / CPR_MAX).toFixed(4)} of a zone` +
        (decoded != null ? ` → ${decoded.toFixed(4)}° (combined with another frame or a reference)` : " (needs a second frame or a reference position)");
      add("LAT", 54, 71, "CPR-encoded latitude", cpr(mm.rawLatitude, mm.position?.[1]), ["lat"]);
      add("LON", 71, 88, "CPR-encoded longitude", cpr(mm.rawLongitude, mm.position?.[0]), ["lon"]);
    } else if (tc === 19) {
      const st = uint(mm, 37, 40);
      add("ST", 37, 40, "Velocity subtype",
        `${st}${st === 1 || st === 2 ? ": ground speed" : st === 3 || st === 4 ? ": airspeed and heading" : ""}`);
      add("IC", 40, 41, "Intent change", uint(mm, 40, 41) ? "yes" : "no");
      add("IFR", 41, 42, "IFR capability", String(uint(mm, 41, 42)));
      add("NUC", 42, 45, "Velocity uncertainty category", String(uint(mm, 42, 45)));
      if (st === 1 || st === 2) {
        const ew = uint(mm, 46, 56);
        const ns = uint(mm, 57, 67);
        const vr = uint(mm, 69, 78);
        add("W", 45, 46, "East/west direction", uint(mm, 45, 46) ? "flying west" : "flying east", ["trk"]);
        add("Vew", 46, 56, "East/west speed", ew ? `${ew} − 1 = ${ew - 1} kt` : "not available", ["gs", "trk"]);
        add("S", 56, 57, "North/south direction", uint(mm, 56, 57) ? "flying south" : "flying north", ["trk"]);
        add("Vns", 57, 67, "North/south speed",
          ns ? `${ns} − 1 = ${ns - 1} kt (ground speed = √(Vew² + Vns²))` : "not available", ["gs", "trk"]);
        add("Src", 67, 68, "Vertical rate source", uint(mm, 67, 68) ? "barometric" : "GNSS");
        add("Sv", 68, 69, "Vertical rate sign", uint(mm, 68, 69) ? "descending" : "climbing", ["vs"]);
        add("VR", 69, 78, "Vertical rate", vr ? `(${vr} − 1) × 64 = ${(vr - 1) * 64} ft/min` : "not available", ["vs"]);
        add("", 78, 80, "Reserved");
        add("Sd", 80, 81, "GNSS − baro altitude sign", uint(mm, 80, 81) ? "below baro" : "above baro");
        add("dAlt", 81, 88, "GNSS − baro altitude difference", String(uint(mm, 81, 88)));
      } else {
        add("ME", 45, 88, "Airspeed and heading data", "", ["trk"]);
      }
    } else {
      add("ME", 37, 88, "Message data");
    }
    add("PI", 88, 112, "Parity (CRC-24)", parityText(mm), ["crc"]);
  } else if (df === 11) {
    add("CA", 5, 8, "Capability", String(uint(mm, 5, 8)));
    add("AA", 8, 32, "Aircraft address", hexOf(mm), ["icao"]);
    add("PI", 32, 56, "Parity with interrogator code", parityText(mm), ["crc"]);
  } else if ([0, 4, 5, 16, 20, 21].includes(df)) {
    if (df === 0 || df === 16) {
      add("VS", 5, 6, "Vertical status", uint(mm, 5, 6) ? "on ground" : "airborne");
      add("", 6, 19, "ACAS fields");
    } else {
      add("FS", 5, 8, "Flight status", String(uint(mm, 5, 8)));
      add("DR", 8, 13, "Downlink request", String(uint(mm, 8, 13)));
      add("UM", 13, 19, "Utility message", String(uint(mm, 13, 19)));
    }
    if (df === 5 || df === 21) {
      add("ID", 19, 32, "Identity (squawk), interleaved octal digits", String(mm.identity).padStart(4, "0"), ["squawk"]);
    } else {
      add("AC", 19, 32, "Altitude code", mm.altitude ? `${mm.altitude.toLocaleString("en-US")} ft` : "not decoded", ["alt"]);
    }
    if (bits === 112) add(df === 16 ? "MV" : "MB", 32, 88, df === 16 ? "ACAS message" : "Comm-B message");
    add("AP", bits - 24, bits, "Address ⊕ parity",
      mm.crcOk ? `parity removed → address ${hexOf(mm)}` : "address not recognised", ["icao"]);
  } else {
    add("DATA", 5, bits - 24, "Message data");
    add("PI", bits - 24, bits, "Parity", parityText(mm), ["crc"]);
  }
  return fields;
}

// Keep the canvas backing store in sync with its CSS size and clear it.
function prepare(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = "10px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textBaseline = "top";
  return { ctx, width, height };
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export class SignalView {
  constructor(container, { onHover, onField, onFreeze, onShow, onLock, onUnlock, onDetector }) {
    this._onHover = onHover; // (message | null) — a message in the overview
    this._onField = onField; // (message | null, columns) — a part of the detailed message
    this._onFreeze = onFreeze; // (frozen)
    this._onShow = onShow; // (message, locked) — the message now shown in the detail view
    this._onLock = onLock; // () — a message was locked (the app pauses)
    this._onUnlock = onUnlock; // () — the lock was released (the app goes live)
    this._locked = null; // Message kept in focus until unlocked.
    this._chunk = null; // { data, messages }
    this._selected = null; // { mm, samples, start, fields }
    this._hoveredMessage = null;
    this._hover = null; // { from, to, bit, byte, field, preamble } in the detail view
    this._frozen = false; // Pointer over the view.
    this._paused = false; // Global pause.
    this._pinned = null; // { chunk, selected } to restore after showing a message from the table.
    this._buffers = []; // Recent { data, messages }.
    this._snapshots = new WeakMap(); // message → { start, samples, buffer }
    this._renderScheduled = false;

    container.classList.add("signal");
    container.innerHTML = `
      <div class="signal-header">
        <span class="signal-title">I/Q signal</span>
        <span class="signal-info"></span>
        <span class="signal-actions">
          <label class="signal-detector" title="Message detection. Hybrid: classic detection plus a tolerant detector for messages that start part-way into a sample (about 20 % more messages on real recordings). Switch to compare messages per second live.">
            Detector
            <select>
              <option value="hybrid">hybrid</option>
              <option value="classic">classic</option>
              <option value="tolerant">tolerant</option>
            </select>
          </label>
          <button class="signal-button" data-record title="Record ${RECORD_SECONDS} s of raw I/Q from the receiver (uint8 I/Q at 2 Msps, like rtl_sdr) — put it in tests/fixtures to test detection against it">Record ${RECORD_SECONDS} s</button>
          <button class="signal-button" data-export="messages" title="Download the samples around the most recent messages (valid, repaired and corrupt) with what the decoder made of them, as JSON for tests">Export messages</button>
          <button class="signal-button" data-export="buffer" title="Download the whole buffer shown in the overview (64 ms of raw I/Q) with its messages, as JSON">Export buffer</button>
        </span>
      </div>
      <div class="signal-body">
        <div class="signal-plots">
          <canvas class="signal-overview"></canvas>
          <div class="signal-detail-title"></div>
          <div class="signal-detail-scroll"><canvas class="signal-detail"></canvas></div>
        </div>
        <div class="signal-side"><canvas class="signal-constellation"></canvas></div>
      </div>
      <div class="signal-tooltip" hidden></div>`;
    this._container = container;
    this._info = container.querySelector(".signal-info");
    this._history = []; // Recent { mm, snapshot }, for export.
    this._sequence = 0; // Buffer counter.
    container.querySelector(".signal-actions").addEventListener("click", (event) => {
      const kind = event.target.closest("[data-export]")?.dataset.export;
      if (kind === "messages") this.exportMessages();
      if (kind === "buffer") this.exportBuffer();
      if (event.target.closest("[data-record]")) this.record();
    });
    this._detectorSelect = container.querySelector(".signal-detector select");
    this._detectorSelect.addEventListener("change", () => onDetector?.(this._detectorSelect.value));
    this._recordButton = container.querySelector("[data-record]");
    this._recording = null; // { chunks, bytes }
    this._overview = container.querySelector(".signal-overview");
    this._detailTitle = container.querySelector(".signal-detail-title");
    this._detail = container.querySelector(".signal-detail");
    this._constellation = container.querySelector(".signal-constellation");
    this._tooltip = container.querySelector(".signal-tooltip");
    this._detail.style.width = `${DETAIL_SAMPLES * PX_PER_SAMPLE + LEGEND_WIDTH}px`;
    this._detail.style.height = `${DETAIL_HEIGHT}px`;

    container.addEventListener("mouseenter", () => {
      this._frozen = true;
      this._onFreeze?.(true);
      this._scheduleRender();
    });
    container.addEventListener("mouseleave", () => {
      this._frozen = false;
      this._onFreeze?.(false);
      this._setHovered(null);
      this._setDetailHover(null);
    });

    this._overview.addEventListener("mousemove", (event) => this._hoverOverview(event));
    this._overview.addEventListener("mouseleave", () => this._setHovered(null));
    // Clicking a message in the overview locks it.
    this._overview.addEventListener("click", () => {
      if (this._hoveredMessage) this.lock(this._hoveredMessage);
    });

    this._detail.addEventListener("mousemove", (event) => this._hoverDetail(event));
    this._detail.addEventListener("mouseleave", () => this._setDetailHover(null));
    this._detailTitle.addEventListener("mouseover", (event) => {
      const byte = event.target.closest("[data-byte]");
      if (byte) this._setDetailHover(this._byteHover(Number(byte.dataset.byte)), event);
    });
    this._detailTitle.addEventListener("mouseleave", () => this._setDetailHover(null));
    // The chevron in front of the shown message locks it, or releases the lock.
    this._detailTitle.addEventListener("click", (event) => {
      if (!event.target.closest(".chevron")) return;
      if (this._locked) this._onUnlock?.();
      else this.lock();
    });

    new ResizeObserver(() => this._scheduleRender()).observe(container);
  }

  // Feed one buffer of interleaved unsigned 8-bit I/Q samples and the
  // messages found in it (valid and corrupt).
  push(data, messages) {
    if (this._recording) this._recordBuffer(data);
    const buffer = { data, messages, sequence: this._sequence++, receivedAt: new Date() };
    // Keep each message's own samples (small), so it can be shown later, e.g.
    // when its row in the table is hovered — even while the view is paused.
    for (const mm of messages) {
      const start = Math.max(0, mm.sampleOffset - CONTEXT_SAMPLES);
      const end = Math.min(data.length / 2, start + DETAIL_SAMPLES);
      const snapshot = { start, samples: data.slice(start * 2, end * 2), buffer };
      this._snapshots.set(mm, snapshot);
      this._history.push({ mm, snapshot });
    }
    if (this._history.length > MAX_HISTORY) this._history.splice(0, this._history.length - MAX_HISTORY);
    this._buffers.push(buffer);
    if (this._buffers.length > MAX_BUFFERS) this._buffers.shift();

    if (this._frozen || this._paused || this._pinned || this._locked) return;
    this._chunk = buffer;
    // The detail view follows the most recent valid message, else any.
    const latest = messages.findLast((mm) => mm.crcOk) ?? messages[messages.length - 1];
    if (latest) this._select(latest);
    this._scheduleRender();
  }

  // --- Export ---------------------------------------------------------------

  // Samples around recent messages, oldest first. Replaying a snippet through
  // the demodulator reproduces the message (see tests/).
  setDetector(detector) {
    this._detectorSelect.value = detector;
  }

  // Record raw I/Q buffers as they arrive (also while paused), then download
  // them as one .bin file.
  record() {
    if (this._recording) return;
    this._recording = { chunks: [], bytes: 0 };
    this._recordButton.disabled = true;
    this._recordButton.textContent = "Recording…";
  }

  _recordBuffer(data) {
    const recording = this._recording;
    recording.chunks.push(data);
    recording.bytes += data.length;
    const seconds = recording.bytes / (SAMPLE_RATE * 2);
    this._recordButton.textContent = `Recording ${seconds.toFixed(1)} s`;
    if (seconds < RECORD_SECONDS) return;
    downloadBlob(`adsb-iq-${timestamp()}-2Msps-1090MHz.bin`, new Blob(recording.chunks, { type: "application/octet-stream" }));
    this._recording = null;
    this._recordButton.disabled = false;
    this._recordButton.textContent = `Record ${RECORD_SECONDS} s`;
  }

  exportMessages() {
    download(`adsb-iq-messages-${timestamp()}.json`, {
      format: "webusb-rtlsdr-adsb/iq-messages",
      version: 1,
      exportedAt: new Date().toISOString(),
      sampleRate: SAMPLE_RATE,
      centerFrequency: CENTER_FREQUENCY,
      sampleFormat: "uint8, interleaved I/Q, zero level 127.5; base64",
      decoder: { softCandidates: SOFT_CANDIDATES, softMaxFlips: SOFT_MAX_FLIPS, softUngatedFlips: SOFT_UNGATED_FLIPS },
      messages: this._history.map(({ mm, snapshot }) => ({
        receivedAt: snapshot.buffer.receivedAt.toISOString(),
        buffer: snapshot.buffer.sequence,
        sampleOffset: mm.sampleOffset, // Message start within its buffer.
        snippetStart: snapshot.start, // Snippet start within its buffer.
        samples: toBase64(snapshot.samples),
        decoded: describeDecoded(mm),
      })),
    });
  }

  // The buffer shown in the overview, whole.
  exportBuffer() {
    const buffer = this._chunk;
    if (!buffer) return;
    download(`adsb-iq-buffer-${timestamp()}.json`, {
      format: "webusb-rtlsdr-adsb/iq-buffer",
      version: 1,
      exportedAt: new Date().toISOString(),
      receivedAt: buffer.receivedAt.toISOString(),
      sampleRate: SAMPLE_RATE,
      centerFrequency: CENTER_FREQUENCY,
      sampleFormat: "uint8, interleaved I/Q, zero level 127.5; base64",
      decoder: { softCandidates: SOFT_CANDIDATES, softMaxFlips: SOFT_MAX_FLIPS, softUngatedFlips: SOFT_UNGATED_FLIPS },
      samples: toBase64(buffer.data),
      messages: buffer.messages.map((mm) => ({ sampleOffset: mm.sampleOffset, decoded: describeDecoded(mm) })),
    });
  }

  // Show a message (e.g. hovered in the table) until called with null.
  showMessage(mm) {
    if (!mm) {
      // Back to what was shown before the preview (the locked message, if any).
      if (this._pinned) {
        ({ chunk: this._chunk, selected: this._selected } = this._pinned);
        this._pinned = null;
        this._hover = null;
        this._notifyShown();
        this._renderTitle();
        this._scheduleRender();
      }
      return;
    }
    const snapshot = this._snapshots.get(mm);
    if (!snapshot) return;
    if (!this._pinned) this._pinned = { chunk: this._chunk, selected: this._selected };
    // Show its whole buffer too, if that is still kept.
    if (this._buffers.includes(snapshot.buffer)) this._chunk = snapshot.buffer;
    this._select(mm);
  }

  // Keep a message (default: the one shown) in focus. The app pauses.
  lock(mm = this._selected?.mm) {
    const snapshot = mm && this._snapshots.get(mm);
    if (!snapshot) return;
    this._locked = mm;
    this._pinned = null; // Leaving a hover preview now returns to this message.
    if (this._buffers.includes(snapshot.buffer)) this._chunk = snapshot.buffer;
    this._select(mm);
    this._onLock?.();
  }

  // Release the lock; live updates resume once the app is unpaused.
  unlock() {
    if (!this._locked) return;
    this._locked = null;
    this._pinned = null;
    this._notifyShown();
    this._renderTitle();
    this._scheduleRender();
  }

  setPaused(paused) {
    this._paused = paused;
    this._scheduleRender();
  }

  _select(mm) {
    const snapshot = this._snapshots.get(mm);
    if (!snapshot) return;
    this._selected = { mm, start: snapshot.start, samples: snapshot.samples, fields: messageFields(mm) };
    this._hover = null;
    this._notifyShown();
    this._renderTitle();
    this._scheduleRender();
  }

  _notifyShown() {
    const mm = this._selected?.mm ?? null;
    this._onShow?.(mm, mm !== null && mm === this._locked);
  }

  _setHovered(mm) {
    if (mm === this._hoveredMessage) return;
    this._hoveredMessage = mm;
    this._overview.style.cursor = mm ? "pointer" : "";
    this._onHover?.(mm);
    this._scheduleRender();
  }

  _hoverOverview(event) {
    if (!this._chunk) return;
    const rect = this._overview.getBoundingClientRect();
    const samples = this._chunk.data.length / 2;
    const x = event.clientX - rect.left;
    let nearest = null;
    let nearestDistance = 6; // px
    for (const mm of this._chunk.messages) {
      const x0 = (mm.sampleOffset / samples) * rect.width;
      const x1 = ((mm.sampleOffset + mm.sampleLength) / samples) * rect.width;
      const distance = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      if (distance <= nearestDistance) {
        nearest = mm;
        nearestDistance = distance;
      }
    }
    this._setHovered(nearest);
  }

  // --- Detail hover: what is under the pointer, and what it means ---------

  _byteHover(byte) {
    const from = byte * 8;
    const to = from + 8;
    const fields = this._selected.fields.filter((f) => f.from < to && f.to > from);
    return { kind: "byte", from, to, byte, fields };
  }

  _hoverDetail(event) {
    const selected = this._selected;
    if (!selected) return;
    const rect = this._detail.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const sample = Math.floor(x / PX_PER_SAMPLE);
    const messageStart = selected.mm.sampleOffset - selected.start;
    const dataStart = messageStart + PREAMBLE_SAMPLES;
    const bitCount = selected.mm.msg.length * 8;

    // The uncertainty lane's label and legend explain SDD.
    const lastBitX = (dataStart + bitCount * 2) * PX_PER_SAMPLE;
    if (y >= LANES.uncertainty[0] && (x < dataStart * PX_PER_SAMPLE || x >= lastBitX)) {
      this._setDetailHover({ kind: "sdd", from: -1, to: -1, fields: [] }, event);
      return;
    }
    if (sample >= messageStart && sample < dataStart) {
      this._setDetailHover({ kind: "preamble", from: -8, to: 0, fields: [] }, event);
      return;
    }
    const bit = Math.floor((sample - dataStart) / 2);
    if (sample < dataStart || bit >= bitCount) {
      this._setDetailHover(null);
      return;
    }
    if (y < LANES.hex[0] + LANES.hex[1]) {
      this._setDetailHover(this._byteHover(bit >> 3), event);
      return;
    }
    const field = selected.fields.find((f) => bit >= f.from && bit < f.to);
    this._setDetailHover({ kind: "bit", bit, from: field?.from ?? bit, to: field?.to ?? bit + 1, fields: field ? [field] : [] }, event);
  }

  _setDetailHover(hover, event) {
    const same = hover && this._hover && hover.kind === this._hover.kind &&
      hover.from === this._hover.from && hover.to === this._hover.to && hover.bit === this._hover.bit;
    if (!same) {
      this._hover = hover;
      const columns = [...new Set((hover?.fields ?? []).flatMap((f) => f.columns))];
      this._onField?.(hover ? this._selected.mm : null, columns);
      this._renderTitle();
      this._scheduleRender();
    }
    this._updateTooltip(event);
  }

  _updateTooltip(event) {
    const hover = this._hover;
    if (!hover || !event) {
      this._tooltip.hidden = true;
      return;
    }
    const { mm, samples } = this._selected;
    const lines = [];
    if (hover.kind === "sdd") {
      lines.push(SDD_EXPLANATION);
    } else if (hover.kind === "preamble") {
      lines.push("<b>Preamble</b> · 8 µs",
        "Pulses at 0, 1, 3.5 and 4.5 µs (the marked samples) announce a message.",
        "The bits follow; each bit is 1 µs = 2 samples.");
    } else {
      if (hover.kind === "byte") {
        const value = mm.msg[hover.byte];
        lines.push(`<b>Byte ${hover.byte + 1}</b> · 0x${value.toString(16).padStart(2, "0")} · <code>${bitString(mm, hover.from, hover.to)}</code>`);
      }
      for (const field of hover.fields) {
        lines.push(`<b>${escapeHtml(field.name || "—")}</b> ${escapeHtml(field.label)} · bits ${field.from + 1}–${field.to}`);
        lines.push(`<code>${bitString(mm, field.from, field.to)}</code>${field.value ? " → " + escapeHtml(field.value) : ""}`);
      }
      if (hover.kind === "bit") {
        // How this bit was decided from its two samples (pulse position).
        const first = this._magnitudeAt(samples, mm.sampleOffset - this._selected.start + PREAMBLE_SAMPLES + hover.bit * 2);
        const second = this._magnitudeAt(samples, mm.sampleOffset - this._selected.start + PREAMBLE_SAMPLES + hover.bit * 2 + 1);
        const flipped = mm.fixedBits?.includes(hover.bit);
        const received = flipped ? 1 - bitAt(mm, hover.bit) : bitAt(mm, hover.bit);
        lines.push(`<span class="signal-muted">Bit ${hover.bit + 1}: first half ${first.toFixed(0)} ${first > second ? ">" : "<"} second half ${second.toFixed(0)} → ${received}` +
          ` · certainty ${Math.round((Math.abs(first - second) / (first + second || 1)) * 100)} %</span>`);
        const candidateRank = mm.sddCandidates?.indexOf(hover.bit) ?? -1;
        if (candidateRank >= 0) {
          lines.push(`<span class="signal-candidate">SDD candidate: the ${ordinal(candidateRank + 1)} least certain bit</span>`);
        }
        if (flipped && mm.fixMethod === "sdd") {
          lines.push(`<span class="signal-corrupt">Flipped to ${bitAt(mm, hover.bit)} by soft-decision decoding: flipping this combination of uncertain bits makes the checksum match.</span>`);
        } else if (flipped) {
          lines.push(`<span class="signal-corrupt">Flipped to ${bitAt(mm, hover.bit)} by checksum error control: the checksum mismatch points at exactly this bit.</span>`);
        }
      }
    }
    this._tooltip.innerHTML = lines.join("<br>");
    this._tooltip.hidden = false;

    const panel = this._container.getBoundingClientRect();
    const tip = this._tooltip.getBoundingClientRect();
    let left = event.clientX - panel.left + 14;
    if (left + tip.width > panel.width - 8) left = event.clientX - panel.left - tip.width - 14;
    const top = Math.max(4, event.clientY - panel.top - tip.height - 12);
    this._tooltip.style.transform = `translate(${Math.max(4, left)}px, ${top}px)`;
  }

  _magnitudeAt(samples, s) {
    if (s < 0 || s * 2 + 1 >= samples.length) return 0;
    return Math.hypot(samples[s * 2] - 127.5, samples[s * 2 + 1] - 127.5);
  }

  // --- Rendering ------------------------------------------------------------

  _scheduleRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      if (document.hidden) return;
      this._renderOverview();
      this._renderDetail();
      this._renderConstellation();
    });
  }

  _renderTitle() {
    const selected = this._selected;
    if (!selected) {
      this._detailTitle.textContent = "Waiting for a message…";
      return;
    }
    const { mm } = selected;
    const [abbreviation, explanation] = describeType(mm);
    const offsetMs = (mm.sampleOffset / SAMPLE_RATE) * 1000;
    const hover = this._hover;
    const bytes = [...mm.msg]
      .map((value, i) => {
        const active = hover && hover.kind !== "preamble" && i * 8 < hover.to && i * 8 + 8 > hover.from;
        return `<span data-byte="${i}"${active ? ' class="active"' : ""}>${value.toString(16).padStart(2, "0")}</span>`;
      })
      .join("");
    const locked = mm === this._locked;
    this._detailTitle.innerHTML =
      `<button class="chevron${locked ? " locked" : ""}" title="${locked ? "Locked · click or press space to go live" : "Lock this message (pauses)"}">›</button>` +
      `<span class="signal-type" title="${escapeHtml(explanation)}">${mm.msgtype} ${abbreviation}</span> ` +
      `${hexOf(mm)} ` +
      (mm.crcOk ? "" : '<span class="signal-corrupt">corrupt </span>') +
      `<span class="signal-muted">at ${offsetMs.toFixed(2)} ms · ${mm.msg.length * 8} bits · </span>` +
      `<span class="signal-bytes">${bytes}</span>`;
  }

  _renderOverview() {
    const { ctx, width, height } = prepare(this._overview);
    if (!this._chunk) return;
    const { data, messages } = this._chunk;
    const samples = data.length / 2;
    const durationMs = (samples / SAMPLE_RATE) * 1000;
    const corrupt = messages.filter((mm) => !mm.crcOk).length;
    this._info.textContent =
      `${(SAMPLE_RATE / 1e6).toFixed(0)} Msps · ${durationMs.toFixed(0)} ms buffer · ` +
      `${messages.length - corrupt} message${messages.length - corrupt === 1 ? "" : "s"}` +
      (corrupt ? ` · ${corrupt} corrupt` : "") +
      (this._locked ? " · locked (space to go live)"
        : this._paused ? " · paused (space to resume)"
        : this._pinned ? " · showing the message hovered in the table"
        : this._frozen ? " · paused while hovering" : "");

    const top = 14; // Room for message labels.
    const axis = 12; // Room for the time axis.
    const plotHeight = height - top - axis;
    const columns = Math.max(1, Math.floor(width));
    const perColumn = samples / columns;

    // Peak magnitude per pixel column, scaled to the buffer's peak.
    const peaks = new Float32Array(columns);
    let bufferPeak = 20;
    for (let x = 0; x < columns; x++) {
      const from = Math.floor(x * perColumn);
      const to = Math.min(samples, Math.floor((x + 1) * perColumn));
      let peak = 0;
      for (let s = from; s < to; s++) {
        const i = data[s * 2] - 127.5;
        const q = data[s * 2 + 1] - 127.5;
        const m = i * i + q * q;
        if (m > peak) peak = m;
      }
      peaks[x] = Math.sqrt(peak);
      if (peaks[x] > bufferPeak) bufferPeak = peaks[x];
    }

    // Message positions.
    for (const mm of messages) {
      const x0 = (mm.sampleOffset / samples) * width;
      const w = Math.max(2, (mm.sampleLength / samples) * width);
      const active = mm === this._hoveredMessage || mm === this._selected?.mm;
      ctx.fillStyle = active ? "rgba(255, 225, 77, 0.35)" : mm.crcOk ? COLORS.marker : "rgba(255, 92, 92, 0.35)";
      ctx.fillRect(x0, top, w, plotHeight);
      ctx.fillStyle = active ? COLORS.highlight : mm.crcOk ? COLORS.muted : COLORS.corrupt;
      ctx.fillText(mm.crcOk ? describeType(mm)[0] : "✗", x0, 1);
    }

    // Magnitude envelope.
    ctx.fillStyle = COLORS.envelope;
    for (let x = 0; x < columns; x++) {
      const h = (peaks[x] / bufferPeak) * plotHeight;
      ctx.fillRect(x, top + plotHeight - h, 1, h);
    }

    // Time axis: a tick every 5 ms.
    ctx.fillStyle = COLORS.muted;
    ctx.fillRect(0, top + plotHeight, width, 1);
    for (let ms = 0; ms <= durationMs; ms += 5) {
      const x = (ms / durationMs) * width;
      ctx.fillRect(x, top + plotHeight, 1, 3);
      if (x < width - 30) ctx.fillText(`${ms} ms`, x + 2, top + plotHeight + 2);
    }
  }

  _renderDetail() {
    const { ctx } = prepare(this._detail);
    const selected = this._selected;
    if (!selected) return;
    const { mm, samples, start, fields } = selected;
    const hover = this._hover;
    const count = samples.length / 2;
    const px = PX_PER_SAMPLE;
    const messageStart = mm.sampleOffset - start;
    const dataStart = messageStart + PREAMBLE_SAMPLES;
    const bitCount = mm.msg.length * 8;
    const bitX = (b) => (dataStart + b * 2) * px;
    const inHover = (b) => hover && hover.kind !== "preamble" && b >= hover.from && b < hover.to;

    // Lane labels in the leading context area.
    ctx.fillStyle = COLORS.faint;
    ctx.textAlign = "left";
    ctx.fillText("hex", 0, LANES.hex[0] + 2);
    ctx.fillText("bits", 0, LANES.bits[0]);
    ctx.fillText("fields", 0, LANES.fields[0] + 4);
    ctx.fillText("|IQ|", 0, LANES.magnitude[0] + 14);
    ctx.fillStyle = COLORS.i;
    ctx.fillText("I", 0, LANES.iq[0]);
    ctx.fillStyle = COLORS.q;
    ctx.fillText("Q", 8, LANES.iq[0]);
    ctx.fillStyle = COLORS.faint;
    ctx.fillText("uncertainty", 0, LANES.uncertainty[0] + 2);

    // Hovered range as a band through all lanes.
    if (hover) {
      ctx.fillStyle = COLORS.highlightBand;
      const x0 = hover.kind === "preamble" ? messageStart * px : bitX(hover.from);
      const x1 = hover.kind === "preamble" ? dataStart * px : bitX(hover.to);
      ctx.fillRect(x0, 0, x1 - x0, DETAIL_HEIGHT);
    }

    // Hex: each byte centred over its 8 bits, with a rule between bytes.
    ctx.textAlign = "center";
    ctx.font = "11px ui-monospace, 'SF Mono', Menlo, monospace";
    for (let byte = 0; byte < mm.msg.length; byte++) {
      const x = bitX(byte * 8);
      const active = inHover(byte * 8) || inHover(byte * 8 + 7);
      ctx.fillStyle = active ? COLORS.highlight : COLORS.ink;
      ctx.fillText(mm.msg[byte].toString(16).padStart(2, "0"), x + 8 * px, LANES.hex[0] + 1);
      ctx.fillStyle = COLORS.rule;
      ctx.fillRect(x, LANES.hex[0], 1, LANES.fields[0] + LANES.fields[1]);
    }
    ctx.font = "10px system-ui, -apple-system, 'Segoe UI', sans-serif";

    // Bits: a filled cell for 1, a baseline for 0. Bits flipped by error
    // correction are red, with a red mark over their two samples below.
    const fixed = new Set(mm.fixedBits ?? []);
    for (let b = 0; b < bitCount; b++) {
      const bit = bitAt(mm, b);
      ctx.fillStyle = fixed.has(b) ? COLORS.corrupt : inHover(b) ? COLORS.highlight : bit ? COLORS.ink : COLORS.faint;
      const [top, height] = LANES.bits;
      ctx.fillRect(bitX(b) + 1, bit ? top : top + height - 1, 2 * px - 2, bit ? height : 1);
      if (fixed.has(b)) {
        ctx.fillRect(bitX(b) + 1, LANES.magnitude[0] + LANES.magnitude[1] + 1, 2 * px - 2, 2);
      }
    }

    // Fields: a bracket per field with its name when it fits.
    for (const field of fields) {
      const x0 = bitX(field.from) + 1;
      const x1 = bitX(field.to) - 1;
      const active = hover?.fields.includes(field);
      const [top] = LANES.fields;
      ctx.fillStyle = active ? COLORS.highlight : field.columns.length ? COLORS.muted : COLORS.faint;
      ctx.fillRect(x0, top, x1 - x0, 1);
      ctx.fillRect(x0, top, 1, 3);
      ctx.fillRect(x1 - 1, top, 1, 3);
      if (field.name && ctx.measureText(field.name).width < x1 - x0 - 2) {
        ctx.fillText(field.name, (x0 + x1) / 2, top + 3);
      }
    }
    ctx.textAlign = "left";

    // Magnitude per sample, scaled to this message's peak. Within each bit the
    // stronger sample is bright: first half → 1, second half → 0.
    const [magTop, magHeight] = LANES.magnitude;
    const magnitudes = new Float32Array(count);
    let peak = 10;
    for (let s = 0; s < count; s++) {
      magnitudes[s] = this._magnitudeAt(samples, s);
      if (magnitudes[s] > peak) peak = magnitudes[s];
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    ctx.fillRect(messageStart * px, magTop, PREAMBLE_SAMPLES * px, magHeight);
    for (let s = 0; s < count; s++) {
      const h = (magnitudes[s] / peak) * (magHeight - 12);
      let color = COLORS.faint;
      if (s >= messageStart && s < dataStart) {
        color = PREAMBLE_PULSES.includes(s - messageStart) ? COLORS.ink : COLORS.faint;
      } else if (s >= dataStart && s < dataStart + bitCount * 2) {
        const b = (s - dataStart) >> 1;
        const first = (s - dataStart) % 2 === 0;
        const partner = first ? magnitudes[s + 1] : magnitudes[s - 1];
        const winner = first ? magnitudes[s] > partner : magnitudes[s] >= partner;
        color = winner ? (inHover(b) ? COLORS.highlight : COLORS.ink) : COLORS.faint;
      }
      ctx.fillStyle = color;
      ctx.fillRect(s * px + 0.5, magTop + magHeight - h, px - 1, h);
    }
    // Expected preamble pulses.
    ctx.fillStyle = hover?.kind === "preamble" ? COLORS.highlight : COLORS.muted;
    for (const p of PREAMBLE_PULSES) {
      const cx = (messageStart + p + 0.5) * px;
      ctx.beginPath();
      ctx.moveTo(cx - 3, magTop + 7);
      ctx.lineTo(cx + 3, magTop + 7);
      ctx.lineTo(cx, magTop + 11);
      ctx.fill();
    }
    // Named in the fields lane, like the parts of the message itself.
    ctx.fillStyle = hover?.kind === "preamble" ? COLORS.highlight : COLORS.muted;
    ctx.fillText("preamble", messageStart * px + 2, LANES.fields[0] + 4);
    // Outline the two samples of the hovered bit.
    if (hover?.kind === "bit") {
      ctx.strokeStyle = COLORS.highlight;
      ctx.strokeRect(bitX(hover.bit) + 0.5, magTop + 12.5, 2 * px - 1, magHeight - 13);
    }

    // I and Q components, same scale.
    const [iqTop, iqHeight] = LANES.iq;
    const mid = iqTop + iqHeight / 2;
    ctx.fillStyle = COLORS.rule;
    ctx.fillRect(0, mid, count * px, 1);
    ctx.lineWidth = 1;
    for (const [offset, color] of [[0, COLORS.i], [1, COLORS.q]]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let s = 0; s < count; s++) {
        const y = mid - ((samples[s * 2 + offset] - 127.5) / peak) * (iqHeight / 2);
        if (s === 0) ctx.moveTo((s + 0.5) * px, y);
        else ctx.lineTo((s + 0.5) * px, y);
      }
      ctx.stroke();
    }

    this._renderUncertainty(ctx, bitX, inHover);
  }

  // Per bit uncertainty, when soft-decision decoding was attempted: taller bars
  // are less certain (the two halves were closer). SDD's candidates are amber,
  // the bits it flipped red.
  _renderUncertainty(ctx, bitX, inHover) {
    const { mm } = this._selected;
    const [top, height] = LANES.uncertainty;
    const certainty = mm.bitCertainty;
    if (!certainty) {
      ctx.fillStyle = COLORS.faint;
      ctx.fillText(mm.fixMethod === "crc" ? "SDD not needed: fixed by the checksum alone" : "shown when SDD (soft-decision decoding) is used",
        bitX(0), top + 2);
      return;
    }
    const max = Math.max(1, ...certainty);
    const candidates = new Set(mm.sddCandidates ?? []);
    const fixed = new Set(mm.fixedBits ?? []);
    for (let b = 0; b < certainty.length; b++) {
      const h = Math.max(1, (1 - certainty[b] / max) * height);
      ctx.fillStyle = fixed.has(b) ? COLORS.corrupt
        : inHover(b) ? COLORS.highlight
        : candidates.has(b) ? COLORS.candidate
        : COLORS.faint;
      ctx.fillRect(bitX(b) + 1, top + height - h, 2 * PX_PER_SAMPLE - 2, h);
    }
    ctx.fillStyle = COLORS.rule;
    ctx.fillRect(bitX(0), top + height, bitX(certainty.length) - bitX(0), 1);
    const legendX = bitX(certainty.length) + 8;
    ctx.fillStyle = COLORS.candidate;
    ctx.fillText(`${candidates.size} SDD candidates`, legendX, top + 2);
    ctx.fillStyle = mm.fixMethod === "sdd" ? COLORS.corrupt : COLORS.muted;
    ctx.fillText(mm.fixMethod === "sdd" ? `${fixed.size} flipped` : "no fix found", legendX, top + 14);
  }

  _renderConstellation() {
    const { ctx, width, height } = prepare(this._constellation);
    const size = Math.min(width, height) - 4;
    const cx = width / 2;
    const cy = height / 2;
    ctx.fillStyle = COLORS.rule;
    ctx.fillRect(cx - size / 2, cy, size, 1);
    ctx.fillRect(cx, cy - size / 2, 1, size);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText("I", cx + size / 2 - 6, cy + 2);
    ctx.fillText("Q", cx + 3, cy - size / 2);

    const selected = this._selected;
    if (!selected) return;
    const { mm, samples, start } = selected;
    const from = mm.sampleOffset - start;
    const to = from + mm.sampleLength;
    const hover = this._hover;
    let peak = 10;
    for (let s = 0; s < samples.length / 2; s++) peak = Math.max(peak, this._magnitudeAt(samples, s));
    for (let s = 0; s < samples.length / 2; s++) {
      const inMessage = s >= from && s < to;
      const bit = (s - from - PREAMBLE_SAMPLES) >> 1;
      const hovered = hover && hover.kind !== "preamble" && s >= from + PREAMBLE_SAMPLES && bit >= hover.from && bit < hover.to;
      const px = cx + ((samples[s * 2] - 127.5) / peak) * (size / 2);
      const py = cy - ((samples[s * 2 + 1] - 127.5) / peak) * (size / 2);
      ctx.fillStyle = hovered ? COLORS.highlight : inMessage ? "rgba(232, 232, 232, 0.75)" : "rgba(138, 143, 150, 0.45)";
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }
  }
}
