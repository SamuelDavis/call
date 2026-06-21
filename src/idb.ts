// IndexedDB: audio chunks live here so memory stays flat; signals only hold metadata.

export type StreamId = "self" | "peer";

export type StreamMeta = {
  callId: number;
  streamId: StreamId;
  username: string;
  offsetMs: number;
};

type ChunkRow = { callId: number; streamId: StreamId; seq: number; blob: Blob };

const DB_NAME = "call";
const VERSION = 1;

let dbp: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("chunks", { keyPath: ["callId", "streamId", "seq"] });
      d.createObjectStore("streams", { keyPath: ["callId", "streamId"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function request<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// ponytail: array key [callId, streamId, []] sorts after any numeric seq, so this range = all chunks of one stream.
function streamRange(callId: number, streamId: StreamId): IDBKeyRange {
  return IDBKeyRange.bound([callId, streamId], [callId, streamId, []]);
}

export function putChunk(callId: number, streamId: StreamId, seq: number, blob: Blob): Promise<unknown> {
  const row: ChunkRow = { callId, streamId, seq, blob };
  return request("chunks", "readwrite", (s) => s.put(row));
}

export function putStream(meta: StreamMeta): Promise<unknown> {
  return request("streams", "readwrite", (s) => s.put(meta));
}

export function listStreams(): Promise<StreamMeta[]> {
  return request<StreamMeta[]>("streams", "readonly", (s) => s.getAll());
}

export async function getChunkBlobs(callId: number, streamId: StreamId): Promise<Blob[]> {
  const rows = await request<ChunkRow[]>("chunks", "readonly", (s) => s.getAll(streamRange(callId, streamId)));
  return rows.map((r) => r.blob);
}

export async function deleteStream(callId: number, streamId: StreamId): Promise<void> {
  await request("chunks", "readwrite", (s) => s.delete(streamRange(callId, streamId)));
  await request("streams", "readwrite", (s) => s.delete([callId, streamId]));
}
