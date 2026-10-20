import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { dirname, isAbsolute, join, normalize } from 'path';
import { AgentError, sha256, sha256File } from './util';
import { MAX_CALL_BYTES } from '../protocol';
import type { FactoryFile } from 'nocodb-sdk';
import type { AgentCalls, FsEntry } from '../protocol';

type Call<K extends keyof AgentCalls> = (
  args: AgentCalls[K]['args'],
) => Promise<AgentCalls[K]['result']>;

/** A truncated read still hashes the whole file, so an edit can be checked; past this it is skipped. */
const MAX_HASH_BYTES = 64 * 1024 * 1024;

export function absolutePath(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new AgentError('invalid', `Not an absolute path: ${String(path)}`);
  }

  return normalize(path);
}

function entryType(stat: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsEntry['type'] {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

function missing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** The hash a write is checked against, `null` when there is no file. */
async function currentHash(path: string): Promise<string | null> {
  try {
    return await sha256File(path);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** A symlink is written through, as envd did: the write lands on its target. */
export function resolveLink(path: string): Promise<string> {
  return fsp.realpath(path).catch((e) => {
    if (missing(e)) return path;
    throw e;
  });
}

/** Written beside the target then renamed over it, so a reader never sees half a file. */
async function writeAtomic(path: string, data: Buffer, mode?: number) {
  path = await resolveLink(path);
  await fsp.mkdir(dirname(path), { recursive: true });

  const existingMode = await fsp
    .stat(path)
    .then((s) => s.mode & 0o7777)
    .catch(() => undefined);
  const temp = join(dirname(path), `.nc-write-${randomUUID()}`);

  try {
    await fsp.writeFile(temp, data, {
      mode: mode ?? existingMode ?? 0o644,
      flag: 'wx',
    });
    await fsp.rename(temp, path);
  } catch (e) {
    await fsp.rm(temp, { force: true });
    throw e;
  }
}

async function checkExpected(path: string, expected: string | null | undefined) {
  if (expected === undefined) return;

  const actual = await currentHash(path);

  if (expected === null && actual !== null) {
    throw new AgentError('conflict', `${path} already exists.`);
  }

  if (expected !== null && actual !== expected) {
    throw new AgentError(
      'conflict',
      actual === null
        ? `${path} was deleted since it was read.`
        : `${path} changed since it was read.`,
    );
  }
}

/**
 * Edits run one at a time per path, so two writers checking the same hash
 * cannot both pass the check and both write.
 */
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  // Keyed by the target writes land on, so a symlink and its target share one lock.
  const key = await resolveLink(path);
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);

  locks.set(
    key,
    next.catch(() => undefined),
  );
  const release = () => {
    if (locks.get(key) === next) locks.delete(key);
  };
  // Not `finally`: its copy of a rejection would go unhandled.
  next.then(release, release);

  return next;
}

/** An upload's last step: the same check `fs.write` makes, then the rename. */
export function replaceChecked(
  temp: string,
  path: string,
  expectedHash: string | null | undefined,
): Promise<void> {
  return withLock(path, async () => {
    await checkExpected(path, expectedHash);
    await fsp.rename(temp, path);
  });
}

export const fsCalls: {
  [K in
    | 'fs.list'
    | 'fs.stat'
    | 'fs.read'
    | 'fs.write'
    | 'fs.edit'
    | 'fs.remove'
    | 'fs.mkdir']: Call<K>;
} = {
  'fs.list': async ({ path }) => {
    const dir = absolutePath(path);
    const dirents = await fsp
      .readdir(dir, { withFileTypes: true })
      .catch((e) => {
        if (missing(e))
          throw new AgentError('not_found', `No such directory: ${dir}`);
        throw e;
      });

    return {
      entries: dirents.map((d) => ({ name: d.name, type: entryType(d) })),
    };
  },

  'fs.stat': async ({ path }) => {
    try {
      const stat = await fsp.lstat(absolutePath(path));
      return { type: entryType(stat), size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (e) {
      if (missing(e)) return { type: 'missing', size: 0, mtimeMs: 0 };
      throw e;
    }
  },

  'fs.read': async ({ path, maxBytes }): Promise<FactoryFile> => {
    const file = absolutePath(path);
    const cap = Math.min(maxBytes ?? MAX_CALL_BYTES, MAX_CALL_BYTES);

    let stat;
    try {
      stat = await fsp.stat(file);
    } catch (e) {
      if (missing(e))
        throw new AgentError('not_found', `No such file: ${file}`);
      throw e;
    }

    if (!stat.isFile()) throw new AgentError('invalid', `Not a file: ${file}`);

    const handle = await fsp.open(file, 'r');

    try {
      const head = Buffer.alloc(Math.min(stat.size, cap));
      const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);

      // Short of what stat said: the file shrank since, and what was read is all of it.
      const data = head.subarray(0, bytesRead);
      const size = bytesRead < head.byteLength ? bytesRead : stat.size;

      // A NUL in the first 8 KB is git's own test for binary.
      const binary = data.subarray(0, 8192).includes(0);
      const hash =
        size <= MAX_HASH_BYTES
          ? size <= cap
            ? sha256(data)
            : await sha256File(file)
          : '';

      return {
        path: file,
        content: binary ? '' : data.toString('utf8'),
        size,
        binary,
        truncated: size > cap,
        hash,
      };
    } finally {
      await handle.close();
    }
  },

  'fs.write': async ({ path, content, encoding, expectedHash, mode }) => {
    const file = absolutePath(path);
    const data = Buffer.from(
      content,
      encoding === 'base64' ? 'base64' : 'utf8',
    );

    if (data.byteLength > MAX_CALL_BYTES) {
      throw new AgentError(
        'too_large',
        `${data.byteLength} bytes is too much for one call; upload ${file} instead.`,
      );
    }

    return withLock(file, async () => {
      await checkExpected(file, expectedHash);
      await writeAtomic(file, data, mode);
      return { hash: sha256(data), size: data.byteLength };
    });
  },

  'fs.edit': async ({ path, edits, expectedHash }) => {
    const file = absolutePath(path);

    if (!Array.isArray(edits) || !edits.length) {
      throw new AgentError('invalid', 'No edits given.');
    }

    return withLock(file, async () => {
      let raw: Buffer;
      try {
        const info = await fsp.stat(file);
        if (info.size > MAX_CALL_BYTES) {
          throw new AgentError(
            'too_large',
            `${file} is ${info.size} bytes, too large to edit in one call.`,
          );
        }
        raw = await fsp.readFile(file);
      } catch (e) {
        if (missing(e))
          throw new AgentError('not_found', `No such file: ${file}`);
        throw e;
      }

      if (expectedHash !== undefined && sha256(raw) !== expectedHash) {
        throw new AgentError('conflict', `${file} changed since it was read.`);
      }

      let content = raw.toString('utf8');

      // Rewriting would turn every invalid byte in the file into U+FFFD.
      if (!Buffer.from(content, 'utf8').equals(raw)) {
        throw new AgentError(
          'invalid',
          `${file} is not valid UTF-8 text; it cannot be edited as text.`,
        );
      }
      let replacements = 0;
      let startAt: number | undefined;

      for (const edit of edits) {
        if (!edit.oldText) {
          throw new AgentError('invalid', 'oldText must not be empty.');
        }

        const first = content.indexOf(edit.oldText);

        if (first === -1) {
          throw new AgentError(
            'not_found',
            `oldText was not found in ${file}. Read the file again and copy the text exactly.`,
          );
        }

        startAt ??= first;

        if (edit.replaceAll) {
          const parts = content.split(edit.oldText);
          replacements += parts.length - 1;
          content = parts.join(edit.newText);
          continue;
        }

        if (content.indexOf(edit.oldText, first + 1) !== -1) {
          throw new AgentError(
            'conflict',
            `oldText occurs more than once in ${file}. Include more surrounding lines, or set replace_all.`,
          );
        }

        content =
          content.slice(0, first) +
          edit.newText +
          content.slice(first + edit.oldText.length);
        replacements += 1;
      }

      const data = Buffer.from(content, 'utf8');
      await writeAtomic(file, data);

      return {
        hash: sha256(data),
        size: data.byteLength,
        replacements,
        ...(startAt !== undefined && edits[0].newText
          ? { startLine: content.slice(0, startAt).split('\n').length }
          : {}),
      };
    });
  },

  'fs.remove': async ({ path, recursive }) => {
    await fsp.rm(absolutePath(path), { recursive: !!recursive, force: true });
    return { ok: true };
  },

  'fs.mkdir': async ({ path }) => {
    await fsp.mkdir(absolutePath(path), { recursive: true });
    return { ok: true };
  },
};
