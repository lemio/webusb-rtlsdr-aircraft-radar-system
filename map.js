"use strict";

// Renders the tracked aircraft on a MapLibre GL map. `maplibregl` is loaded
// as a global from the CDN in index.html.
//
// Aircraft are drawn as extruded 3D shapes floating at their true altitude,
// with a stalk down to their ground position and a trail at the altitudes they
// flew. Heights are real metres handled by MapLibre's fill-extrusion layers, so
// they scale with the map like everything else. Symbol layers can't be
// elevated yet (maplibre-style-spec#62), so labels are HTML elements projected
// to the aircraft's 3D position with the map's projection matrix.
//
// Only the footprint (plane size, line widths) is kept in screen pixels, since
// a real 40 m aircraft would be invisible at most zoom levels.

const { MercatorCoordinate } = maplibregl;

const STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const FEET_TO_METERS = 0.3048;
const MAX_ALTITUDE_FT = 40000;
const TILTED_PITCH = 60; // Pitch used by the 3D toggle button.
const PLANE_SIZE_PX = 30;
const PLANE_THICKNESS_PX = 2;
const STALK_WIDTH_PX = 1.5;
const TRAIL_WIDTH_PX = 3;
const LABEL_OFFSET_PX = 18;
const FLASH_MS = 500; // How long a position is marked after a message arrives.

// Altitude (ft) → colour, similar to the scale used by tar1090.
const ALTITUDE_COLORS = [
  0, "#ff5a00",
  2000, "#ff9900",
  6000, "#e6e600",
  10000, "#3cd03c",
  20000, "#00c8ff",
  30000, "#4060ff",
  40000, "#c040ff",
];

const UNKNOWN_ALTITUDE_COLOR = "#9aa0a6";
const TRAIL_GAP_S = 300; // Don't connect trail points more than 5 minutes apart.

const altitudeColor = [
  "case",
  ["==", ["get", "altitude"], null], UNKNOWN_ALTITUDE_COLOR,
  ["interpolate", ["linear"], ["get", "altitude"], ...ALTITUDE_COLORS],
];

// North-pointing plane silhouette on a 64×64 grid, centred on (32, 32).
const PLANE_OUTLINE = [
  [32, 4], [34.5, 6], [36, 12], [36, 24], [60, 38], [60, 43], [36, 36],
  [35, 50], [44, 57], [44, 61], [32, 57], [20, 61], [20, 57], [29, 50],
  [28, 36], [4, 43], [4, 38], [28, 24], [28, 12], [29.5, 6],
];

const toLngLat = (x, y) => new MercatorCoordinate(x, y).toLngLat().toArray();

function polygon(ring, properties) {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
    properties,
  };
}

function formatAltitude(altitude) {
  return altitude ? `${altitude.toLocaleString()} ft` : "–";
}

export class AircraftMap {
  constructor(container) {
    this._tracker = null;
    this._followFirst = true;
    this._popup = null;
    this._popupHex = null;
    this._labels = new Map(); // hex → { el, anchor: [x, y, z] in mercator units }
    this._trailCache = new Map(); // hex → { px, count, features }
    this._flashes = new Map(); // hex → { el, anchor, timer }

    this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [5, 50],
      zoom: 4,
      maxPitch: 85,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
    this.map.addControl(this._createTiltControl(), "top-left");
    this.map.addControl(new maplibregl.ScaleControl({ unit: "nautical" }));
    this.map.on("dragstart", () => (this._followFirst = false));

    // Centre on the receiver's location if the browser allows it.
    navigator.geolocation?.getCurrentPosition(({ coords }) => {
      if (!this._followFirst) return;
      this.map.jumpTo({ center: [coords.longitude, coords.latitude], zoom: 8 });
    });

    this._ready = new Promise((resolve) => this.map.on("load", resolve)).then(() =>
      this._setupLayers()
    );
  }

  _setupLayers() {
    const map = this.map;
    map.addSource("aircraft", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "shadows",
      type: "circle",
      source: "aircraft",
      filter: ["==", ["get", "kind"], "shadow"],
      paint: {
        "circle-radius": 3,
        "circle-color": altitudeColor,
        "circle-opacity": 0,
        "circle-pitch-alignment": "map",
      },
    });

    for (const [id, opacity] of [["stalks", 0.5], ["trails", 0.7], ["planes", 1]]) {
      map.addLayer({
        id,
        type: "fill-extrusion",
        source: "aircraft",
        filter: ["==", ["get", "kind"], id],
        paint: {
          "fill-extrusion-color": altitudeColor,
          "fill-extrusion-base": ["get", "base"],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-opacity": opacity,
        },
      });
    }

    // Draws nothing itself; it receives the camera matrix every frame so the
    // HTML labels can be positioned at the aircraft's 3D location.
    map.addLayer({
      id: "label-projector",
      type: "custom",
      // mainMatrix projects mercator coordinates (0..1) to clip space.
      render: (gl, options) => this._placeLabels(options.defaultProjectionData.mainMatrix),
    });

    this._labelContainer = document.createElement("div");
    this._labelContainer.className = "plane-labels";
    map.getCanvasContainer().appendChild(this._labelContainer);

    for (const layer of ["planes", "shadows"]) {
      map.on("click", layer, (e) => this._showPopup(e.features[0].properties.hex));
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    // Heights are in metres and handled by MapLibre, but the footprint is in
    // screen pixels, so rebuild when the zoom changes.
    map.on("zoom", () => this._render());
    map.on("pitch", () => this._updateShadows());

    this._addLegend();
  }

  _createTiltControl() {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tilt-toggle";
    button.title = "Toggle 3D view";
    button.textContent = "3D";
    button.onclick = () => {
      const tilted = this.map.getPitch() > 0;
      this.map.easeTo({ pitch: tilted ? 0 : TILTED_PITCH, bearing: tilted ? 0 : this.map.getBearing() });
    };
    this.map.on("pitch", () => {
      button.textContent = this.map.getPitch() > 0 ? "2D" : "3D";
    });
    container.appendChild(button);
    return { onAdd: () => container, onRemove: () => container.remove() };
  }

  _addLegend() {
    const legend = document.createElement("div");
    legend.className = "altitude-legend maplibregl-ctrl";
    const stops = [];
    for (let i = 0; i < ALTITUDE_COLORS.length; i += 2) {
      stops.push(`${ALTITUDE_COLORS[i + 1]} ${(ALTITUDE_COLORS[i] / MAX_ALTITUDE_FT) * 100}%`);
    }
    legend.innerHTML = `
      <div class="bar" style="background: linear-gradient(to right, ${stops.join(", ")})"></div>
      <div class="labels"><span>0</span><span>10k</span><span>20k</span><span>30k</span><span>40k ft</span></div>`;
    this.map.addControl({ onAdd: () => legend, onRemove: () => legend.remove() }, "bottom-left");
  }

  // Ground shadows only make sense once the map is tilted.
  _updateShadows() {
    const opacity = 0.8 * Math.min(this.map.getPitch() / 30, 1);
    this.map.setPaintProperty("shadows", "circle-opacity", opacity);
  }

  // Build all aircraft geometry. Footprints are sized for the current zoom.
  _render() {
    if (!this._tracker) return;
    const map = this.map;

    const px = 1 / (512 * 2 ** map.getZoom()); // One screen pixel in mercator units.
    const features = [];
    const seen = new Set();

    for (const plane of this._tracker.aircraft.values()) {
      if (!plane.position) continue;
      const { hex } = plane;
      const altitude = plane.altitude; // null when unknown: drawn grey at ground level.
      const altitudeMeters = Math.max(altitude ?? 0, 0) * FEET_TO_METERS;
      const center = MercatorCoordinate.fromLngLat(plane.position, altitudeMeters);
      const toMeters = 1 / center.meterInMercatorCoordinateUnits();

      // Plane body, rotated to its heading and lifted to its altitude.
      const heading = ((plane.heading ?? 0) * Math.PI) / 180;
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      const scale = (PLANE_SIZE_PX * px) / 64;
      const body = PLANE_OUTLINE.map(([ix, iy]) => {
        const east = (ix - 32) * scale;
        const north = (32 - iy) * scale;
        return toLngLat(center.x + east * cos + north * sin, center.y + east * sin - north * cos);
      });
      features.push(polygon(body, {
        kind: "planes",
        hex,
        altitude,
        base: altitudeMeters,
        height: altitudeMeters + PLANE_THICKNESS_PX * px * toMeters,
      }));

      // Stalk from the ground up to the plane, plus a ground shadow.
      if (altitudeMeters > 0) {
        const w = (STALK_WIDTH_PX * px) / 2;
        features.push(polygon([
          toLngLat(center.x - w, center.y - w),
          toLngLat(center.x + w, center.y - w),
          toLngLat(center.x + w, center.y + w),
          toLngLat(center.x - w, center.y + w),
        ], { kind: "stalks", hex, altitude, base: 0, height: altitudeMeters }));
      }
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: plane.position },
        properties: { kind: "shadow", hex, altitude },
      });

      features.push(...this._trailFeatures(plane, px));

      this._updateLabel(plane, [center.x, center.y, center.z]);
      seen.add(hex);
    }

    for (const [hex, label] of this._labels) {
      if (!seen.has(hex)) {
        label.el.remove();
        this._labels.delete(hex);
        this._trailCache.delete(hex);
      }
    }

    map.getSource("aircraft").setData({ type: "FeatureCollection", features });
    map.triggerRepaint();
  }

  // Trail as thin ribbons at the altitude of each segment. Histories can be
  // long, so segments are cached and only new ones are built until the zoom
  // (and with it the ribbon width) changes.
  _trailFeatures(plane, px) {
    let cache = this._trailCache.get(plane.hex);
    if (!cache || cache.px !== px || cache.count > plane.trail.length) {
      cache = { px, count: 0, features: [] };
      this._trailCache.set(plane.hex, cache);
    }
    const halfWidth = (TRAIL_WIDTH_PX * px) / 2;
    const { trail } = plane;
    for (let i = Math.max(cache.count, 1); i < trail.length; i++) {
      const [aLon, aLat, aAlt, aTime] = trail[i - 1];
      const [bLon, bLat, bAlt, bTime] = trail[i];
      if (aTime && bTime && bTime - aTime > TRAIL_GAP_S) continue;
      const a = MercatorCoordinate.fromLngLat([aLon, aLat]);
      const b = MercatorCoordinate.fromLngLat([bLon, bLat]);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) continue;
      const nx = (-(b.y - a.y) / length) * halfWidth;
      const ny = ((b.x - a.x) / length) * halfWidth;
      const segmentAltitude = aAlt == null || bAlt == null ? null : (aAlt + bAlt) / 2;
      const base = Math.max(segmentAltitude, 0) * FEET_TO_METERS;
      cache.features.push(polygon([
        toLngLat(a.x + nx, a.y + ny),
        toLngLat(b.x + nx, b.y + ny),
        toLngLat(b.x - nx, b.y - ny),
        toLngLat(a.x - nx, a.y - ny),
      ], {
        kind: "trails",
        hex: plane.hex,
        altitude: segmentAltitude,
        base,
        height: base + TRAIL_WIDTH_PX * px / a.meterInMercatorCoordinateUnits(),
      }));
    }
    cache.count = trail.length;
    return cache.features;
  }

  _updateLabel(plane, anchor) {
    let label = this._labels.get(plane.hex);
    if (!label) {
      const el = document.createElement("div");
      el.className = "plane-label";
      el.onclick = () => this._showPopup(plane.hex);
      this._labelContainer.appendChild(el);
      label = { el };
      this._labels.set(plane.hex, label);
    }
    label.anchor = anchor;
    label.el.innerHTML = `${plane.callsign || plane.hex}<br><small>${
      plane.altitude ? formatAltitude(plane.altitude) : "altitude unknown"
    }</small>`;
    const age = (Date.now() - plane.lastSeen) / 1000;
    label.el.style.opacity = age > 20 ? Math.max(0.3, 1 - (age - 20) / 40) : 1;
  }

  // Project a mercator (x, y, z) point to screen pixels with the camera matrix.
  _project(m, [x, y, z]) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0) return null; // Behind the camera.
    const canvas = this.map.getCanvas();
    return [
      (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2) * canvas.clientWidth,
      ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2) * canvas.clientHeight,
    ];
  }

  // Mark where a message relates to: the aircraft's position at the time the
  // message arrived, at its altitude. Pass null to clear.
  highlight(target) {
    const previous = this._highlight;
    if (previous) this._labels.get(previous.hex)?.el.classList.remove("highlighted");
    this._highlight = null;

    if (target?.position) {
      this._highlight = { hex: target.hex, anchor: this._anchor(target) };
      this._labels.get(target.hex)?.el.classList.add("highlighted");
    }
    if (!this._highlightEl && this._labelContainer) {
      this._highlightEl = document.createElement("div");
      this._highlightEl.className = "plane-highlight";
      this._labelContainer.appendChild(this._highlightEl);
    }
    if (this._highlightEl) this._highlightEl.hidden = !this._highlight;
    this.map.triggerRepaint();
  }

  // Briefly mark an aircraft's position when a message for it arrives. Each
  // new message for the same aircraft moves the mark and restarts the timer.
  flash(target) {
    if (!target?.position || !this._labelContainer) return;
    const { hex } = target;
    let flash = this._flashes.get(hex);
    if (!flash) {
      const el = document.createElement("div");
      el.className = "plane-highlight flash";
      el.hidden = true; // Shown once it has been positioned.
      this._labelContainer.appendChild(el);
      flash = { el };
      this._flashes.set(hex, flash);
    }
    flash.anchor = this._anchor(target);
    this._labels.get(hex)?.el.classList.add("flashing");
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => {
      flash.el.remove();
      this._flashes.delete(hex);
      this._labels.get(hex)?.el.classList.remove("flashing");
    }, FLASH_MS);
    this.map.triggerRepaint();
  }

  // Mercator [x, y, z] for a position at an altitude in feet.
  _anchor({ position, altitude }) {
    const c = MercatorCoordinate.fromLngLat(position, Math.max(altitude ?? 0, 0) * FEET_TO_METERS);
    return [c.x, c.y, c.z];
  }

  _placeHighlight(matrix) {
    const canvas = this.map.getCanvas();
    for (const flash of this._flashes.values()) {
      const point = this._project(matrix, flash.anchor);
      const visible = point &&
        point[0] >= 0 && point[0] <= canvas.clientWidth &&
        point[1] >= 0 && point[1] <= canvas.clientHeight;
      flash.el.hidden = !visible;
      if (visible) flash.el.style.transform = `translate(${point[0]}px, ${point[1]}px)`;
    }

    if (!this._highlight || !this._highlightEl) return;
    const point = this._project(matrix, this._highlight.anchor);
    const margin = 16;
    // Behind the camera or off-screen: pin the marker to the nearest edge.
    const x = point ? point[0] : canvas.clientWidth / 2;
    const y = point ? point[1] : canvas.clientHeight - margin;
    const clampedX = Math.min(Math.max(x, margin), canvas.clientWidth - margin);
    const clampedY = Math.min(Math.max(y, margin), canvas.clientHeight - margin);
    this._highlightEl.classList.toggle("offscreen", !point || clampedX !== x || clampedY !== y);
    this._highlightEl.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
  }

  _placeLabels(matrix) {
    this._placeHighlight(matrix);
    for (const [hex, label] of this._labels) {
      const point = this._project(matrix, label.anchor);
      label.el.hidden = !point;
      if (point) {
        label.el.style.transform =
          `translate(${point[0] + LABEL_OFFSET_PX}px, ${point[1]}px) translateY(-50%)`;
      }
      // Keep the popup attached to the plane rather than its ground position.
      if (hex === this._popupHex && this._popup?.isOpen() && point) {
        const ground = this.map.project(this._popup.getLngLat());
        this._popup.setOffset([point[0] - ground.x, point[1] - ground.y - 16]);
      }
    }
  }

  _showPopup(hex) {
    const plane = this._tracker?.aircraft.get(hex);
    if (!plane?.position) {
      this._popup?.remove();
      return;
    }
    const [lon, lat] = plane.position;
    const html = `
      <strong>${plane.callsign || "Unknown callsign"}</strong> <small>${plane.hex}</small><br>
      Altitude: ${formatAltitude(plane.altitude)}<br>
      Heading: ${plane.heading !== null ? Math.round(plane.heading) + "°" : "–"}<br>
      Speed: ${plane.speed ? plane.speed + " kt" : "–"}<br>
      Vertical rate: ${plane.vertRate ? plane.vertRate + " ft/min" : "–"}<br>
      Squawk: ${plane.squawk ?? "–"}<br>
      Position: ${lat.toFixed(4)}, ${lon.toFixed(4)}<br>
      Last seen: ${new Date(plane.lastSeen).toLocaleString()}<br>
      <a href="https://radar.planespotters.net/?icao=${plane.hex.toLowerCase()}" target="_blank" rel="noopener">View on Planespotters radar ↗</a>`;

    if (!this._popup) {
      this._popup = new maplibregl.Popup({ closeOnClick: false });
      this._popup.on("close", () => (this._popupHex = null));
    }
    this._popupHex = hex;
    this._popup.setLngLat(plane.position).setHTML(html);
    if (!this._popup.isOpen()) this._popup.addTo(this.map);
    this.map.triggerRepaint();
  }

  async update(tracker) {
    await this._ready;
    this._tracker = tracker;
    this._render();

    if (this._popupHex) this._showPopup(this._popupHex);

    const first = [...tracker.aircraft.values()].find((plane) => plane.position);
    if (this._followFirst && first) {
      this._followFirst = false;
      this.map.flyTo({ center: first.position, zoom: 8 });
    }
  }

  resize() {
    this.map.resize();
  }
}
