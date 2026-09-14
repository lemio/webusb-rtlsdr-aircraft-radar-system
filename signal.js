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

const SAMPLE_RATE = 2_000_000; // Samples per second (0.5 µs per sample).
const PREAMBLE_SAMPLES = 16; // 8 µs.
const PREAMBLE_PULSES = [0, 2, 7, 9]; // Samples with energy: 0, 1, 3.5, 4.5 µs.
const CONTEXT_SAMPLES = 16; // Shown before and after a message.
const PX_PER_SAMPLE = 4; // Fixed scale: one bit is 8 px, one byte 64 px.
const DETAIL_SAMPLES = CONTEXT_SAMPLES * 2 + PREAMBLE_SAMPLES + 112 * 2; // Fits a long message.
const MAX_BUFFERS = 32; // Recent buffers kept for the overview (~2 s).
const CPR_MAX = 131072;
const CHARSET = "?ABCDEFGHIJKLMNOPQRSTUVWXYZ????? ???????????????0123456789??????";

// Vertical layout of the detail view (top, height) in px.
const LANES = {
  hex: [0, 14],
  bits: [15, 10],
  fields: [28, 16],
  magnitude: [48, 104],
  iq: [158, 56],
};
const DETAIL_HEIGHT = 216;

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
  i: "#6ab0ff",
  q: "#ffb35c",
};

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
  if (!mm.crcOk) return "does not match the message: corrupt, and single/double bit repair failed";
  if (mm.errorbit === -1) return "matches the message";
  if (mm.errorbit > 255) return `matched after flipping bits ${mm.errorbit & 0xff} and ${mm.errorbit >> 8}`;
  return `matched after flipping bit ${mm.errorbit}`;
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
  constructor(container, { onHover, onField, onFreeze, onShow, onLock, onUnlock }) {
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
    this._overview = container.querySelector(".signal-overview");
    this._detailTitle = container.querySelector(".signal-detail-title");
    this._detail = container.querySelector(".signal-detail");
    this._constellation = container.querySelector(".signal-constellation");
    this._tooltip = container.querySelector(".signal-tooltip");
    this._detail.style.width = `${DETAIL_SAMPLES * PX_PER_SAMPLE}px`;
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
    const buffer = { data, messages };
    // Keep each message's own samples (small), so it can be shown later, e.g.
    // when its row in the table is hovered — even while the view is paused.
    for (const mm of messages) {
      const start = Math.max(0, mm.sampleOffset - CONTEXT_SAMPLES);
      const end = Math.min(data.length / 2, start + DETAIL_SAMPLES);
      this._snapshots.set(mm, { start, samples: data.slice(start * 2, end * 2), buffer });
    }
    this._buffers.push(buffer);
    if (this._buffers.length > MAX_BUFFERS) this._buffers.shift();

    if (this._frozen || this._paused || this._pinned || this._locked) return;
    this._chunk = buffer;
    // The detail view follows the most recent valid message, else any.
    const latest = messages.findLast((mm) => mm.crcOk) ?? messages[messages.length - 1];
    if (latest) this._select(latest);
    this._scheduleRender();
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
    if (hover.kind === "preamble") {
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
        lines.push(`<span class="signal-muted">Bit ${hover.bit + 1}: first half ${first.toFixed(0)} ${first > second ? ">" : "<"} second half ${second.toFixed(0)} → ${bitAt(mm, hover.bit)}</span>`);
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

    // Bits: a filled cell for 1, a baseline for 0.
    for (let b = 0; b < bitCount; b++) {
      const bit = bitAt(mm, b);
      ctx.fillStyle = inHover(b) ? COLORS.highlight : bit ? COLORS.ink : COLORS.faint;
      const [top, height] = LANES.bits;
      ctx.fillRect(bitX(b) + 1, bit ? top : top + height - 1, 2 * px - 2, bit ? height : 1);
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
