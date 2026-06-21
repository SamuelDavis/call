# call

Browser-based 2-person phone call with per-speaker local recording, for syncing in a DAW later.

## Non-negotiables
- Unstyled, semantic HTML. Defer to the browser for everything it already does (form validation, `<dialog>`, downloads, clipboard).
- Minimal, type-safe code. Few files (`App.tsx` + `idb.ts`), few components, flat signals.
- Chromium-only (Chrome/Edge/Brave). WebM/Opus assumed; one capability check, no fallback path.
- **Recoverability is paramount.** Each person's own mic is recorded locally and persisted; nothing the network does can corrupt it.

## Architecture
- SolidJS SPA, PeerJS on the public broker. Strictly 2-party, one media connection.
- No router. One screen; a `mode` signal (`idle | connecting | incall`) decides what renders.

## Flow
1. Host and Join forms render together. Username (required, persisted to `localStorage`, pre-filled). Join also takes a Call ID, pre-filled from `?lobby=<id>`. No auto-join.
2. Submit -> `getUserMedia({audio:true})` **gate**. Denied -> error `<dialog>`, never touch PeerJS. The one mic stream is both sent audio and own recording.
3. Host shows a copyable full URL (`origin + path + ?lobby=<peerId>`). Joiner calls + connects.
4. Errors (peer-unavailable, network, etc.) -> single `peer.on('error')` handler -> `<dialog>`. Clean disconnect = call end, not an error.

## Recording (local-first)
- Both recorders start at connect: **own mic** (canonical) + **remote stream** (convenience copy, no drop handling).
- 64 kbps Opus/WebM, 5s timeslice. Chunks written straight to IndexedDB (`persist()` first). Memory stays flat.
- A call = one connected session. Drop / End Call stops everything; a new recording needs a new call. Download is a non-stopping snapshot.

## Sync
- Host is the clock. Host's own offset = 0. Joiner sends `started` when it begins recording; host computes `N = now - t0` and sends it back. Joiner labels its own file with `N`.
- Filenames: `username_offsetms.webm`. Slide track 2 forward by `N` ms in the DAW. Accurate to ~data-channel latency; drift/sample-accuracy ignored (conversational audio).

## Storage & safety
- Two IndexedDB stores: `chunks` (`[callId, streamId, seq]` -> Blob) and `streams` (`[callId, streamId]` -> metadata). Signals hold only the metadata rows; Blobs stay in IndexedDB until download.
- Recordings persist across calls. **User-only deletion**, per row. Live headroom readout from `estimate()`.
- One local `recordingHealthy` check (own recorder running + mic live + writes succeeding). Any critical failure -> big non-modal `role="alert"` banner + one-shot triple-beep. Remote convenience copy never triggers it.

## UI
- One streams table, newest-first, one row per stream, per-row Download + Delete. Live call = its 2 newest rows. No separate lobby/recordings views.
