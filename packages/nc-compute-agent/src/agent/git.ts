import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  countLines,
  parseNameStatus,
  PATCH_SCOPES,
  SESSION_BASE_REF,
  statusOf,
  TURN_BASE_REF,
} from '../diff';
import { absolutePath } from './fs';
import { AgentError, run, runProcess } from './util';
import type { AgentCalls, ExecResult } from '../protocol';
import type {
  FactoryFileDiff,
  FactoryFileEntry,
  FactorySessionPatch,
} from 'nocodb-sdk';

type Call<K extends keyof AgentCalls> = (
  args: AgentCalls[K]['args'],
) => Promise<AgentCalls[K]['result']>;

/** One side of a diff, as the viewer shows it. */
const SIDE_MAX_BYTES = 256 * 1024;

const GIT_TIMEOUT_MS = 3 * 60 * 1000;

/** Plain paths: by default git prints `café.md` as `"caf\303\251.md"`. */
function git(
  root: string,
  args: string[],
  opts: {
    env?: Record<string, string>;
    maxOutput?: number;
    input?: string;
  } = {},
): Promise<ExecResult> {
  return run('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutput: opts.maxOutput ?? 8 * 1024 * 1024,
    env: opts.env,
    input: opts.input,
  });
}

async function out(root: string, args: string[]): Promise<string> {
  return (await git(root, args)).stdout;
}

/**
 * The session's starting commit, or HEAD for a checkout made before the ref
 * existed, or the empty tree while there is no commit yet.
 */
async function baseRef(root: string): Promise<string> {
  for (const ref of [SESSION_BASE_REF, 'HEAD']) {
    const result = await git(root, ['rev-parse', '--verify', '--quiet', ref]);
    if (result.exitCode === 0 && result.stdout.trim()) return ref;
  }
  return (await out(root, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

/**
 * `git <args> -z` records, at most `max`; past it git is stopped. Streamed, not
 * capped output: a record cut in half by a cap would read as a path. A timeout
 * returns what arrived as truncated; a failure throws.
 */
async function records(
  root: string,
  args: string[],
  max: number,
): Promise<{ records: string[]; truncated: boolean }> {
  const found: string[] = [];
  let rest: Buffer = Buffer.alloc(0);
  let truncated = false;

  const proc = runProcess(
    'git',
    [args[0], '-z', ...args.slice(1)],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS, maxOutput: 64 * 1024 },
    (stream, chunk) => {
      if (stream !== 'stdout' || truncated) return;

      let buf = rest.byteLength ? Buffer.concat([rest, chunk]) : chunk;
      let at: number;

      while ((at = buf.indexOf(0)) !== -1) {
        if (found.length >= max) {
          truncated = true;
          proc.kill();
          return;
        }
        found.push(buf.subarray(0, at).toString('utf8'));
        buf = buf.subarray(at + 1);
      }

      rest = buf;
    },
  );

  const result = await proc.done;

  // Killed at the cap above, which exits non-zero.
  if (truncated) return { records: found, truncated };
  if (result.timedOut) return { records: found, truncated: true };
  if (result.exitCode) {
    throw new AgentError(
      'failed',
      `git ${args[0]} failed: ${result.stderr.trim()}`,
    );
  }

  return { records: found, truncated };
}

function untracked(root: string, max: number) {
  return records(root, ['ls-files', '--others', '--exclude-standard'], max);
}

/** Changed and untracked files, at most `max`; `-z` paths are never quoted. */
async function changedFiles(root: string, base: string, max: number) {
  const changed = new Map<string, FactoryFileEntry>();
  // A rename is three records: code, old path, new path.
  const diff = await records(root, ['diff', '--name-status', base], max * 3);
  const others = await untracked(root, max);
  let truncated = diff.truncated || others.truncated;

  for (let i = 0; i < diff.records.length; ) {
    const code = diff.records[i];
    const width = /^[RC]/.test(code) ? 3 : 2;

    // Cut off by the record cap.
    if (i + width > diff.records.length) break;

    if (changed.size >= max) {
      truncated = true;
      break;
    }

    // The new name of a rename: the one that exists to open.
    const path = diff.records[i + width - 1];
    changed.set(path, { path, status: statusOf(code) });
    i += width;
  }

  for (const path of others.records) {
    if (changed.has(path)) continue;

    if (changed.size >= max) {
      truncated = true;
      break;
    }

    changed.set(path, { path, status: 'untracked' });
  }

  return { changed, truncated };
}

/** The head of a buffer as text, and whether there was more. */
function side(data: Buffer): {
  text: string;
  truncated: boolean;
  binary: boolean;
} {
  return {
    text: data.subarray(0, SIDE_MAX_BYTES).toString('utf8'),
    truncated: data.byteLength > SIDE_MAX_BYTES,
    binary: data.subarray(0, 8192).includes(0),
  };
}

async function diffOne(
  root: string,
  base: string,
  path: string,
): Promise<FactoryFileDiff> {
  const [statusText, numstatText, originalRaw, modifiedRaw] = await Promise.all(
    [
      out(root, ['diff', '--name-status', base, '--', path]),
      out(root, ['diff', '--numstat', base, '--', path]),
      run('git', ['show', `${base}:${path}`], {
        cwd: root,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutput: SIDE_MAX_BYTES * 2 + 2,
      }).then((r) =>
        r.exitCode === 0 ? Buffer.from(r.stdout) : Buffer.alloc(0),
      ),
      // A symlink shows its target, as git stores it; a file only as much as the viewer shows.
      (async () => {
        const file = join(root, path);
        const info = await fsp.lstat(file);

        if (info.isSymbolicLink()) return Buffer.from(await fsp.readlink(file));
        if (!info.isFile()) return Buffer.alloc(0);

        const handle = await fsp.open(file, 'r');
        try {
          const head = Buffer.alloc(SIDE_MAX_BYTES + 1);
          const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
          return head.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      })().catch(() => Buffer.alloc(0)),
    ],
  );

  const original = side(originalRaw);
  const modified = side(modifiedRaw);

  const status =
    parseNameStatus(statusText).get(path)?.status ??
    (original.text ? 'modified' : 'untracked');

  return {
    path,
    status,
    original: original.text,
    modified: modified.text,
    binary: original.binary || modified.binary,
    truncated: original.truncated || modified.truncated,
    ...countLines(numstatText, modified.text, status),
  };
}

/** A tree of the working tree, untracked files included, built in a throwaway index. */
async function worktreeTree(root: string): Promise<string> {
  const index = join(tmpdir(), `nc-index-${randomUUID()}`);

  await fsp.copyFile(join(root, '.git', 'index'), index).catch(() => undefined);

  try {
    const env = { GIT_INDEX_FILE: index };

    // A partial add would pin a tree missing files, read later as deletions.
    // Retried once: a file deleted mid-add (a build, the agent) fails it.
    let added = await git(root, ['add', '-A'], { env });
    if (added.exitCode) added = await git(root, ['add', '-A'], { env });
    if (added.exitCode) {
      throw new AgentError(
        'failed',
        `Could not snapshot the tree: ${added.stderr.trim()}`,
      );
    }

    const written = await git(root, ['write-tree'], { env });
    if (written.exitCode) {
      throw new AgentError(
        'failed',
        `Could not snapshot the tree: ${written.stderr.trim()}`,
      );
    }

    return written.stdout.trim();
  } finally {
    await fsp.rm(index, { force: true });
  }
}

/** Untracked files diffed at most, per patch. */
const MAX_UNTRACKED_DIFFS = 200;

/** `git diff --no-index` runs at once. */
const UNTRACKED_CONCURRENCY = 8;

/**
 * `git diff --no-index` per untracked file: as a pull request would show them
 * once added. `truncated`: more than {@link MAX_UNTRACKED_DIFFS} were left out.
 */
async function untrackedPatch(
  root: string,
  diffArgs: string[],
  maxBytes: number,
): Promise<{ patch: string; truncated: boolean }> {
  const { records: paths, truncated } = await untracked(
    root,
    MAX_UNTRACKED_DIFFS,
  );
  let patch = '';

  const diffOf = async (path: string): Promise<string> => {
    // A NUL in the first 8 KB is git's binary test; its header is all git would print.
    const head = await fsp
      .open(join(root, path), 'r')
      .then(async (handle) => {
        try {
          const info = await handle.stat();
          if (!info.isFile()) return undefined;
          const buf = Buffer.alloc(8192);
          const { bytesRead } = await handle.read(buf, 0, buf.byteLength, 0);
          return { binary: buf.subarray(0, bytesRead).includes(0), info };
        } finally {
          await handle.close();
        }
      })
      .catch(() => undefined);

    if (head?.binary) {
      const mode = head.info.mode & 0o111 ? '100755' : '100644';
      return `diff --git a/${path} b/${path}\nnew file mode ${mode}\nBinary files /dev/null and b/${path} differ\n`;
    }

    // Exits 1 whenever the files differ, which they always do here.
    return (
      await git(root, [...diffArgs, '--no-index', '--', '/dev/null', path])
    ).stdout;
  };

  for (let at = 0; at < paths.length; at += UNTRACKED_CONCURRENCY) {
    // Past the cap the caller truncates anyway.
    if (Buffer.byteLength(patch) > maxBytes) break;
    patch += (
      await Promise.all(
        paths.slice(at, at + UNTRACKED_CONCURRENCY).map(diffOf),
      )
    ).join('');
  }

  return { patch, truncated };
}

/**
 * `git check-ref-format`'s rules, plus no leading `-`: git runs from argv, so an
 * option is the only injection. Mirrors the backend's `isValidGitRef`.
 */
function validRef(ref: unknown): ref is string {
  if (typeof ref !== 'string' || !ref || ref.length > 255) return false;

  if (
    ref.startsWith('-') ||
    ref === '@' ||
    ref.includes('..') ||
    ref.includes('@{') ||
    /[\s~^:?*[\\]/.test(ref) ||
    [...ref].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\x7f')
  ) {
    return false;
  }

  return ref
    .split('/')
    .every(
      (part) =>
        !!part &&
        !part.startsWith('.') &&
        !part.endsWith('.') &&
        !part.endsWith('.lock'),
    );
}

export const gitCalls: {
  [K in
    | 'git.files'
    | 'git.diffFile'
    | 'git.patch'
    | 'git.snapshotRef'
    | 'git.exec']: Call<K>;
} = {
  'git.files': async ({ root, max }) => {
    const dir = absolutePath(root);
    const { changed, truncated } = await changedFiles(
      dir,
      await baseRef(dir),
      max,
    );
    const entries: FactoryFileEntry[] = [...changed.values()];

    if (truncated) return { entries, truncated };

    // Changed tracked files are listed again here, so the cap leaves room to skip them.
    const tracked = await records(dir, ['ls-files'], max + changed.size);

    for (const path of tracked.records) {
      if (!path || changed.has(path)) continue;

      if (entries.length >= max) return { entries, truncated: true };

      entries.push({ path });
    }

    return { entries, truncated: tracked.truncated };
  },

  'git.diffFile': async ({ root, path }) => {
    const dir = absolutePath(root);

    if (
      typeof path !== 'string' ||
      !path ||
      path.startsWith('/') ||
      path.split('/').includes('..')
    ) {
      throw new AgentError('invalid', `Invalid path: ${String(path)}`);
    }

    return diffOne(dir, await baseRef(dir), path);
  },

  'git.patch': async ({
    root,
    params,
    maxBytes,
  }): Promise<FactorySessionPatch> => {
    const dir = absolutePath(root);
    const { scope = 'branch', base, commit, ignoreWhitespace } = params ?? {};

    if (!PATCH_SCOPES.includes(scope))
      throw new AgentError('invalid', `Invalid scope: ${scope}`);
    if (base && !validRef(base))
      throw new AgentError('invalid', `Invalid base: ${base}`);
    if (scope === 'commit' && !/^[0-9a-f]{4,40}$/.test(commit ?? '')) {
      throw new AgentError('invalid', `Invalid commit: ${commit ?? ''}`);
    }

    const diffArgs = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      ...(ignoreWhitespace ? ['-w'] : []),
    ];
    const sessionBase = await baseRef(dir);

    let patch = '';
    let untrackedCut = false;
    const withUntracked = async (tracked: string) => {
      const extra = await untrackedPatch(dir, diffArgs, maxBytes);
      untrackedCut = extra.truncated;
      return tracked + extra.patch;
    };

    switch (scope) {
      case 'branch': {
        const from = base ?? sessionBase;
        const mergeBase =
          (await out(dir, ['merge-base', from, 'HEAD'])).trim() || from;
        patch = await withUntracked(await out(dir, [...diffArgs, mergeBase]));
        break;
      }
      case 'last_turn': {
        // Without a turn mark (none yet, or the backend cleared a failed one): the session base.
        const turn =
          (
            await out(dir, ['rev-parse', '--verify', '--quiet', TURN_BASE_REF])
          ).trim() ||
          (await out(dir, ['rev-parse', `${sessionBase}^{tree}`])).trim();
        patch = await out(dir, [...diffArgs, turn, await worktreeTree(dir)]);
        break;
      }
      case 'uncommitted':
        patch = await withUntracked(await out(dir, [...diffArgs, 'HEAD']));
        break;
      case 'unstaged':
        patch = await withUntracked(await out(dir, diffArgs));
        break;
      case 'staged':
        patch = await out(dir, [...diffArgs, '--cached']);
        break;
      case 'commit':
        patch = await out(dir, [
          'show',
          '--no-color',
          '--no-ext-diff',
          '--format=',
          // A merge otherwise prints a combined `diff --cc`: unparseable, and it hides cleanly merged files.
          '-m',
          '--first-parent',
          ...(ignoreWhitespace ? ['-w'] : []),
          commit ?? '',
        ]);
        break;
    }

    const [branch, refs, log] = await Promise.all([
      out(dir, ['branch', '--show-current']),
      out(dir, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
        'refs/remotes',
      ]),
      out(dir, [
        'log',
        '--format=%h%x09%s',
        '-n',
        '50',
        `${sessionBase}..HEAD`,
      ]),
    ]);

    const overCap = Buffer.byteLength(patch) > maxBytes;

    return {
      patch: overCap
        ? Buffer.from(patch).subarray(0, maxBytes).toString('utf8')
        : patch,
      truncated: overCap || untrackedCut,
      branch: branch.trim(),
      branches: refs
        .split('\n')
        .map((ref) => ref.trim())
        // `origin` alone is the remote's HEAD symref.
        .filter((ref) => ref && !ref.endsWith('/HEAD') && ref !== 'origin'),
      commits: log
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha = '', ...subject] = line.split('\t');
          return { sha, subject: subject.join('\t') };
        }),
    };
  },

  'git.snapshotRef': async ({ root, ref }) => {
    const dir = absolutePath(root);

    if (!/^refs\/nocodb\/[\w-]+$/.test(ref)) {
      throw new AgentError('invalid', `Not a snapshot ref: ${ref}`);
    }

    const tree = await worktreeTree(dir);

    if (!tree) throw new AgentError('failed', 'Could not snapshot the tree.');

    const updated = await git(dir, ['update-ref', ref, tree]);

    if (updated.exitCode) throw new AgentError('failed', updated.stderr.trim());

    return { tree };
  },

  /** Never takes a credential: the machine's egress proxy authenticates to the repo host. */
  'git.exec': async ({ root, args, timeoutMs }) => {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new AgentError('invalid', 'args must be strings');
    }

    return run('git', args, {
      cwd: absolutePath(root),
      env: { GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: timeoutMs ?? GIT_TIMEOUT_MS,
    });
  },
};
