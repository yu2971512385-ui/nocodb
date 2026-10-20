import { createHash } from 'crypto';
import { createReadStream, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { constants } from 'os';
import { AGENT_ENV_PATH } from '../protocol';
import { CappedOutput, MAX_EXEC_OUTPUT } from '../capped-output';
import type { AgentErrorCode, ExecArgs, ExecResult } from '../protocol';

/**
 * The environment a process started here gets: the agent's own, then what the
 * machine was created with (read per spawn — it is written after boot), then
 * the call's.
 */
export function processEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  let created: Record<string, string> = {};
  try {
    created = JSON.parse(readFileSync(AGENT_ENV_PATH, 'utf8'));
  } catch {
    // None: the machine was created without any.
  }
  return { ...process.env, ...created, ...env };
}

export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode, message: string) {
    super(message);
  }
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A file's hash, read as a stream: never the whole file in memory. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');

    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Mask credentials in anything leaving the instance. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

export interface RunningProcess {
  done: Promise<ExecResult>;
  kill(): void;
}

/**
 * A shell command in its own process group, so a timeout or cancel takes its
 * children too (a dev server started by `pnpm dev` is three processes deep).
 */
export function runProcess(
  file: string,
  argv: string[],
  args: Omit<ExecArgs, 'command'>,
  onOutput?: (stream: 'stdout' | 'stderr', data: Buffer) => void,
): RunningProcess {
  const child = spawn(file, argv, {
    cwd: args.cwd,
    env: processEnv(args.env),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // `maxOutput` arrives from the caller; a huge one would buffer unbounded.
  const max = Math.min(args.maxOutput ?? 1024 * 1024, MAX_EXEC_OUTPUT);
  const stdout = new CappedOutput(max);
  const stderr = new CappedOutput(max);
  let timedOut = false;

  const killGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };

  const timer = args.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killGroup();
      }, args.timeoutMs)
    : undefined;

  child.stdout.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
    onOutput?.('stdout', chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
    onOutput?.('stderr', chunk);
  });
  child.stdin.on('error', () => undefined);

  if (args.input !== undefined) child.stdin.end(args.input);
  else child.stdin.end();

  const done = new Promise<ExecResult>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (signal ? 128 + (constants.signals[signal] ?? 9) : -1),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    };

    child.on('error', (e) => {
      stderr.push(Buffer.from(e.message));
    });
    child.on('close', finish);
    // A backgrounded child (`npm run dev &`) holds the pipes open past the shell's exit:
    // answer shortly after, then drain and discard — destroying them would SIGPIPE it.
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        finish(code, signal);
        if (child.stdout.readableEnded && child.stderr.readableEnded) return;
        child.removeAllListeners('close').removeAllListeners('error');
        child.on('error', () => undefined);
        for (const pipe of [child.stdout, child.stderr]) {
          pipe.removeAllListeners('data').on('data', () => undefined).resume();
        }
      }, 100);
    });
  });

  return { done, kill: killGroup };
}

export async function run(
  file: string,
  argv: string[],
  args: Omit<ExecArgs, 'command'> = {},
): Promise<ExecResult> {
  return runProcess(file, argv, args).done;
}
