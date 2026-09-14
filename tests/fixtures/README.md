# Signal recordings

Put files exported from the app here (signal panel → **Export messages** or **Export buffer**). `node --test` replays each one through the current decoder:

- messages that decoded cleanly when exported must still decode identically;
- repaired messages must not decode to different content;
- the test output summarises how repairs changed (`newlyRepaired`, `lostRepair`, `stillCorrupt`, …), to compare decoder changes against real signals.
