let readSamples = true;
import { Demodulator } from "./demodulator.js";
import { AircraftTracker } from "./aircraft.js";
import { AircraftMap } from "./map.js";
let button = document.querySelector("button");
let introSection = document.querySelector('.intro');
let mainSection = document.querySelector('.app');
let footer = document.querySelector('footer');
let waitingMessage = document.querySelector('.blink-me');
let started = false;
let msgReceived = false;

const demodulator = new Demodulator();
const tracker = new AircraftTracker();
let aircraftMap;

const MAP_UPDATE_MS = 1000;
const SAVE_INTERVAL_MS = 10000;

setInterval(() => tracker.save(), SAVE_INTERVAL_MS);
window.addEventListener("pagehide", () => tracker.save());

async function start() {
    const sdr = await RtlSdr.requestDevice();
    introSection.style.display = "none";
    footer.style.display = "none";
    mainSection.style.display = "block";

    // The receiver's location lets single position frames be decoded right away.
    navigator.geolocation?.getCurrentPosition(({ coords }) => {
        tracker.receiver = [coords.longitude, coords.latitude];
    });

    aircraftMap = new AircraftMap("map");
    aircraftMap.update(tracker);
    setInterval(() => aircraftMap.update(tracker), MAP_UPDATE_MS);

    await sdr.open({
        ppm: 0.5
    });

    const actualSampleRate = await sdr.setSampleRate(2000000);
    const actualCenterFrequency = await sdr.setCenterFrequency(1090000000);

    await sdr.resetBuffer();

    while (readSamples) {
        if (!started) {
            console.log('starting...')
            started = true
        }

        // const samples = await sdr.readSamples(16 * 16384);
        const samples = await sdr.readSamples(128000);
        // console.log(samples)

        const data = new Uint8Array(samples);
        // console.log(data)

        demodulator.process(data, 256000, onMsg)
    }
}

const onMsg = (msg) => {
    if (!msgReceived) {
        waitingMessage.style.display = "none";
        msgReceived = true;
    }
    const plane = tracker.update(msg);
    if (plane?.position) aircraftMap?.flash(plane);
    displayAircraftData(msg, plane);
}


// Show messages as they arrive. Hundreds can arrive per second, so they're
// queued and written to the DOM once per animation frame, keeping only the
// most recent lines.
const MAX_LOG_LINES = 200;
const dataElement = document.querySelector('.data');
let pendingLines = [];
let flushScheduled = false;
let messageCount = 0;
const lineTargets = new WeakMap(); // log line element → { hex, position, altitude }
let hoveredLine = null;
let followLog = true;

// Hovering a line marks the related aircraft position on the map.
dataElement.addEventListener('mouseover', event => {
    const line = event.target.closest('.data > div');
    if (line === hoveredLine) return;
    hoveredLine?.classList.remove('hovered');
    hoveredLine = line;
    line?.classList.add('hovered');
    aircraftMap?.highlight(line && lineTargets.get(line));
});
dataElement.addEventListener('mouseleave', () => {
    hoveredLine?.classList.remove('hovered');
    hoveredLine = null;
    aircraftMap?.highlight(null);
    flushLog();
});
// Stop auto-scrolling while the user scrolls back through the log.
dataElement.addEventListener('scroll', () => {
    followLog = dataElement.scrollTop + dataElement.clientHeight >= dataElement.scrollHeight - 4;
});

const displayAircraftData = (msg, plane) => {
    messageCount++;
    const fields = Object.entries(msg)
        .filter(([key, value]) => key !== 'msg' && value !== null && value !== '')
        .map(([key, value]) => `${key}: ${value}`);
    pendingLines.push({
        text: `${new Date().toLocaleTimeString()} ${fields.join(', ')}`,
        // Where the aircraft was when this message arrived, for hovering.
        target: plane?.position && {
            hex: plane.hex,
            position: plane.position,
            altitude: plane.altitude,
        },
    });
    // Animation frames pause in background tabs; don't let the queue grow.
    if (pendingLines.length > MAX_LOG_LINES) pendingLines.shift();
    if (!flushScheduled) {
        flushScheduled = true;
        requestAnimationFrame(flushLog);
    }
}

const flushLog = () => {
    flushScheduled = false;
    // Pause while hovering so lines don't shift under the pointer; the newest
    // lines are kept in pendingLines and shown when the pointer leaves.
    if (hoveredLine) return;
    const fragment = document.createDocumentFragment();
    for (const { text, target } of pendingLines) {
        const div = document.createElement('div');
        div.textContent = text;
        if (target) {
            div.className = 'has-location';
            lineTargets.set(div, target);
        }
        fragment.appendChild(div);
    }
    pendingLines = [];
    dataElement.appendChild(fragment);
    while (dataElement.childElementCount > MAX_LOG_LINES) dataElement.firstChild.remove();
    if (followLog) dataElement.scrollTop = dataElement.scrollHeight;
}

// Message rate, so it's clear how fast data is really coming in.
const rateElement = document.createElement('p');
rateElement.className = 'rate';
dataElement.before(rateElement);
setInterval(() => {
    rateElement.textContent = `${messageCount} msg/s${hoveredLine ? ' · paused while hovering' : ''}`;
    messageCount = 0;
}, 1000);

button.onclick = () => start();