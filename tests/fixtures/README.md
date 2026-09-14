# Signal recordings

Put files exported from the app here (signal panel → **Export messages** or **Export buffer**). `node --test` replays each one through the current decoder:

- messages that decoded cleanly when exported must still decode identically;
- repaired messages must not decode to different content;
- the test output summarises how repairs changed (`newlyRepaired`, `lostRepair`, `stillCorrupt`, …), to compare decoder changes against real signals.

Raw recordings (`*.bin`, uint8 I/Q at 2 Msps) can go here too: signal panel → **Record 10 s**, or `rtl_sdr -f 1090000000 -s 2000000 -n 20000000 recording.bin`. They are replayed through the classic and hybrid detectors; the hybrid detector must keep every message the classic one decodes, and the test output shows how many extra messages it finds. Recordings are large (4 MB per second), so consider keeping them out of git.
