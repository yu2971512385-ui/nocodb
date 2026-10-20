import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
// The built file: see addon-serialize.d.ts.
import { SerializeAddon } from '@xterm/addon-serialize/lib/addon-serialize.js';
import { AgentError, processEnv } from './util';
import type { ChildProcess } from 'child_process';
import type { Writable } from 'stream';
import type { PtyInfo, PtyReplay } from '../protocol';

/** Lines above the screen kept for a tab that (re)attaches. */
const SCROLLBACK_LINES = 1000;

/** Output is coalesced this long before it is sent — VS Code's `TerminalDataBufferer`. */
const DATA_BATCH_MS = 5;

/** A shell nobody has attached to for this long is closed. */
const ORPHAN_MS = 24 * 60 * 60 * 1000;

/**
 * A pty without a native module: Python's `pty` forks the shell, relays bytes
 * on stdin/stdout, and takes `cols rows` lines on fd 3 to resize. Prints the
 * shell's pid on stderr first. Input is queued and written as the pty takes it,
 * so a paste bigger than its buffer cannot block the shell's output. Ends when
 * the shell exits, as node-pty does, even while a background job holds the pty.
 */
const PTY_BRIDGE = `
import os, pty, sys, select, struct, fcntl, termios, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
shell = os.environ.get('SHELL') or '/bin/bash'
os.set_inheritable(3, False)
wake, wake_w = os.pipe()
os.set_blocking(wake_w, False)
signal.set_wakeup_fd(wake_w)
signal.signal(signal.SIGCHLD, lambda *_: None)
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, '-l'])
def size(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
size(cols, rows)
fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
sys.stderr.write('%d\\n' % pid); sys.stderr.flush()
ctl = b''
fds = [3, fd, wake]
stdin_open = True
pending = bytearray()
status = None
while True:
    reads = fds + [0] if stdin_open and len(pending) < 1048576 else fds
    try:
        ready, writable, _ = select.select(reads, [fd] if pending else [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b''
        if data == b'':
            break
        if data:
            out = memoryview(data)
            while out:
                out = out[os.write(1, out):]
    if fd in writable:
        try:
            del pending[:os.write(fd, pending)]
        except BlockingIOError:
            pass
        except OSError:
            pending.clear()
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            stdin_open = False
        else:
            pending += data
    if 3 in ready:
        data = os.read(3, 1024)
        if not data:
            fds.remove(3)
        ctl += data
        while b'\\n' in ctl:
            line, ctl = ctl.split(b'\\n', 1)
            try:
                c, r = line.split()
                size(int(c), int(r))
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass
    if wake in ready:
        os.read(wake, 512)
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
            for _ in range(64):
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                out = memoryview(data)
                while out:
                    out = out[os.write(1, out):]
            break
if status is None:
    _, status = os.waitpid(pid, 0)
sys.exit(128 + os.WTERMSIG(status) if os.WIFSIGNALED(status) else os.WEXITSTATUS(status))
`;

export interface PtyListener {
  onData(data: Buffer): void;
  onExit(exitCode?: number): void;
}

interface Shell {
  info: PtyInfo;
  child: ChildProcess;
  control: Writable;
  screen: HeadlessTerminal;
  serializer: SerializeAddon;
  parsed: Promise<void>;
  batch: Buffer[];
  batchTimer?: ReturnType<typeof setTimeout>;
  listeners: Set<PtyListener>;
  orphanTimer?: ReturnType<typeof setTimeout>;
  exitCode?: number;
}

const shells = new Map<string, Shell>();

function clamp(value: unknown, min: number, max: number) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function flush(shell: Shell) {
  clearTimeout(shell.batchTimer);
  shell.batchTimer = undefined;

  if (!shell.batch.length) return;

  const chunk = Buffer.concat(shell.batch);

  shell.batch = [];
  shell.parsed = new Promise((resolve) => shell.screen.write(chunk, resolve));

  for (const listener of shell.listeners) listener.onData(chunk);
}

function get(id: string): Shell {
  const shell = shells.get(id);

  if (!shell)
    throw new AgentError('not_found', `No terminal ${id}; it may have exited.`);

  return shell;
}

function armOrphanTimer(shell: Shell) {
  clearTimeout(shell.orphanTimer);
  shell.orphanTimer = setTimeout(() => {
    if (!shell.listeners.size) killPty(shell.info.id);
  }, ORPHAN_MS);
}

export async function openPty(args: {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<PtyInfo> {
  const cols = clamp(args.cols, 20, 500);
  const rows = clamp(args.rows, 5, 200);

  const child = spawn(
    'python3',
    ['-c', PTY_BRIDGE, String(cols), String(rows)],
    {
      cwd: args.cwd,
      env: processEnv({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'C.UTF-8',
        ...args.env,
      }),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    },
  );

  const pid = await new Promise<number>((resolve, reject) => {
    let err = '';
    child.once('error', (e) =>
      reject(
        new AgentError('unavailable', `Cannot start a terminal: ${e.message}`),
      ),
    );
    child.stderr!.on('data', function onPid(chunk: Buffer) {
      err += chunk.toString();
      const line = err.match(/^(\d+)\n/);
      if (line) {
        child.stderr!.off('data', onPid);
        resolve(Number(line[1]));
      }
    });
    child.once('exit', (code) =>
      reject(
        new AgentError(
          'failed',
          `The terminal exited at start (${code}): ${err.trim()}`,
        ),
      ),
    );
  });

  const screen = new HeadlessTerminal({
    cols,
    rows,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  screen.loadAddon(serializer);

  const shell: Shell = {
    info: { id: randomUUID(), pid, cols, rows },
    child,
    control: child.stdio[3] as Writable,
    screen,
    serializer,
    parsed: Promise.resolve(),
    batch: [],
    listeners: new Set(),
  };

  screen.onTitleChange((title) => {
    shell.info.title = title;
  });

  child.stdout!.on('data', (chunk: Buffer) => {
    shell.batch.push(chunk);
    shell.batchTimer ??= setTimeout(() => flush(shell), DATA_BATCH_MS);
  });
  child.stdin!.on('error', () => undefined);
  shell.control.on('error', () => undefined);

  // 'close', not 'exit': stdout may still hold the last chunk. The bridge keeps
  // fd 3 out of the shell, so a daemon it started cannot hold 'close' back.
  child.once('close', (code) => {
    flush(shell);
    shell.exitCode = code ?? undefined;
    shells.delete(shell.info.id);
    clearTimeout(shell.orphanTimer);
    screen.dispose();
    for (const listener of shell.listeners) listener.onExit(shell.exitCode);
    shell.listeners.clear();
  });

  shells.set(shell.info.id, shell);
  armOrphanTimer(shell);

  return { ...shell.info };
}

export function writePty(id: string, data: Buffer) {
  shells.get(id)?.child.stdin?.write(data);
}

/** Holds the shell's output in its pipe while a listener's socket is full. */
export function pausePty(id: string) {
  shells.get(id)?.child.stdout?.pause();
}

export function resumePty(id: string) {
  shells.get(id)?.child.stdout?.resume();
}

/** Output already printed is parsed first, so it is not redrawn at the new width. */
export function resizePty(id: string, cols: number, rows: number) {
  const shell = get(id);

  cols = clamp(cols, 20, 500);
  rows = clamp(rows, 5, 200);

  flush(shell);
  shell.screen.resize(cols, rows);
  shell.info.cols = cols;
  shell.info.rows = rows;
  shell.control.write(`${cols} ${rows}\n`);
}

export function listPtys(): { id: string; viewers: number }[] {
  return [...shells.values()].map((shell) => ({
    id: shell.info.id,
    viewers: shell.listeners.size,
  }));
}

export function killPty(id: string) {
  const shell = shells.get(id);

  if (!shell) return;

  try {
    process.kill(shell.info.pid, 'SIGHUP');
  } catch {
    // Already gone; the bridge exits with it.
  }
  shell.child.kill('SIGTERM');
}

/** The screen serialized for a tab that attaches, then live output. */
export async function attachPty(
  id: string,
  listener: PtyListener,
): Promise<{ replay: PtyReplay; info: PtyInfo; detach: () => void }> {
  const shell = get(id);

  flush(shell);
  await shell.parsed;

  // Exited during the wait: its screen is disposed, and a listener added now never hears the exit.
  if (shells.get(id) !== shell) {
    throw new AgentError('not_found', `Terminal ${id} has exited.`);
  }

  shell.listeners.add(listener);
  clearTimeout(shell.orphanTimer);
  // A viewer that left while full may have paused it.
  shell.child.stdout?.resume();

  return {
    info: { ...shell.info },
    replay: {
      cols: shell.screen.cols,
      rows: shell.screen.rows,
      data: shell.serializer.serialize({ scrollback: SCROLLBACK_LINES }),
    },
    detach: () => {
      shell.listeners.delete(listener);
      if (!shell.listeners.size && shells.has(id)) armOrphanTimer(shell);
    },
  };
}
