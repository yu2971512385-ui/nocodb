import type {
  FactoryFile,
  FactoryFileDiff,
  FactoryFileEntry,
  FactoryPort,
  FactorySessionPatch,
  FactorySessionPatchParams,
} from 'nocodb-sdk';

/**
 * The wire between the backend and `nc-agent`, the daemon baked into every
 * compute image. Imported by both ends.
 *
 * One WebSocket. Text frames carry JSON control messages; binary frames carry
 * stream bytes (shell output, tunnel traffic) as `[u32 stream id][bytes]`,
 * where the stream id is the subscription's own id.
 *
 * Versioning, as `nc-gateway-protocol` does it. A machine keeps the agent its
 * image shipped with, so the backend talks to agents older than itself:
 *  - Additive changes (a new call, a new OPTIONAL field) do NOT bump the
 *    version; an older agent answers a call it lacks with `unsupported`.
 *  - Only breaking changes bump `AGENT_PROTOCOL`; the backend serves agents in
 *    [MIN, CURRENT] and branches on the protocol an agent reports. The agent
 *    keeps the old form too while backends on the previous protocol run (a
 *    rolling deploy), branching on the `x-nc-agent-protocol` they send.
 *  - Raise `AGENT_MIN_PROTOCOL` only to deliberately drop images that old.
 */

export const AGENT_PROTOCOL = 1;

export const AGENT_MIN_PROTOCOL = 1;

/**
 * The most file content one JSON call carries, VS Code's buffer size. A JSON
 * frame holds the shared socket until it is sent, so anything bigger goes as
 * an `fs.download` / `fs.upload` stream.
 */
export const MAX_CALL_BYTES = 256 * 1024;

/** Byte-stream chunk size: small enough to interleave with other traffic. */
export const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * The socket's permessage-deflate. Frames below the threshold go as they are;
 * byte streams of already-compressed data opt out per stream.
 */
export const AGENT_DEFLATE_THRESHOLD = 1024;

/** Files whose bytes are compressed already: a stream of them skips deflate. */
export const PRECOMPRESSED_FILE =
  /\.(png|jpe?g|gif|webp|avif|ico|mp3|mp4|m4a|webm|mov|ogg|zip|gz|tgz|br|zst|xz|bz2|7z|rar|jar|woff2?|pdf|docx|xlsx|pptx)$/i;

/** Clear of envd (49983) and any port a dev server picks by default. */
export const AGENT_PORT = 49990;

export const AGENT_TOKEN_HEADER = 'x-nc-agent-token';

export const AGENT_PROTOCOL_HEADER = 'x-nc-agent-protocol';

/**
 * The token the agent accepts, written by the backend after it creates or
 * resumes a machine: it is per deployment and per machine, so no image has it.
 */
export const AGENT_TOKEN_PATH = '/tmp/.nc-agent/token';

/**
 * Environment the machine was created with, as a JSON object: the provider
 * writes it beside the token, and the agent adds it to every process it starts.
 */
export const AGENT_ENV_PATH = '/tmp/.nc-agent/env.json';

export interface FsEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

export interface ExecArgs {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Kills the whole process group when it passes. */
  timeoutMs?: number;
  /** Bytes kept per stream; the rest is dropped from the middle. */
  maxOutput?: number;
  /** Written to stdin, which is then closed. */
  input?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface PtyInfo {
  id: string;
  pid: number;
  cols: number;
  rows: number;
  title?: string;
}

/** The screen as it stands, at the size it was drawn at. */
export interface PtyReplay {
  cols: number;
  rows: number;
  data: string;
}

export interface WatchChange {
  path: string;
  type: 'change' | 'rename';
}

/** Request → one result. */
export interface AgentCalls {
  'agent.info': {
    args: Record<string, never>;
    result: {
      version: string;
      protocol: number;
      pid: number;
      uptimeMs: number;
    };
  };

  'fs.list': {
    args: { path: string };
    result: { entries: FsEntry[] };
  };
  'fs.stat': {
    args: { path: string };
    result: {
      type: FsEntry['type'] | 'missing';
      size: number;
      mtimeMs: number;
    };
  };
  'fs.read': {
    args: { path: string; maxBytes?: number };
    result: FactoryFile;
  };
  /**
   * Atomic (temp file + rename), at most {@link MAX_CALL_BYTES}. `expectedHash`
   * is the hash a read returned: a file changed since fails with `conflict`;
   * `null` means it must not exist.
   */
  'fs.write': {
    args: {
      path: string;
      content: string;
      encoding?: 'utf8' | 'base64';
      expectedHash?: string | null;
      mode?: number;
    };
    result: { hash: string; size: number };
  };
  'fs.edit': {
    args: {
      path: string;
      edits: { oldText: string; newText: string; replaceAll?: boolean }[];
      expectedHash?: string;
    };
    result: {
      hash: string;
      size: number;
      replacements: number;
      /** 1-based line where the first edit's new text starts, if it has any. */
      startLine?: number;
    };
  };
  'fs.remove': {
    args: { path: string; recursive?: boolean };
    result: { ok: true };
  };
  'fs.mkdir': { args: { path: string }; result: { ok: true } };

  'search.grep': {
    args: {
      pattern: string;
      path: string;
      glob?: string;
      context?: number;
      limit: number;
      ignoreCase?: boolean;
    };
    /** `truncated`: the search timed out and `matches` is what it found by then. */
    result: { matches: string; error?: string; truncated?: boolean };
  };
  'search.glob': {
    args: { pattern: string; path: string; limit: number };
    result: { paths: string[]; truncated: boolean };
  };

  'exec.run': { args: ExecArgs; result: ExecResult };
  /** Detached, outliving the call; output goes to `logPath`, or nowhere. */
  'exec.start': {
    args: {
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      logPath?: string;
    };
    result: { pid: number };
  };

  'git.files': {
    args: { root: string; max: number };
    /** Changed files first; `truncated` (absent from older agents): more than `max` exist. */
    result: { entries: FactoryFileEntry[]; truncated?: boolean };
  };
  'git.diffFile': {
    args: { root: string; path: string };
    result: FactoryFileDiff;
  };
  'git.patch': {
    args: { root: string; params: FactorySessionPatchParams; maxBytes: number };
    result: FactorySessionPatch;
  };
  /**
   * The working tree, untracked files included, pinned at `ref` without touching
   * the index. On failure `ref` is left where it was: the caller clears it.
   */
  'git.snapshotRef': {
    args: { root: string; ref: string };
    result: { tree: string };
  };
  /** `git <args>` without a shell. */
  'git.exec': {
    args: {
      root: string;
      args: string[];
      timeoutMs?: number;
    };
    result: ExecResult;
  };

  'ports.list': {
    args: Record<string, never>;
    result: { ports: FactoryPort[] };
  };

  'pty.open': {
    args: {
      cols: number;
      rows: number;
      cwd?: string;
      env?: Record<string, string>;
    };
    result: PtyInfo;
  };
  'pty.resize': {
    args: { id: string; cols: number; rows: number };
    result: { ok: true };
  };
  'pty.kill': { args: { id: string }; result: { ok: true } };
  /** The live shells, without attaching: no replay, no orphan-timer reset. */
  'pty.list': {
    args: Record<string, never>;
    result: { ptys: { id: string; viewers: number }[] };
  };
}

/**
 * Subscriptions: a request whose answer is a stream of events until either
 * side ends it. Byte streams (`pty.attach`, `tunnel.open`) also carry binary
 * frames under the subscription id, in both directions.
 */
export interface AgentSubscriptions {
  'pty.attach': {
    args: { id: string };
    /** First event is always `replay`. */
    event:
      | { kind: 'replay'; replay: PtyReplay; info: PtyInfo }
      | { kind: 'exit'; exitCode?: number };
  };
  /**
   * A process with a live stdin: bytes written to the stream are its stdin,
   * `eof` closes it. Output comes as events, then `exit`; closing kills it.
   */
  'exec.spawn': {
    args: Omit<ExecArgs, 'maxOutput' | 'input'>;
    event:
      | { kind: 'out'; stream: 'stdout' | 'stderr'; data: string }
      | { kind: 'exit'; exitCode: number; timedOut: boolean };
  };
  'ports.watch': {
    args: Record<string, never>;
    event: { ports: FactoryPort[] };
  };
  'fs.watch': {
    args: { root: string };
    /** `git` when the repository's own state moved (commit, checkout, stage). */
    event: { changes: WatchChange[]; git?: boolean; overflow?: boolean };
  };
  'tunnel.open': {
    /** `compress: false` for a stream compressed already, such as VNC's. */
    args: { port: number; compress?: boolean };
    event: { kind: 'open' } | { kind: 'end'; error?: string };
  };
  /** A file's bytes as a stream, binary-safe and uncapped; `start` comes first. */
  'fs.download': {
    args: { path: string };
    event: { kind: 'start'; size: number };
  };
  /**
   * Bytes written to the stream become the file, created with its parents and
   * renamed into place on `eof`; `done` reports what landed. `expectedHash` is
   * checked as `fs.write` checks it, at the rename.
   */
  'fs.upload': {
    args: { path: string; mode?: number; expectedHash?: string | null };
    event: { kind: 'ready' } | { kind: 'done'; size: number; hash: string };
  };
}

export type AgentCallName = keyof AgentCalls;
export type AgentSubscriptionName = keyof AgentSubscriptions;

export type ClientFrame =
  | { t: 'call'; id: number; op: AgentCallName; args: unknown }
  | { t: 'sub'; id: number; op: AgentSubscriptionName; args: unknown }
  /** Ends a subscription, or cancels a call still running. */
  | { t: 'cancel'; id: number }
  /** Half-close a byte stream: no more bytes will be sent on it. */
  | { t: 'eof'; id: number }
  /** Flow control: the reader is full, stop sending bytes on this stream / go on. */
  | { t: 'pause'; id: number }
  | { t: 'resume'; id: number };

export type AgentFrame =
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: AgentErrorBody }
  | { t: 'ev'; id: number; event: unknown }
  | { t: 'end'; id: number; error?: AgentErrorBody }
  /** Flow control on an upload: the disk is behind, hold the bytes / go on. Older backends ignore it. */
  | { t: 'pause'; id: number }
  | { t: 'resume'; id: number };

export type AgentErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'too_large'
  | 'unavailable'
  | 'cancelled'
  | 'failed'
  /** A call or subscription this agent's protocol does not have. */
  | 'unsupported';

export interface AgentErrorBody {
  code: AgentErrorCode;
  message: string;
}

/** Binary frames: the first four bytes name the stream. */
export function encodeStreamFrame(id: number, data: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + data.byteLength);
  out.writeUInt32BE(id, 0);
  out.set(data, 4);
  return out;
}

export function decodeStreamFrame(frame: Buffer): { id: number; data: Buffer } {
  return { id: frame.readUInt32BE(0), data: frame.subarray(4) };
}
