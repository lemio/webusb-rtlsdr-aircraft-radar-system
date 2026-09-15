"use strict";

// Keeps track of every aircraft we hear and turns the raw ADS-B fields from
// decoder.js into a usable position, heading and altitude. The full history
// is kept (aircraft never expire) and persisted to localStorage.

const CPR_MAX = 131072; // 2^17
const CPR_PAIR_MAX_AGE = 10000; // Even/odd frames must be less than 10s apart.
const LOCAL_REF_MAX_AGE = 60000; // A last known position this recent is a safe CPR reference.
const RECEIVER_MAX_RANGE_KM = 333; // ~180 NM, the limit for locally decoded airborne positions.
const MAX_JUMP_KM = 50; // Reject decoded positions that jump further than this.
const STORAGE_KEY = "aircraft-history-v1";

// Number of longitude zones for a given latitude (1..59).
function cprNL(lat) {
  lat = Math.abs(lat);
  if (lat === 0) return 59;
  if (lat === 87) return 2;
  if (lat > 87) return 1;
  const a = 1 - Math.cos(Math.PI / 30);
  const b = Math.cos((Math.PI / 180) * lat) ** 2;
  return Math.floor((2 * Math.PI) / Math.acos(1 - a / b));
}

const cprMod = (a, b) => ((a % b) + b) % b;
const cprN = (lat, isOdd) => Math.max(1, cprNL(lat) - isOdd);

// Globally unambiguous position from an even and an odd CPR frame.
// See https://mode-s.org/decode/content/ads-b/3-airborne-position.html
function decodeCprGlobal(even, odd) {
  const j = Math.floor((59 * even.lat - 60 * odd.lat) / CPR_MAX + 0.5);
  let latEven = (360 / 60) * (cprMod(j, 60) + even.lat / CPR_MAX);
  let latOdd = (360 / 59) * (cprMod(j, 59) + odd.lat / CPR_MAX);
  if (latEven >= 270) latEven -= 360;
  if (latOdd >= 270) latOdd -= 360;

  // Both frames must be in the same latitude zone.
  if (cprNL(latEven) !== cprNL(latOdd)) return null;

  const useOdd = odd.time > even.time;
  const lat = useOdd ? latOdd : latEven;
  const nl = cprNL(lat);
  const ni = cprN(lat, useOdd ? 1 : 0);
  const m = Math.floor((even.lon * (nl - 1) - odd.lon * nl) / CPR_MAX + 0.5);
  let lon = (360 / ni) * (cprMod(m, ni) + (useOdd ? odd.lon : even.lon) / CPR_MAX);
  lon -= Math.floor((lon + 180) / 360) * 360;

  return [lon, lat];
}

// Position from a single CPR frame, relative to a nearby reference position.
function decodeCprLocal(frame, isOdd, [refLon, refLat]) {
  const dLat = 360 / (isOdd ? 59 : 60);
  const j =
    Math.floor(refLat / dLat) +
    Math.floor(cprMod(refLat, dLat) / dLat - frame.lat / CPR_MAX + 0.5);
  const lat = dLat * (j + frame.lat / CPR_MAX);
  if (Math.abs(lat) > 90) return null;

  const dLon = 360 / cprN(lat, isOdd);
  const m =
    Math.floor(refLon / dLon) +
    Math.floor(cprMod(refLon, dLon) / dLon - frame.lon / CPR_MAX + 0.5);
  return [dLon * (m + frame.lon / CPR_MAX), lat];
}

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const toRad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * toRad) / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(((lon2 - lon1) * toRad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function bearing([lon1, lat1], [lon2, lat2]) {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

export class AircraftTracker {
  constructor() {
    this.aircraft = new Map();
    this.receiver = null; // [lon, lat] of the antenna, if known.
    this.persist = true; // Save to localStorage (off for simulated data).
    this._load();
  }

  // Feed a decoded message. Returns the aircraft it belongs to, if any.
  update(mm) {
    if (!mm.crcOk || !mm.icao) return null;

    const now = Date.now();
    const hex = mm.icao.toString(16).padStart(6, "0").toUpperCase();
    let plane = this.aircraft.get(hex);
    if (!plane) {
      plane = {
        hex,
        callsign: "",
        squawk: null,
        position: null,
        positionTime: 0,
        altitude: null,
        heading: null,
        headingFromTrack: false,
        speed: null,
        vertRate: null,
        trail: [], // [lon, lat, altitude ft or null, unix seconds]
        cprEven: null,
        cprOdd: null,
        messages: 0,
        firstSeen: now,
        lastSeen: now,
      };
      this.aircraft.set(hex, plane);
    }
    plane.messages++;
    plane.lastSeen = now;

    if (mm.callsign) plane.callsign = mm.callsign;
    if (mm.altitude) plane.altitude = mm.altitude;
    if (mm.msgtype === 5 || mm.msgtype === 21) {
      plane.squawk = String(mm.identity).padStart(4, "0");
    }

    if (mm.msgtype === 17 && mm.metype >= 9 && mm.metype <= 18) {
      const frame = { lat: mm.rawLatitude, lon: mm.rawLongitude, time: now };
      const isOdd = mm.fflag ? 1 : 0;
      if (isOdd) plane.cprOdd = frame;
      else plane.cprEven = frame;
      this._updatePosition(plane, frame, isOdd, now);
      if (plane.positionTime === now) mm.position = plane.position;
    }

    if (mm.msgtype === 17 && mm.metype === 19) {
      if (mm.mesub === 1 || mm.mesub === 2) {
        plane.heading = mm.heading;
        plane.headingFromTrack = false;
        plane.speed = Math.round(mm.speed);
        if (mm.vertRate) {
          plane.vertRate = (mm.vertRateSign ? -1 : 1) * (mm.vertRate - 1) * 64;
        }
      } else if (mm.headingIsValid) {
        plane.heading = mm.heading;
        plane.headingFromTrack = false;
      }
    }

    return plane;
  }

  _updatePosition(plane, frame, isOdd, now) {
    const previous = plane.position;
    const previousIsRecent = previous && now - plane.positionTime < LOCAL_REF_MAX_AGE;
    const { cprEven, cprOdd } = plane;
    let position = null;

    if (cprEven && cprOdd && Math.abs(cprEven.time - cprOdd.time) <= CPR_PAIR_MAX_AGE) {
      position = decodeCprGlobal(cprEven, cprOdd);
    }
    // Without a fresh even/odd pair, decode this frame on its own relative to
    // the aircraft's last position or the receiver's location.
    if (!position && previousIsRecent) {
      position = decodeCprLocal(frame, isOdd, previous);
    }
    if (!position && this.receiver) {
      position = decodeCprLocal(frame, isOdd, this.receiver);
      if (position && distanceKm(position, this.receiver) > RECEIVER_MAX_RANGE_KM) position = null;
    }
    if (!position) return;
    if (previousIsRecent && distanceKm(previous, position) > MAX_JUMP_KM) return;

    if (previous && (previous[0] !== position[0] || previous[1] !== position[1])) {
      // Without a velocity message, estimate the heading from movement.
      if (plane.heading === null || plane.headingFromTrack) {
        plane.heading = bearing(previous, position);
        plane.headingFromTrack = true;
      }
    }
    plane.position = position;
    plane.positionTime = now;

    const point = [round(position[0], 5), round(position[1], 5), plane.altitude, Math.round(now / 1000)];
    const last = plane.trail[plane.trail.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1] || last[2] !== point[2]) {
      plane.trail.push(point);
    }
  }

  // Forget every aircraft, including the saved history (unless not persisting,
  // e.g. for simulated data, which must not touch the real history).
  reset() {
    this.aircraft.clear();
    if (!this.persist) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn("Could not clear aircraft history", error);
    }
  }

  _load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      for (const plane of stored?.aircraft ?? []) {
        this.aircraft.set(plane.hex, { ...plane, cprEven: null, cprOdd: null });
      }
    } catch (error) {
      console.warn("Could not load aircraft history", error);
    }
  }

  // Persist everything except transient CPR frames. If the storage quota is
  // exceeded, the oldest points of the longest trail are dropped until it fits.
  save() {
    if (!this.persist) return;
    const aircraft = [...this.aircraft.values()].map(({ cprEven, cprOdd, ...plane }) => plane);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ aircraft }));
        return;
      } catch (error) {
        if (error?.name !== "QuotaExceededError") {
          console.warn("Could not save aircraft history", error);
          return;
        }
        const longest = aircraft.reduce((a, b) => (b.trail.length > a.trail.length ? b : a));
        if (longest.trail.length < 2) return;
        // The trail array is shared with the live aircraft, so this trims both.
        const dropped = longest.trail.splice(0, Math.ceil(longest.trail.length / 4));
        console.warn(`localStorage full: dropped ${dropped.length} old points of ${longest.hex}`);
      }
    }
  }
}
