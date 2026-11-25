// Ambient types for checking the Worker (npm run check:
// tsconfig.worker.json): the runtime's modules and globals. Not deployed.

// Text modules (wrangler.toml's Text rule): the data files, the agent
// recipe and its watcher script.
declare module "*.txt" { const text: string; export default text; }
declare module "*.md" { const text: string; export default text; }
declare module "*.sh" { const text: string; export default text; }

declare module "cloudflare:workers" {
  export class DurableObject {
    constructor(ctx: DurableObjectState, env: Env);
    ctx: DurableObjectState;
    env: Env;
  }
}

// A Workers runtime stream that knows its length up front.
declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number | bigint);
}

// The Worker's bindings and variables (wrangler.toml, the dashboard's
// secrets; AGENTS.md section 2, Bindings and variables). Secrets and
// optional variables may be unset, so they are string | undefined.
interface Env {
  ROOM: DurableObjectNamespace;
  REQUESTS: KVNamespace;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  OWNER_KEY?: string;
  CARTESIA_API_KEY?: string;
  GMAIL_SA?: string;
  GMAIL_SENDER?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ANTHROPIC_API_KEY?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_DIRECT?: string;
  TEST_HOOKS?: string;
  /** the Muse bridge's MuseLink objects, one per linked Muse (worker/bridge/link.ts) */
  MUSE_LINK: DurableObjectFetchNamespace;
  /** the Muse bridge's one Directory object (worker/bridge/directory.ts) */
  MUSE_DIRECTORY: DurableObjectFetchNamespace;
  /** base64 of the raw 32-byte X25519 private key the gadget seals its Muse token to; unset, /api/muse/seal-key, /connect and /update answer 503 not_configured */
  MUSE_SEAL_KEY?: string;
  /** "1" pauses Muse wakes (the bridge's /deliver answers 503 paused with Retry-After; rooms keep them queued) */
  MUSE_DELIVER_PAUSED?: string;
  /** test only, with TEST_HOOKS: the API suite's fake Muse (http://127.0.0.1:PORT), where the bridge's calls to Muse hosts go (worker/bridge/util.ts museFetch) */
  TEST_MUSE_ORIGIN?: string;
}

// What the Muse bridge's code (worker/bridge) reads from the env: the chat
// Worker's Env passes as one, and the bridge's tests (tests/bridge) build
// one with Durable Objects on node:sqlite.
type BridgeEnv = Pick<Env, "MUSE_LINK" | "MUSE_DIRECTORY" | "MUSE_SEAL_KEY" | "MUSE_DELIVER_PAUSED" | "TEST_HOOKS" | "TEST_MUSE_ORIGIN">;

// The parts of the Workers runtime the Worker uses, after
// @cloudflare/workers-types (not a dependency: only what the code calls).

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// Workers' WebCrypto takes any ArrayBufferView as bytes; TypeScript's lib
// takes only views of an ArrayBuffer. The Muse bridge's Noise and seal code
// (worker/bridge, ported against the Workers types) hands it plain
// Uint8Arrays, so these overloads say what the runtime accepts.
type WorkersBytes = ArrayBuffer | ArrayBufferView;

interface WorkersAesGcmParams {
  name: "AES-GCM";
  iv: WorkersBytes;
  additionalData?: WorkersBytes;
  tagLength?: number;
}

interface SubtleCrypto {
  importKey(format: "raw" | "pkcs8" | "spki", keyData: WorkersBytes, algorithm: AlgorithmIdentifier | HmacImportParams, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
  sign(algorithm: AlgorithmIdentifier, key: CryptoKey, data: WorkersBytes): Promise<ArrayBuffer>;
  digest(algorithm: AlgorithmIdentifier, data: WorkersBytes): Promise<ArrayBuffer>;
  encrypt(algorithm: WorkersAesGcmParams, key: CryptoKey, data: WorkersBytes): Promise<ArrayBuffer>;
  decrypt(algorithm: WorkersAesGcmParams, key: CryptoKey, data: WorkersBytes): Promise<ArrayBuffer>;
}

// Workers' outbound WebSocket: fetch() with "Upgrade: websocket" answers a
// Response holding the socket, which the caller accepts before using it
// (the bridge's wake, workersWebSocketFactory in worker/bridge/muse/session.ts).
interface Response {
  readonly webSocket: WebSocket | null;
}

interface WebSocket {
  accept(): void;
  send(message: WorkersBytes | string): void;
}

/** What the Worker's fetch handler gets beside the request and env. */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expiration?: number; expirationTtl?: number }): Promise<void>;
}

// DurableObjectStub (the Room's methods over RPC, each returning a
// promise) is declared with the Room in types/room-methods.d.ts.

interface DurableObjectId {
  readonly name?: string;
  toString(): string;
  equals(other: DurableObjectId): boolean;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** A namespace whose objects are reached through fetch alone: the Muse
 *  bridge's MuseLink and Directory answer internal routes (callDo in
 *  worker/bridge/util.ts), not RPC methods. */
interface DurableObjectFetchNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): Fetcher;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
  /** resets the object: its memory goes, its storage stays (the API suite's restart hook) */
  abort(reason?: string): void;
}

interface DurableObjectStorage {
  readonly sql: SqlStorage;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

type SqlStorageValue = ArrayBuffer | string | number | null;

/** A row as SQLite returns it: column name to value. */
type SqlStorageRow = Record<string, SqlStorageValue>;

/** A query's rows. Their shape depends on the query text: name it at the
 *  call, `sql.exec<Pick<InvRow, "name">>(...)`, the one place the Worker
 *  asserts a row type (as Cloudflare's own SqlStorage types do). A query
 *  read without one gives plain rows of SQL values, never any. */
interface SqlStorageCursor<T = SqlStorageRow> {
  next(): IteratorResult<T>;
  toArray(): T[];
  one(): T;
  raw(): IterableIterator<SqlStorageValue[]>;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  [Symbol.iterator](): IterableIterator<T>;
}

interface SqlStorage {
  // No constraint on T (Cloudflare's has one): the contract's row types
  // are interfaces, which an index-signature constraint would refuse.
  exec<T = SqlStorageRow>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  readonly databaseSize: number;
}

/** A byte range: R2 reads take offset + length (or a suffix length). */
interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

interface R2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly range?: R2Range;
  writeHttpMetadata(headers: Headers): void;
}

interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

interface R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(uploadedParts: R2UploadedPart[]): Promise<R2Object>;
}

interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
}

interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range?: R2Range | Headers }): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { limit?: number; prefix?: string; cursor?: string; delimiter?: string }): Promise<R2Objects>;
  createMultipartUpload(key: string, options?: R2PutOptions): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

