import { promises as fsp, watch as fsWatch } from 'fs';
import { basename, join, relative, sep } from 'path';
import type { FSWatcher } from 'fs';
import type { WatchChange } from '../protocol';

/** Never watched: what changes there is installs and builds, not the user's code. */
const EXCLUDED = new Set([
  'node_modules',
  '.git',
  '.pnpm-store',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

/** Directories watched at most; past this the watch reports overflow and stops growing. */
const MAX_DIRS = 5000;

/** `.git/refs` directories watched at most (branch names with slashes are directories). */
const MAX_REF_DIRS = 256;

/** Changes are held this long so a save or a `git checkout` arrives as one batch. */
const BATCH_MS = 150;

/** A renamed directory is re-armed after this quiet period. */
const REARM_MS = 25;

const MAX_BATCH = 1000;

/** `.git` entries whose change means the repository's own state moved. */
const GIT_STATE = new Set([
  'HEAD',
  'index',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'packed-refs',
]);

/** Under `.git/refs`: branches and remote branches; not tags, nor our own snapshot refs. */
const REF_ROOTS = new Set(['heads', 'remotes']);

type Emit = (event: {
  changes: WatchChange[];
  git?: boolean;
  overflow?: boolean;
}) => void;

/**
 * One inotify watch per directory, descending only where `descend` allows.
 * A directory deleted or replaced is dropped with its subtree and walked again.
 */
function dirTree(opts: {
  max: number;
  descend(dir: string, name: string): boolean;
  onEvent(full: string, type: WatchChange['type']): void;
  /** A directory refused: past `max`, or the kernel is out of watches. */
  onLimit(): void;
}) {
  const watchers = new Map<string, FSWatcher>();
  const rearming = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  // A deleted directory's watch goes dead without an error.
  const drop = (dir: string) => {
    for (const [path, watcher] of watchers) {
      if (path === dir || path.startsWith(dir + sep)) {
        watcher.close();
        watchers.delete(path);
      }
    }
  };

  /**
   * A rename names something created, deleted or moved in. A known directory is
   * always re-armed with its subtree: ext4 reuses the inode of `rm -rf x && mkdir x`.
   * Coalesced per path, so the delete and the create re-arm once.
   */
  const refresh = (full: string) => {
    clearTimeout(rearming.get(full));
    rearming.set(
      full,
      setTimeout(() => {
        rearming.delete(full);
        if (closed) return;
        // A file's rename skips the drop: it scans every watch, and a build writes thousands.
        void fsp.lstat(full).then(
          (s) => {
            if (s.isDirectory() || watchers.has(full)) drop(full);
            if (s.isDirectory()) return walk(full);
          },
          () => watchers.has(full) && drop(full),
        );
      }, REARM_MS),
    );
  };

  const add = async (dir: string): Promise<boolean> => {
    if (closed) return false;
    if (watchers.has(dir)) return true;

    if (watchers.size >= opts.max) {
      opts.onLimit();
      return false;
    }

    let watcher: FSWatcher;

    try {
      watcher = fsWatch(dir, { persistent: false }, (type, filename) => {
        if (!filename || watchers.get(dir) !== watcher) return;

        const name = filename.toString();
        const event = type === 'rename' ? 'rename' : 'change';
        const report = () => {
          opts.onEvent(join(dir, name), event);
          if (event === 'rename' && opts.descend(dir, name)) {
            void refresh(join(dir, name));
          }
        };

        // inotify reports a watched directory's own deletion under its own name, as
        // it does a child of that name (`app/app`); the parent re-arms a dir that comes back.
        if (name !== basename(dir)) return report();

        void fsp.lstat(join(dir, name)).then(report, () =>
          fsp.lstat(dir).then(report, () => {
            if (watchers.get(dir) === watcher) drop(dir);
          }),
        );
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EMFILE') opts.onLimit();
      return false;
    }

    watcher.on('error', () => {
      watcher.close();
      if (watchers.get(dir) === watcher) watchers.delete(dir);
    });
    watchers.set(dir, watcher);
    return true;
  };

  const walk = async (dir: string): Promise<void> => {
    // Not watched (gone, or refused, which `add` reported): its subtree would be refused too.
    if (!(await add(dir))) return;

    const entries = await fsp
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);

    for (const entry of entries) {
      if (entry.isDirectory() && opts.descend(dir, entry.name)) {
        await walk(join(dir, entry.name));
      }
    }
  };

  return {
    walk,
    close: () => {
      closed = true;
      for (const timer of rearming.values()) clearTimeout(timer);
      rearming.clear();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

/**
 * The work tree, skipping {@link EXCLUDED} — Node's own recursive watch would
 * descend into `node_modules` and exhaust the kernel's watch limit on a real
 * repository — and the repository's state beside it.
 */
export function watchTree(root: string, emit: Emit): () => void {
  let pending = new Map<string, WatchChange>();
  let gitMoved = false;
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = () => {
    timer = undefined;

    if (closed || (!pending.size && !gitMoved && !overflow)) return;

    emit({
      changes: overflow ? [] : [...pending.values()],
      ...(gitMoved ? { git: true } : {}),
      ...(overflow ? { overflow: true } : {}),
    });

    pending = new Map();
    gitMoved = false;
    overflow = false;
  };

  const schedule = () => {
    timer ??= setTimeout(flush, BATCH_MS);
  };

  const limit = () => {
    overflow = true;
    schedule();
  };

  const moved = () => {
    gitMoved = true;
    schedule();
  };

  const files = dirTree({
    max: MAX_DIRS,
    descend: (_dir, name) => !EXCLUDED.has(name),
    onEvent: (full, type) => {
      const path = relative(root, full);

      if (pending.size >= MAX_BATCH) overflow = true;
      else pending.set(path, { path, type });

      schedule();
    },
    onLimit: limit,
  });

  // Refs move without touching HEAD: `reset --soft`, `update-ref`, a push's remote ref.
  const refsDir = join(root, '.git', 'refs');
  const refs = dirTree({
    max: MAX_REF_DIRS,
    descend: (dir, name) => dir !== refsDir || REF_ROOTS.has(name),
    onEvent: (full) => {
      if (REF_ROOTS.has(relative(refsDir, full).split(sep)[0])) moved();
    },
    // Past the cap the files are still watched; only ref moves may be missed.
    onLimit: moved,
  });

  // The repository's state, shallowly: commits, stages and checkouts.
  let gitWatcher: FSWatcher | undefined;
  try {
    gitWatcher = fsWatch(
      join(root, '.git'),
      { persistent: false },
      (_type, name) => {
        if (name && GIT_STATE.has(name.toString())) moved();
      },
    );
    gitWatcher.on('error', () => gitWatcher?.close());
  } catch {
    gitWatcher = undefined;
  }

  void files.walk(root);
  void refs.walk(refsDir);

  return () => {
    closed = true;
    clearTimeout(timer);
    gitWatcher?.close();
    files.close();
    refs.close();
  };
}
