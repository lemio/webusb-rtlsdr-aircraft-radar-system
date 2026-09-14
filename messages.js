"use strict";

// Live table of decoded Mode S messages. Hundreds of messages can arrive per
// second, so rows are queued and written to the DOM once per animation frame,
// keeping only the most recent rows.

const MAX_ROWS = 200;
const DOCS = "https://mode-s.org/1090mhz/content/";

// Human readable message types: [abbreviation, explanation, reference page].
export function describeType(mm) {
  const df = mm.msgtype;
  if (df === 17 || df === 18) {
    const tc = mm.metype;
    const es = df === 18 ? "Extended squitter (non-transponder): " : "ADS-B: ";
    if (tc >= 1 && tc <= 4) return ["ID", `${es}aircraft identification and category (TC ${tc})`, "ads-b/2-identification.html"];
    if (tc >= 5 && tc <= 8) return ["SURF", `${es}surface position (TC ${tc})`, "ads-b/4-surface-position.html"];
    if (tc >= 9 && tc <= 18) return ["POS", `${es}airborne position with barometric altitude (TC ${tc})`, "ads-b/3-airborne-position.html"];
    if (tc === 19) return ["VEL", `${es}airborne velocity (TC 19, subtype ${mm.mesub})`, "ads-b/5-airborne-velocity.html"];
    if (tc >= 20 && tc <= 22) return ["GNSS", `${es}airborne position with GNSS height (TC ${tc})`, "ads-b/3-airborne-position.html"];
    if (tc === 28) return ["STAT", `${es}aircraft status: emergency or ACAS resolution advisory (TC 28)`, "ads-b/1-basics.html"];
    if (tc === 29) return ["TGT", `${es}target state and status (TC 29)`, "ads-b/1-basics.html"];
    if (tc === 31) return ["OPS", `${es}aircraft operational status (TC 31)`, "ads-b/6-operation-status.html"];
    return ["ES", `${es}type code ${tc}`, "ads-b/1-basics.html"];
  }
  switch (df) {
    case 0: return ["ACAS", "Short air-air surveillance (ACAS)", "mode-s/4-acas.html"];
    case 4: return ["ALT", "Surveillance reply: altitude", "mode-s/3-surveillance.html"];
    case 5: return ["SQK", "Surveillance reply: identity (squawk)", "mode-s/3-surveillance.html"];
    case 11: return ["ACQ", "All-call reply (acquisition squitter)", "mode-s/2-allcall.html"];
    case 16: return ["ACAS", "Long air-air surveillance (ACAS)", "mode-s/4-acas.html"];
    case 20: return ["CB·ALT", "Comm-B reply with altitude", "mode-s/5-commb.html"];
    case 21: return ["CB·SQK", "Comm-B reply with identity (squawk)", "mode-s/5-commb.html"];
    case 24: return ["ELM", "Comm-D extended length message", "mode-s/1-basics.html"];
    default: return ["DF", `Downlink format ${df}`, "mode-s/1-basics.html"];
  }
}

// Only the fields each message type actually carries.
function extractFields(mm) {
  const fields = {};
  const es = mm.msgtype === 17;
  if (es && mm.metype >= 1 && mm.metype <= 4 && mm.callsign) fields.callsign = mm.callsign;
  if (mm.msgtype === 5 || mm.msgtype === 21) fields.squawk = String(mm.identity).padStart(4, "0");
  if (mm.altitude) fields.altitude = mm.altitude;
  if (mm.position) [fields.lon, fields.lat] = mm.position;
  if (es && mm.metype === 19) {
    if (mm.mesub === 1 || mm.mesub === 2) {
      fields.speed = Math.round(mm.speed);
      fields.heading = mm.heading;
      // Raw 0 means "no information"; raw 1 is level flight (shown as a dash).
      if (mm.vertRate) fields.vertRate = mm.vertRateSign && mm.vertRate > 1 ? -(mm.vertRate - 1) * 64 : (mm.vertRate - 1) * 64;
    } else if (mm.headingIsValid) {
      fields.heading = mm.heading;
    }
  }
  return fields;
}

function crcProblem(mm) {
  if (!mm.crcOk) return ["CRC ✗", "Checksum does not match: message may be corrupt"];
  if (mm.errorbit === -1) return null;
  if (mm.errorbit > 255) {
    return ["2 bit fix", `Checksum failed; repaired by flipping bits ${mm.errorbit & 0xff} and ${mm.errorbit >> 8}`];
  }
  return ["1 bit fix", `Checksum failed; repaired by flipping bit ${mm.errorbit}`];
}

// Number presentation (see "Beyond Excel, enter the Matrix"):
// - tabular figures, so digits of equal significance line up;
// - every number has a fixed-width slot per field, so rows of the same
//   message type align even though all data shares one column;
// - decimals: whole part right aligned up to the point, fraction left aligned;
// - zero is a dash, so "none" doesn't read as a small value.
const MINUS = "\u2212";
const DASH = "\u2013";
const FIGURE_SPACE = "\u2007"; // As wide as a tabular digit.

function span(className, text) {
  const el = document.createElement("span");
  el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

// A hoverable field: matching values highlight across all rows.
function field(column, value, ...children) {
  const el = span(`field ${column}`);
  el.dataset.col = column;
  if (value != null && value !== "") el.dataset.value = value;
  el.append(...children);
  return el;
}

// Right-aligned number in a slot `width` digits wide.
const figure = (text, width) => {
  const el = span("figure", text);
  el.style.width = `${width}ch`;
  return el;
};

// Units keep their space when there's no value, so the next field stays aligned.
const unit = (text, hasValue = true) => {
  const el = span("unit", text);
  if (!hasValue) el.style.visibility = "hidden";
  return el;
};

// Whole part right aligned in `wholeWidth` digits, fraction left aligned.
function decimal(value, wholeWidth, decimals) {
  const [whole, fraction] = Math.abs(value).toFixed(decimals).split(".");
  const el = span("decimal");
  el.append(figure((value < 0 ? MINUS : "") + whole, wholeWidth), span("fraction", "." + fraction));
  return el;
}

const formatInteger = (n) => (n < 0 ? MINUS : "") + Math.abs(n).toLocaleString("en-US");
const formatSigned = (n) => (n ? (n > 0 ? "+" : MINUS) + Math.abs(n).toLocaleString("en-US") : DASH);

// The message column: a fixed layout of slots per kind of message.
function messageContent(mm) {
  const f = extractFields(mm);
  const df = mm.msgtype;
  const tc = mm.metype;
  const parts = [];

  const altitude = () =>
    field("alt", f.altitude, figure(f.altitude != null ? formatInteger(f.altitude) : "", 6), unit("ft", f.altitude != null));

  if ((df === 17 || df === 18) && ((tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22))) {
    parts.push(
      altitude(),
      field("lat", f.lat?.toFixed(4), f.lat != null ? decimal(f.lat, 3, 4) : figure("", 8)),
      field("lon", f.lon?.toFixed(4), f.lon != null ? decimal(f.lon, 4, 4) : figure("", 9)),
    );
  } else if (df === 0 || df === 4 || df === 16 || df === 20) {
    parts.push(altitude());
  } else if (df === 17 && tc === 19) {
    const arrow = span("arrow", f.heading != null ? "↑" : "");
    if (f.heading != null) {
      arrow.title = `${Math.round(f.heading)}°`;
      arrow.style.setProperty("--heading", f.heading);
    }
    parts.push(
      field("gs", f.speed, figure(f.speed != null ? (f.speed ? formatInteger(f.speed) : DASH) : "", 3), unit("kt", f.speed != null)),
      field("vs", f.vertRate, figure(f.vertRate != null ? formatSigned(f.vertRate) : "", 6), unit("fpm", f.vertRate != null)),
      field("trk", f.heading != null ? Math.round(f.heading) : null, arrow),
    );
  } else if (f.callsign) {
    parts.push(field("flight", f.callsign, f.callsign));
  } else if (f.squawk) {
    parts.push(field("squawk", f.squawk, unit("squawk"), figure(f.squawk, 4)));
  }

  const problem = crcProblem(mm);
  if (problem) {
    parts.push(field("crc", problem[0], link(problem[0], DOCS + "ads-b/8-error-control.html", problem[1])));
  }
  return parts;
}

// `column` and `value` let hovering highlight every cell with the same value.
function cell(row, column, className, content, value) {
  const td = row.insertCell();
  td.className = className;
  td.dataset.col = column;
  if (value != null && value !== "") td.dataset.value = value;
  if (Array.isArray(content)) td.append(...content);
  else if (content instanceof Node) td.appendChild(content);
  else if (content != null) td.textContent = content;
  return td;
}

function link(text, href, title) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  if (title) a.title = title;
  return a;
}

export class MessageTable {
  constructor(container, { onHover, onLock }) {
    this._container = container;
    this._onHover = onHover;
    this._onLock = onLock; // (message) — its chevron was clicked
    this._shownRow = null;
    this._pending = [];
    this._flushScheduled = false;
    this._targets = new WeakMap(); // row → { hex, position, altitude }
    this._hoveredRow = null;
    this._hoveredCell = null;
    this._holds = new Set(); // Reasons the table is held from outside (e.g. "pause", "signal").
    this._messageOfRow = new WeakMap(); // row → decoded message
    this._rowsByMessage = new WeakMap(); // decoded message → row
    this._focusedRow = null;
    this._matchStyle = document.createElement("style");
    document.head.appendChild(this._matchStyle);
    this._follow = true;
    this._last = null; // Date of the most recently rendered row.

    this.table = document.createElement("table");
    this.table.className = "messages";
    this.table.innerHTML = `
      <thead><tr>
        <th></th>
        <th class="num" title="Seconds; a rule marks each new minute">s</th>
        <th>icao</th>
        <th>type</th>
        <th>message</th>
      </tr></thead>
      <tbody></tbody>`;
    this._body = this.table.tBodies[0];
    container.hidden = true;
    container.appendChild(this.table);
    this.setBearing(0);

    this._body.addEventListener("click", (event) => {
      const chevron = event.target.closest(".chevron");
      if (chevron) this._onLock?.(this._messageOfRow.get(chevron.closest("tr")));
    });
    this._body.addEventListener("mouseover", (event) => {
      this._highlightMatches(event.target.closest("[data-value]"));
      const row = event.target.closest("tr");
      if (row === this._hoveredRow) return;
      this._hoveredRow?.classList.remove("hovered");
      this._hoveredRow = row;
      row?.classList.add("hovered");
      this._onHover(row && this._targets.get(row), row && this._messageOfRow.get(row));
    });
    this._body.addEventListener("mouseleave", () => {
      this._highlightMatches(null);
      this._hoveredRow?.classList.remove("hovered");
      this._hoveredRow = null;
      this._onHover(null, null);
      this._flush();
    });
    // Stop auto-scrolling while the user scrolls back through the table.
    container.addEventListener("scroll", () => {
      this._follow = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    });
  }

  // Highlight everything of the same kind with the same value, e.g. every
  // message from one ICAO address, every POS message or every 38,000 ft.
  _highlightMatches(match) {
    if (match === this._hoveredCell) return;
    this._hoveredCell = match;
    this.highlightValue(match?.dataset.col, match?.dataset.value);
  }

  // Highlight all fields of `column` with `value`; pass no value to clear.
  highlightValue(column, value) {
    this.highlightValues(value == null ? [] : [[column, value]]);
  }

  // Highlight several [column, value] pairs at once.
  highlightValues(pairs) {
    this._matchStyle.textContent = pairs
      .map(([column, value]) => {
        const selector = `.messages [data-col="${CSS.escape(column)}"][data-value="${CSS.escape(String(value))}"]`;
        return `${selector}, ${selector} * { color: #ffe14d; }`;
      })
      .join("\n");
  }

  // Mark the row of a decoded message and highlight the given columns' values
  // (and the same values elsewhere). Pass null to clear.
  focusMessage(mm, columns = []) {
    this._focusedRow?.classList.remove("focused");
    const row = mm ? this._rowsByMessage.get(mm) : null;
    this._focusedRow = row ?? null;
    if (!row) {
      this.highlightValues([]);
      return;
    }
    row.classList.add("focused");
    row.scrollIntoView({ block: "nearest" });
    const pairs = [];
    for (const column of columns) {
      const el = row.querySelector(`[data-col="${CSS.escape(column)}"][data-value]`);
      if (el) pairs.push([column, el.dataset.value]);
    }
    this.highlightValues(pairs);
  }

  // Mark the row of the message shown in the signal view (and whether it's locked).
  markShown(mm, locked) {
    this._shown = { mm, locked }; // Also applied to its row if that's created later.
    this._shownRow?.classList.remove("shown", "locked");
    const row = mm ? this._rowsByMessage.get(mm) : null;
    this._shownRow = row ?? null;
    row?.classList.add("shown");
    if (locked) row?.classList.add("locked");
  }

  // Hold new rows back for a reason; they're shown once nothing holds them.
  hold(reason, held) {
    if (held) this._holds.add(reason);
    else this._holds.delete(reason);
    if (!this.paused) this._flush();
  }

  get paused() {
    return this._hoveredRow !== null || this._holds.size > 0;
  }

  // Arrows are drawn relative to the map, so they follow its rotation.
  setBearing(bearing) {
    this.table.style.setProperty("--bearing", bearing);
  }

  add(mm, plane) {
    this._pending.push({
      time: new Date(),
      mm,
      // Where the aircraft was when this message arrived, for hovering.
      target: plane?.position && { hex: plane.hex, position: plane.position, altitude: plane.altitude },
    });
    // Animation frames pause in background tabs; don't let the queue grow.
    if (this._pending.length > MAX_ROWS) this._pending.shift();
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      requestAnimationFrame(() => this._flush());
    }
  }

  _flush() {
    this._flushScheduled = false;
    // Pause while hovering so rows don't shift under the pointer; the newest
    // rows are kept in the queue and shown when the pointer leaves.
    if (this.paused || !this._pending.length) return;

    const fragment = document.createDocumentFragment();
    for (const entry of this._pending) fragment.appendChild(this._createRow(entry));
    this._pending = [];
    this._body.appendChild(fragment);
    this._container.hidden = false;

    while (this._body.rows.length > MAX_ROWS) this._body.deleteRow(0);
    // The top row always shows its seconds, even if it repeated the row above.
    const first = this._body.rows[0];
    if (first) first.querySelector(".time").textContent = first.dataset.seconds;

    if (this._follow) this._container.scrollTop = this._container.scrollHeight;
  }

  _createRow({ time, mm, target }) {
    const row = document.createElement("tr");
    this._rowsByMessage.set(mm, row);
    this._messageOfRow.set(row, mm);
    if (this._shown?.mm === mm) {
      row.classList.add("shown");
      if (this._shown.locked) row.classList.add("locked");
      this._shownRow = row;
    }
    // Checksum still wrong after correction: shown, but its data is unreliable.
    if (!mm.crcOk) row.classList.add("corrupt");
    const seconds = String(time.getSeconds()).padStart(2, "0");
    const last = this._last;
    const newMinute = !last || Math.floor(time / 60000) !== Math.floor(last / 60000);
    const newSecond = newMinute || Math.floor(time / 1000) !== Math.floor(last / 1000);
    this._last = time;

    row.dataset.seconds = seconds;
    if (newMinute) row.classList.add("minute");
    if (target) {
      row.classList.add("located");
      this._targets.set(row, target);
    }

    // Seconds are only repeated when they change.
    const chevron = document.createElement("button");
    chevron.className = "chevron";
    chevron.title = "Lock this message in the signal view (pauses)";
    chevron.textContent = "›";
    cell(row, "lock", "lock", chevron);

    const timeCell = cell(row, "time", "num time", newSecond ? seconds : "", Math.floor(time / 1000));
    timeCell.title = time.toLocaleTimeString();

    const hex = mm.icao.toString(16).padStart(6, "0");
    cell(row, "icao", "icao", link(hex, `https://radar.planespotters.net/?icao=${hex}`, "Open on Planespotters radar"), hex);

    const [abbreviation, explanation, page] = describeType(mm);
    const type = link("", DOCS + page, `DF ${mm.msgtype} · ${explanation}`);
    // The format number always takes two digits, so the letters line up.
    type.append(span("df", String(mm.msgtype).padStart(2, FIGURE_SPACE)), ` ${abbreviation}`);
    cell(row, "type", "type", type, `${mm.msgtype} ${abbreviation}`);

    cell(row, "message", "message", messageContent(mm));

    return row;
  }
}
