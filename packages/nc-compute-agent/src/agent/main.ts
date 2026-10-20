import { createServer } from 'http';
import { connect } from 'net';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  openSync,
  readFileSync,
} from 'fs';
import { mkdir, rm, stat } from 'fs/promises';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { constants, homedir } from 'os';
import { WebSocketServer } from 'ws';
import {
  AGENT_DEFLATE_THRESHOLD,
  AGENT_PORT,
  AGENT_PROTOCOL,
  AGENT_TOKEN_HEADER,
  AGENT_TOKEN_PATH,
  decodeStreamFrame,
  encodeStreamFrame,
  PRECOMPRESSED_FILE,
} from '../protocol';
import { fsCalls, replaceChecked, resolveLink } from './fs';
import { searchCalls } from './search';
import { gitCalls } from './git';
import { listPorts, watchPorts } from './ports';
import { watchTree } from './watch';
import {
  attachPty,
  killPty,
  listPtys,
  openPty,
  pausePty,
  resizePty,
  resumePty,
  writePty,
} from './pty';
import { AgentError, processEnv, redactSecrets, runProcess } from './util';
import { absolutePath } from './fs';
import type {
  AgentCallName,
  AgentCalls,
  AgentErrorBody,
  AgentFrame,
  AgentSubscriptionName,
  AgentSubscriptions,
  ClientFrame,
  ExecArgs,
} from '../protocol';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';

/** Stamped by the build: the bundle's content hash. */
declare const __NC_AGENT_VERSION__: string;

const VERSION =
  typeof __NC_AGENT_VERSION__ === 'string' ? __NC_AGENT_VERSION__ : 'dev';

/** Past this much unsent output a byte stream's source is paused. */
const HIGH_WATER = 1024 * 1024;

const startedAt = Date.now();

// The backend writes the token here after it creates or resumes the machine.
mkdirSync(dirname(AGENT_TOKEN_PATH), { recursive: true, mode: 0o700 });

/** Read per request, so a token written after boot takes effect at once. Until then, nothing is. */
function authorised(req: IncomingMessage): boolean {
  let token: Buffer;
  try {
    token = readFileSync(AGENT_TOKEN_PATH);
  } catch {
    return false;
  }
  const given = Buffer.from(String(req.headers[AGENT_TOKEN_HEADER] ?? ''));
  return (
    token.length > 0 &&
    given.length === token.length &&
    timingSafeEqual(given, token)
  );
}

/** Commands start in the instance user's home, as a provider's own exec does, not in the agent's dir. */
function workDir(cwd?: string): string {
  return cwd ? absolutePath(cwd) : homedir();
}

function errorBody(e: unknown): AgentErrorBody {
  if (e instanceof AgentError)
    return { code: e.code, message: redactSecrets(e.message) };
  return {
    code: 'failed',
    message: redactSecrets((e as Error)?.message ?? String(e)),
  };
}

type CallHandlers = {
  [K in AgentCallName]: (
    args: AgentCalls[K]['args'],
    signal: { onCancel(fn: () => void): void },
  ) => Promise<AgentCalls[K]['result']>;
};

const calls: CallHandlers = {
  ...fsCalls,
  ...searchCalls,
  ...gitCalls,

  'agent.info': async () => ({
    version: VERSION,
    protocol: AGENT_PROTOCOL,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
  }),

  'exec.run': async (args: ExecArgs, signal) => {
    const proc = runProcess('bash', ['-lc', args.command], {
      ...args,
      cwd: workDir(args.cwd),
    });
    signal.onCancel(proc.kill);
    return proc.done;
  },

  'exec.start': async ({ command, cwd, env, logPath }) => {
    const log = openSync(logPath ? absolutePath(logPath) : '/dev/null', 'a');
    // The child holds its own copy of the fd, so ours is closed either way.
    try {
      const child = spawn('bash', ['-lc', command], {
        cwd: workDir(cwd),
        env: processEnv(env),
        detached: true,
        stdio: ['ignore', log, log],
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      return { pid: child.pid ?? -1 };
    } finally {
      closeSync(log);
    }
  },

  'ports.list': async () => ({ ports: await listPorts() }),

  'pty.open': async (args) =>
    openPty({ ...args, cwd: args.cwd ? absolutePath(args.cwd) : undefined }),
  'pty.resize': async ({ id, cols, rows }) => {
    resizePty(id, cols, rows);
    return { ok: true };
  },
  'pty.kill': async ({ id }) => {
    killPty(id);
    return { ok: true };
  },
  'pty.list': async () => ({ ptys: listPtys() }),
};

/** A live subscription: how to end it, and where bytes sent to it go. */
interface Subscription {
  close(): void;
  write?(data: Buffer): void;
  eof?(): void;
  /** Flow control from the reader, for streams whose source can wait. */
  pause?(): void;
  resume?(): void;
}

type Send = {
  frame(frame: AgentFrame): void;
  /** `compress: false` for bytes deflate cannot shrink. */
  bytes(id: number, data: Buffer, compress?: boolean): void;
  /** True while the socket has room; a byte source pauses otherwise. */
  hasRoom(): boolean;
  onDrain(fn: () => void): void;
};

/**
 * Bytes from `source` onto stream `id`, held back while the socket is full or
 * the reader has asked to pause — so nothing piles up in memory on either side.
 */
function streamBytes(
  id: number,
  source: NodeJS.ReadableStream & { pause(): unknown; resume(): unknown },
  send: Send,
  compress = true,
) {
  let held = false;

  // Re-arms while the socket is full, so a resume that lands then is not lost.
  const go = () => {
    if (held) return;
    if (send.hasRoom()) source.resume();
    else send.onDrain(go);
  };

  source.on('data', (chunk: Buffer | string) => {
    send.bytes(id, Buffer.from(chunk), compress);

    if (!send.hasRoom()) {
      source.pause();
      send.onDrain(go);
    }
  });

  return {
    pause: () => {
      held = true;
      source.pause();
    },
    resume: () => {
      held = false;
      go();
    },
  };
}

type SubHandlers = {
  [K in AgentSubscriptionName]: (
    id: number,
    args: AgentSubscriptions[K]['args'],
    emit: (event: AgentSubscriptions[K]['event']) => void,
    end: (error?: AgentErrorBody) => void,
    send: Send,
  ) => Promise<Subscription>;
};

const subscriptions: SubHandlers = {
  'pty.attach': async (id, { id: ptyId }, emit, end, send) => {
    const attached = await attachPty(ptyId, {
      onData: (data) => {
        send.bytes(id, data);
        if (!send.hasRoom()) {
          pausePty(ptyId);
          send.onDrain(() => resumePty(ptyId));
        }
      },
      onExit: (exitCode) => {
        emit({ kind: 'exit', exitCode });
        end();
      },
    });

    emit({ kind: 'replay', replay: attached.replay, info: attached.info });

    return {
      // A pause this viewer made would otherwise hold the shell's output for everyone.
      close: () => {
        attached.detach();
        resumePty(ptyId);
      },
      write: (data) => writePty(ptyId, data),
    };
  },

  'exec.spawn': async (
    _id,
    { command, cwd, env, timeoutMs },
    emit,
    end,
    send,
  ) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: workDir(cwd),
      env: processEnv(env),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let settled = false;

    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killGroup();
        }, timeoutMs)
      : undefined;

    // Output waits in the child's pipe while the socket is full or the reader paused.
    let held = false;
    const go = () => {
      if (held) return;
      if (send.hasRoom()) {
        child.stdout.resume();
        child.stderr.resume();
      } else send.onDrain(go);
    };
    const out = (stream: 'stdout' | 'stderr') => (data: string) => {
      if (settled) return;
      emit({ kind: 'out', stream, data });
      if (!send.hasRoom()) {
        child.stdout.pause();
        child.stderr.pause();
        send.onDrain(go);
      }
    };

    child.stdout.setEncoding('utf8').on('data', out('stdout'));
    child.stderr.setEncoding('utf8').on('data', out('stderr'));
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      end({ code: 'failed', message: e.message });
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      emit({
        kind: 'exit',
        exitCode: code ?? (signal ? 128 + (constants.signals[signal] ?? 9) : -1),
        timedOut,
      });
      end();
    };
    child.on('close', finish);
    // A backgrounded child holding stdout would keep 'close' back until the timeout; ending kills it, as before.
    // Not while output is held back: what the shell printed last is still in the pipe.
    const settle = (code: number | null, signal: NodeJS.Signals | null) =>
      setTimeout(() => {
        if (settled) return;
        if (child.stdout.isPaused() || child.stderr.isPaused())
          settle(code, signal);
        else finish(code, signal);
      }, 100);
    child.on('exit', settle);

    return {
      write: (data) => child.stdin.write(data),
      eof: () => child.stdin.end(),
      pause: () => {
        held = true;
        child.stdout.pause();
        child.stderr.pause();
      },
      resume: () => {
        held = false;
        go();
      },
      close: () => {
        settled = true;
        clearTimeout(timer);
        killGroup();
        // Paused pipes would otherwise hold the child object for good.
        child.stdout.destroy();
        child.stderr.destroy();
      },
    };
  },

  'ports.watch': async (_id, _args, emit) => ({
    close: watchPorts((ports) => emit({ ports })),
  }),

  'fs.watch': async (_id, { root }, emit) => ({
    close: watchTree(absolutePath(root), emit),
  }),

  'tunnel.open': async (id, { port, compress }, emit, end, send) => {
    if (
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535 ||
      port === AGENT_PORT
    ) {
      throw new AgentError('invalid', `Invalid port: ${port}`);
    }

    const dial = (host: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = connect({ port, host });
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });

    // A server on `localhost` binds ::1 alone since Node 17; ports.ts lists it all the same.
    const socket = await dial('127.0.0.1')
      .catch((e: NodeJS.ErrnoException) =>
        e.code === 'ECONNREFUSED' ? dial('::1') : Promise.reject(e),
      )
      .catch((e: Error) => {
        throw new AgentError(
          'unavailable',
          `Nothing is listening on port ${port}: ${e.message}`,
        );
      });

    const flow = streamBytes(id, socket, send, compress !== false);

    socket.on('end', () => end());
    socket.on('error', (e) => end({ code: 'failed', message: e.message }));
    socket.on('close', () => end());

    emit({ kind: 'open' });

    return {
      ...flow,
      close: () => socket.destroy(),
      write: (data) => socket.write(data),
      eof: () => socket.end(),
    };
  },

  'fs.download': async (id, { path }, emit, end, send) => {
    const file = absolutePath(path);
    const info = await stat(file).catch(() => undefined);

    if (!info?.isFile())
      throw new AgentError('not_found', `No such file: ${file}`);

    emit({ kind: 'start', size: info.size });

    const stream = createReadStream(file);
    const flow = streamBytes(id, stream, send, !PRECOMPRESSED_FILE.test(file));

    stream.on('end', () => end());
    stream.on('error', (e) => end({ code: 'failed', message: e.message }));

    return { ...flow, close: () => stream.destroy() };
  },

  'fs.upload': async (id, { path, mode, expectedHash }, emit, end, send) => {
    const file = await resolveLink(absolutePath(path));
    const temp = `${file}.nc-upload-${randomUUID()}`;

    await mkdir(dirname(file), { recursive: true });

    // A replaced file keeps its mode, as `fs.write` does.
    const existing = await stat(file).catch(() => undefined);
    const out = createWriteStream(temp, {
      mode: mode ?? (existing ? existing.mode & 0o7777 : 0o644),
      highWaterMark: HIGH_WATER,
    });
    const hash = createHash('sha256');
    let size = 0;
    let finished = false;
    let held = false;

    out.on('error', (e) => end({ code: 'failed', message: e.message }));

    emit({ kind: 'ready' });

    return {
      write: (data) => {
        size += data.byteLength;
        hash.update(data);
        // The disk is behind: the sender holds its writes until the buffer drains.
        if (!out.write(data) && !held) {
          held = true;
          send.frame({ t: 'pause', id });
          out.once('drain', () => {
            held = false;
            send.frame({ t: 'resume', id });
          });
        }
      },
      eof: () =>
        out.end(async () => {
          try {
            await replaceChecked(temp, file, expectedHash);
            finished = true;
            emit({ kind: 'done', size, hash: hash.digest('hex') });
            end();
          } catch (e) {
            await rm(temp, { force: true });
            end(errorBody(e));
          }
        }),
      close: () => {
        if (finished) return;
        out.destroy();
        void rm(temp, { force: true });
      },
    };
  },
};

function serve(ws: WebSocket) {
  const subs = new Map<number, Subscription>();
  const cancels = new Map<number, () => void>();
  const drainWaiters: (() => void)[] = [];
  let drainTimer: ReturnType<typeof setInterval> | undefined;

  const send: Send = {
    frame: (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    },
    bytes: (id, data, compress = true) => {
      if (ws.readyState === ws.OPEN)
        ws.send(encodeStreamFrame(id, data), { compress });
    },
    hasRoom: () => ws.bufferedAmount < HIGH_WATER,
    onDrain: (fn) => {
      drainWaiters.push(fn);
      drainTimer ??= setInterval(() => {
        if (ws.bufferedAmount >= HIGH_WATER / 2) return;
        clearInterval(drainTimer);
        drainTimer = undefined;
        for (const waiter of drainWaiters.splice(0)) waiter();
      }, 20);
    },
  };

  const endSub = (id: number, error?: AgentErrorBody) => {
    const sub = subs.get(id);

    if (!sub) return;

    subs.delete(id);
    sub.close();
    send.frame({ t: 'end', id, ...(error ? { error } : {}) });
  };

  const handleCall = async (id: number, op: AgentCallName, args: unknown) => {
    const handler = (Object.hasOwn(calls, op) ? calls[op] : undefined) as
      | ((
          args: unknown,
          signal: { onCancel(fn: () => void): void },
        ) => Promise<unknown>)
      | undefined;

    if (!handler) {
      send.frame({
        t: 'res',
        id,
        ok: false,
        error: { code: 'unsupported', message: `Unknown call ${op}` },
      });
      return;
    }

    try {
      const result = await handler(args ?? {}, {
        onCancel: (fn) => cancels.set(id, fn),
      });
      send.frame({ t: 'res', id, ok: true, result });
    } catch (e) {
      send.frame({ t: 'res', id, ok: false, error: errorBody(e) });
    } finally {
      cancels.delete(id);
    }
  };

  const handleSub = async (
    id: number,
    op: AgentSubscriptionName,
    args: unknown,
  ) => {
    const handler = (
      Object.hasOwn(subscriptions, op) ? subscriptions[op] : undefined
    ) as unknown as
      | ((
          id: number,
          args: unknown,
          emit: (event: unknown) => void,
          end: (error?: AgentErrorBody) => void,
          send: Send,
        ) => Promise<Subscription>)
      | undefined;

    if (!handler) {
      send.frame({
        t: 'end',
        id,
        error: { code: 'unsupported', message: `Unknown subscription ${op}` },
      });
      return;
    }

    // Placeholder until the handler answers: an early `end` has something to remove,
    // and stdin/eof/flow frames arriving meanwhile are replayed onto the real sub.
    let ended = false;
    const queued: ((s: Subscription) => void)[] = [];
    subs.set(id, {
      close: () => (ended = true),
      write: (d) => queued.push((s) => s.write?.(d)),
      eof: () => queued.push((s) => s.eof?.()),
      pause: () => queued.push((s) => s.pause?.()),
      resume: () => queued.push((s) => s.resume?.()),
    });

    try {
      const sub = await handler(
        id,
        args ?? {},
        (event) => send.frame({ t: 'ev', id, event }),
        (error) => {
          ended = true;
          endSub(id, error);
        },
        send,
      );

      if (ended || !subs.has(id)) {
        sub.close();
        return;
      }

      subs.set(id, sub);
      for (const replay of queued) replay(sub);
    } catch (e) {
      subs.delete(id);
      send.frame({ t: 'end', id, error: errorBody(e) });
    }
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const { id, data } = decodeStreamFrame(raw as Buffer);
      subs.get(id)?.write?.(data);
      return;
    }

    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (frame.t) {
      case 'call':
        void handleCall(frame.id, frame.op, frame.args);
        break;
      case 'sub':
        void handleSub(frame.id, frame.op, frame.args);
        break;
      case 'cancel':
        cancels.get(frame.id)?.();
        if (subs.has(frame.id)) {
          const sub = subs.get(frame.id)!;
          subs.delete(frame.id);
          sub.close();
        }
        break;
      case 'eof':
        subs.get(frame.id)?.eof?.();
        break;
      case 'pause':
        subs.get(frame.id)?.pause?.();
        break;
      case 'resume':
        subs.get(frame.id)?.resume?.();
        break;
    }
  });

  ws.on('close', () => {
    clearInterval(drainTimer);
    for (const cancel of cancels.values()) cancel();
    for (const sub of subs.values()) sub.close();
    subs.clear();
    cancels.clear();
  });
}

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024 * 1024,
  // Taken only when the backend offers it. Level 3: JS to 29% against level 6's
  // 27%, at 60% of its CPU, which the instance's own dev server competes for.
  perMessageDeflate: {
    threshold: AGENT_DEFLATE_THRESHOLD,
    zlibDeflateOptions: { level: 3 },
  },
});

/** Sockets that answered the last ping; one that did not is dead and is terminated. */
const alive = new WeakSet<WebSocket>();

wss.on('connection', (ws: WebSocket) => {
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  serve(ws);
});

const server = createServer((req, res) => {
  if (!authorised(req)) {
    res.writeHead(401).end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        version: VERSION,
        protocol: AGENT_PROTOCOL,
        pid: process.pid,
      }),
    );
    return;
  }

  res.writeHead(404).end();
});

// No version gate: the backend reads `protocol` from /health and serves the range it supports.
server.on('upgrade', (req, socket, head) => {
  if (!authorised(req)) {
    socket.end('HTTP/1.1 401 \r\n\r\n');
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// A keep-alive ping per connection, so a proxy in between does not idle it out.
setInterval(() => {
  for (const client of wss.clients) {
    if (!alive.has(client)) {
      client.terminate();
      continue;
    }
    alive.delete(client);
    client.ping();
  }
}, 30_000).unref();

process.on('uncaughtException', (e) => {
  process.stderr.write(`uncaught: ${e.stack ?? e.message}\n`);
});

// Fatal, so systemd restarts it: a server that never listened (EADDRINUSE) would idle forever.
server.on('error', (e) => {
  process.stderr.write(`server: ${e.stack ?? e.message}\n`);
  process.exit(1);
});

server.listen(AGENT_PORT, '0.0.0.0', () => {
  process.stdout.write(`nc-agent ${VERSION} listening on ${AGENT_PORT}\n`);
});
