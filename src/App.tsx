import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  For,
  Show,
} from "solid-js";
import Peer from "peerjs";
import type { DataConnection, MediaConnection } from "peerjs";
import {
  putChunk,
  putStream,
  listStreams,
  getChunkBlobs,
  deleteStream,
  type StreamMeta,
  type StreamId,
} from "./idb.ts";

// Chromium does webm/opus; Firefox does ogg/opus. Same codec, pick the supported container.
const MIME =
  ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"].find(
    (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
  ) ?? "";
const SUPPORTED = MIME !== "";
const CONTAINER = MIME.includes("webm") ? "audio/webm" : "audio/ogg";
const EXT = MIME.includes("webm") ? "webm" : "ogg";
const TIMESLICE_MS = 5000;
const BITRATE = 64000;

type Msg =
  | { type: "hello"; username: string }
  | { type: "started" }
  | { type: "sync"; offsetMs: number };

function fmtBytes(n: number): string {
  return n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

// ponytail: triple-beep via oscillator, no asset file.
function beep(): void {
  const ctx = new AudioContext();
  for (const t of [0, 0.18, 0.36]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.2;
    osc.start(ctx.currentTime + t);
    osc.stop(ctx.currentTime + t + 0.12);
  }
}

export default function App() {
  const params = new URLSearchParams(location.search);
  const [username, setUsername] = createSignal(
    localStorage.getItem("username") ?? "",
  );
  const [lobbyId, setLobbyId] = createSignal(params.get("lobby") ?? "");
  const [mode, setMode] = createSignal<"idle" | "connecting" | "incall">(
    "idle",
  );
  const [isHost, setIsHost] = createSignal(false);
  const [hostUrl, setHostUrl] = createSignal("");
  const [streams, setStreams] = createSignal<StreamMeta[]>([]);
  const [headroom, setHeadroom] = createSignal("");

  const [ownRecording, setOwnRecording] = createSignal(false);
  const [micLive, setMicLive] = createSignal(true);
  const [writeFailed, setWriteFailed] = createSignal(false);

  let dialogRef!: HTMLDialogElement;
  const [dialogMsg, setDialogMsg] = createSignal("");
  const showError = (m: string) => {
    setDialogMsg(m);
    dialogRef.showModal();
  };

  // Non-reactive call refs (Solid runs the component body once).
  let peer: Peer | undefined;
  let dataConn: DataConnection | undefined;
  let mediaConn: MediaConnection | undefined;
  let localStream: MediaStream | undefined;
  let remoteStream: MediaStream | undefined;
  let recorders: MediaRecorder[] = [];
  let callId = 0;
  let t0 = 0;
  let peerUsername = "";
  let started = false;

  // ponytail: local-only health — the remote convenience copy never trips the alarm.
  const critical = createMemo(() => {
    if (mode() !== "incall") return "";
    if (writeFailed())
      return "THIS CALL IS NOT BEING SAVED — storage write failed. Download + delete recordings, or end the call.";
    if (!ownRecording())
      return "THIS CALL IS NOT BEING RECORDED — recorder stopped.";
    if (!micLive()) return "THIS CALL IS NOT BEING RECORDED — microphone lost.";
    return "";
  });
  let wasCritical = false;
  createEffect(() => {
    const c = critical();
    if (c && !wasCritical) beep();
    wasCritical = c !== "";
  });

  const rows = createMemo(() =>
    [...streams()].sort(
      (a, b) => b.callId - a.callId || a.streamId.localeCompare(b.streamId),
    ),
  );

  const refresh = async () => setStreams(await listStreams());
  const readHeadroom = async () => {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    setHeadroom(`${fmtBytes(quota - usage)} free`);
  };

  onMount(() => {
    refresh();
    readHeadroom();
    const iv = setInterval(readHeadroom, 15000);
    onCleanup(() => clearInterval(iv));
  });

  function sendMsg(m: Msg): void {
    dataConn?.send(m);
  }

  function startRecorder(
    stream: MediaStream,
    streamId: StreamId,
    uname: string,
    offsetMs: number,
  ): void {
    putStream({ callId, streamId, username: uname, offsetMs }).then(refresh);
    const rec = new MediaRecorder(stream, {
      mimeType: MIME,
      audioBitsPerSecond: BITRATE,
    });
    let seq = 0;
    rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      putChunk(callId, streamId, seq++, e.data).catch(() =>
        setWriteFailed(true),
      );
    };
    if (streamId === "self") {
      rec.onstart = () => setOwnRecording(true);
      rec.onstop = () => setOwnRecording(false);
      rec.onerror = () => setOwnRecording(false);
    }
    rec.start(TIMESLICE_MS);
    recorders.push(rec);
  }

  async function beginRecording(): Promise<void> {
    await navigator.storage.persist();
    callId = Date.now();
    t0 = performance.now();
    setWriteFailed(false);
    // Own canonical track: host = 0, joiner gets N from host later.
    startRecorder(localStream!, "self", username(), 0);
    // Remote convenience copy: joiner's copy of host = 0; host's copy of joiner gets N later.
    startRecorder(remoteStream!, "peer", peerUsername, 0);

    const track = localStream!.getAudioTracks()[0];
    setMicLive(track.readyState === "live" && !track.muted);
    track.onended = () => setMicLive(false);
    track.onmute = () => setMicLive(false);
    track.onunmute = () => setMicLive(true);

    setMode("incall");
    if (!isHost()) sendMsg({ type: "started" });
  }

  function tryStart(): void {
    if (started || !remoteStream || !peerUsername || !dataConn) return;
    started = true;
    beginRecording();
  }

  function setOffset(streamId: StreamId, offsetMs: number): void {
    const uname = streamId === "self" ? username() : peerUsername;
    putStream({ callId, streamId, username: uname, offsetMs }).then(refresh);
  }

  function handleMsg(m: Msg): void {
    if (m.type === "hello") {
      peerUsername = m.username;
      tryStart();
    } else if (m.type === "started" && isHost()) {
      const n = t0 ? Math.round(performance.now() - t0) : 0;
      setOffset("peer", n); // host's convenience copy of the joiner
      sendMsg({ type: "sync", offsetMs: n });
    } else if (m.type === "sync" && !isHost()) {
      setOffset("self", m.offsetMs); // joiner's own canonical track
    }
  }

  function wireData(conn: DataConnection): void {
    dataConn = conn;
    conn.on("open", () => sendMsg({ type: "hello", username: username() }));
    conn.on("data", (d) => handleMsg(d as Msg));
    conn.on("close", endCall);
  }

  function wireMedia(conn: MediaConnection): void {
    mediaConn = conn;
    conn.on("stream", (s) => {
      remoteStream = s;
      tryStart();
    });
    conn.on("close", endCall);
  }

  function onPeerError(err: { type: string }): void {
    const messages: Record<string, string> = {
      "peer-unavailable":
        "No call found with that ID. Check the link or ID and try again.",
      network: "Couldn't reach the signaling server. Try again.",
      "server-error": "Couldn't reach the signaling server. Try again.",
      "socket-error": "Connection error. Try again.",
      "unavailable-id": "That ID is taken. Refresh and try again.",
    };
    showError(messages[err.type] ?? "Connection error. Try again.");
    endCall();
  }

  function resetCall(): void {
    remoteStream = undefined;
    peerUsername = "";
    started = false;
    recorders = [];
    t0 = 0;
  }

  async function getMic(action: string): Promise<MediaStream | undefined> {
    localStorage.setItem("username", username());
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      showError(`Microphone access is required to ${action} a call.`);
      return undefined;
    }
  }

  async function host(): Promise<void> {
    const stream = await getMic("host");
    if (!stream) return;
    localStream = stream;
    setIsHost(true);
    resetCall();
    setMode("connecting");
    peer = new Peer();
    peer.on("open", (id) =>
      setHostUrl(`${location.origin}${location.pathname}?lobby=${id}`),
    );
    peer.on("error", onPeerError);
    peer.on("connection", wireData);
    peer.on("call", (conn) => {
      conn.answer(localStream);
      wireMedia(conn);
    });
  }

  async function join(): Promise<void> {
    const stream = await getMic("join");
    if (!stream) return;
    localStream = stream;
    setIsHost(false);
    resetCall();
    setMode("connecting");
    const id = lobbyId().trim();
    peer = new Peer();
    peer.on("error", onPeerError);
    peer.on("open", () => {
      wireData(peer!.connect(id));
      wireMedia(peer!.call(id, localStream!));
    });
  }

  function endCall(): void {
    recorders.forEach((r) => {
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    });
    recorders = [];
    localStream?.getTracks().forEach((t) => t.stop());
    mediaConn?.close();
    dataConn?.close();
    peer?.destroy();
    peer = dataConn = mediaConn = localStream = undefined;
    setOwnRecording(false);
    setMode("idle");
    refresh();
  }

  async function download(s: StreamMeta): Promise<void> {
    const url = URL.createObjectURL(
      new Blob(await getChunkBlobs(s.callId, s.streamId), {
        type: CONTAINER,
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.username}_${s.offsetMs}ms.${EXT}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const remove = async (s: StreamMeta) => {
    await deleteStream(s.callId, s.streamId);
    refresh();
  };

  if (!SUPPORTED) {
    return (
      <main>
        <h1>call</h1>
        <p>This app needs Chrome, Edge, Brave, or Firefox.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>call</h1>

      <Show when={critical()}>
        <p role="alert">
          <strong>{critical()}</strong>
        </p>
      </Show>

      <Show when={mode() === "idle"}>
        <article>
          <form onSubmit={(e) => (e.preventDefault(), host())}>
            <fieldset>
              <legend>Host a call</legend>
              <label>
                Your name
                <input
                  required
                  value={username()}
                  onInput={(e) => setUsername(e.currentTarget.value)}
                />
              </label>
              <button>Host</button>
            </fieldset>
          </form>
        </article>
        <hr />
        <article>
          <form onSubmit={(e) => (e.preventDefault(), join())}>
            <fieldset>
              <legend>Join a call</legend>
              <label>
                Your name
                <input
                  required
                  value={username()}
                  onInput={(e) => setUsername(e.currentTarget.value)}
                />
              </label>
              <label>
                Call ID
                <input
                  required
                  value={lobbyId()}
                  onInput={(e) => setLobbyId(e.currentTarget.value)}
                />
              </label>
              <button>Join</button>
            </fieldset>
          </form>
        </article>
      </Show>

      <Show when={mode() === "connecting"}>
        <Show when={isHost()} fallback={<p>Connecting…</p>}>
          <p>Share this link, then wait for the other person to join:</p>
          <input readonly value={hostUrl()} size={60} />{" "}
          <button onClick={() => navigator.clipboard.writeText(hostUrl())}>
            Copy link
          </button>
          <p>Waiting…</p>
        </Show>
        <button onClick={endCall}>Cancel</button>
      </Show>

      <Show when={mode() === "incall"}>
        <p>In call with {peerUsername || "…"}.</p>
        <button onClick={endCall}>End call</button>
      </Show>

      <p>{headroom()}</p>

      <Show when={rows().length > 0}>
        <table>
          <thead>
            <tr>
              <th>Call</th>
              <th>Speaker</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(s) => (
                <tr>
                  <td>{new Date(s.callId).toLocaleString()}</td>
                  <td>{s.username}</td>
                  <td>
                    <button onClick={() => download(s)}>Download</button>
                  </td>
                  <td>
                    <button onClick={() => remove(s)}>Delete</button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <dialog ref={dialogRef}>
        <form method="dialog">
          <p>{dialogMsg()}</p>
          <button>OK</button>
        </form>
      </dialog>
    </main>
  );
}
