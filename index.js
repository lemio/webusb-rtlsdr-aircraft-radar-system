let readSamples = true;
import { Demodulator } from "./demodulator.js";
import { AircraftTracker } from "./aircraft.js";
import { AircraftMap } from "./map.js";
import { MessageTable } from "./messages.js";
import { SignalView } from "./signal.js";
let button = document.querySelector("button");
let introSection = document.querySelector('.intro');
let mainSection = document.querySelector('.app');
let footer = document.querySelector('footer');
let waitingMessage = document.querySelector('.blink-me');
let started = false;
let msgReceived = false;

const demodulator = new Demodulator();
const DETECTOR_KEY = "detector";
try {
    const saved = localStorage.getItem(DETECTOR_KEY);
    if (["hybrid", "classic", "tolerant"].includes(saved)) demodulator.detector = saved;
} catch {}
const tracker = new AircraftTracker();
let aircraftMap;

const MAP_UPDATE_MS = 1000;
const SAVE_INTERVAL_MS = 10000;

setInterval(() => tracker.save(), SAVE_INTERVAL_MS);
window.addEventListener("pagehide", () => tracker.save());

async function start() {
    const sdr = await RtlSdr.requestDevice();
    // Otherwise the spacebar (pause) would press the connect button again.
    button.blur();
    introSection.style.display = "none";
    footer.style.display = "none";
    mainSection.style.display = "flex";

    // The receiver's location lets single position frames be decoded right away.
    navigator.geolocation?.getCurrentPosition(({ coords }) => {
        tracker.receiver = [coords.longitude, coords.latitude];
    });

    aircraftMap = new AircraftMap("map");
    aircraftMap.map.on("rotate", () => messageTable.setBearing(aircraftMap.map.getBearing()));
    aircraftMap.update(tracker);
    setInterval(() => {
        if (!paused) aircraftMap.update(tracker);
    }, MAP_UPDATE_MS);

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

        // Collect this buffer's messages (valid and corrupt) for the signal
        // view. readSamples counts samples, so the buffer holds 256000 bytes.
        const bufferMessages = [];
        demodulator.process(data, data.length, msg => {
            bufferMessages.push(msg);
            onMsg(msg);
        }, msg => {
            if (!CHECKED_FORMATS.includes(msg.msgtype)) return;
            bufferMessages.push(msg);
            onCorrupt(msg);
        });
        signalView.push(data, bufferMessages);
    }
}

// Formats whose checksum can be verified on its own. Other formats XOR the
// parity with the aircraft address, so a failure there usually just means the
// aircraft hasn't been seen yet, not that the message is corrupt.
const CHECKED_FORMATS = [11, 17, 18];

// Corrupt messages are listed, but never reach the tracker or the map.
const onCorrupt = (msg) => {
    corruptCount++;
    messageTable.add(msg, null);
}

const onMsg = (msg) => {
    if (!msgReceived) {
        waitingMessage.style.display = "none";
        msgReceived = true;
    }
    const plane = tracker.update(msg);
    msg.target = plane?.position && { hex: plane.hex, position: plane.position, altitude: plane.altitude };
    if (plane?.position && !paused) aircraftMap?.flash(plane);
    messageCount++;
    messageTable.add(msg, plane);
}


const messageTable = new MessageTable(document.querySelector('.data'), {
    // Hovering a row marks the aircraft on the map and shows the message's
    // signal underneath.
    onHover: (target, msg) => {
        aircraftMap?.highlight(target);
        signalView.showMessage(msg);
    },
    // The chevron locks the message in the signal view.
    onLock: msg => signalView.lock(msg),
});
let messageCount = 0;
let corruptCount = 0;

const signalView = new SignalView(document.querySelector('#signal'), {
    // Hovering a message in the signal marks its aircraft on the map and its
    // messages in the table.
    onHover: msg => {
        aircraftMap?.highlight(msg?.target);
        messageTable.focusMessage(msg, ['icao']);
    },
    // Hovering a bit, byte or field highlights its meaning in the table.
    onField: (msg, columns) => messageTable.focusMessage(msg, columns),
    // Keep the table still while inspecting the signal.
    onFreeze: frozen => messageTable.hold('signal', frozen),
    // The table marks the row of the shown message with a chevron.
    onShow: (msg, locked) => messageTable.markShown(msg, locked),
    // Locking a message pauses everything; releasing it goes live.
    onLock: () => setPaused(true),
    onUnlock: () => setPaused(false),
    // Message detection can be switched live, to compare.
    onDetector: detector => {
        demodulator.detector = detector;
        try { localStorage.setItem(DETECTOR_KEY, detector); } catch {}
    },
});

signalView.setDetector(demodulator.detector);

// Message rate, so it's clear how fast data is really coming in.
const statusBar = document.createElement('div');
statusBar.className = 'status-bar';
const rateElement = document.createElement('p');
rateElement.className = 'rate';
const resetButton = document.createElement('button');
resetButton.className = 'reset-button';
resetButton.textContent = 'Reset';
resetButton.title = 'Clear all aircraft, trails, saved history, messages and signals';
resetButton.onclick = () => reset();
statusBar.append(rateElement, resetButton);
document.querySelector('.data').before(statusBar);
setInterval(() => {
    rateElement.textContent = `${messageCount} msg/s` +
        (corruptCount ? ` · ${corruptCount} corrupt` : '') +
        (paused ? ' · paused' : messageTable.paused ? ' · held' : ' · space to pause');
    messageCount = 0;
    corruptCount = 0;
}, 1000);

// Reset: start over with an empty map, table and signal view. Reception keeps
// running, settings (like the detector) are kept.
function reset() {
    if (!confirm('Clear all aircraft, trails, saved history, messages and signals?')) return;
    setPaused(false);
    tracker.reset();
    demodulator.reset();
    messageTable.reset();
    signalView.reset();
    aircraftMap?.reset(tracker);
    messageCount = 0;
    corruptCount = 0;
    resetButton.blur(); // So the spacebar pauses instead of pressing it again.
}

// Global pause (spacebar): freezes the table, the signal view and the map so
// they can be read. Reception and tracking continue; views catch up on resume.
let paused = false;
const pauseBadge = document.createElement('button');
pauseBadge.className = 'pause-badge';
pauseBadge.textContent = 'Paused · press space to resume';
pauseBadge.hidden = true;
pauseBadge.onclick = () => setPaused(false);
mainSection.appendChild(pauseBadge);

// Space (or releasing a lock) goes back to live mode.
function setPaused(value) {
    paused = value;
    if (!paused) signalView.unlock();
    pauseBadge.hidden = !paused;
    messageTable.hold('pause', paused);
    signalView.setPaused(paused);
    if (!paused) aircraftMap?.update(tracker);
}

document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || !aircraftMap) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    setPaused(!paused);
});

button.onclick = () => start();