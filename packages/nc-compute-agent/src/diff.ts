import type {
  FactoryFileEntry,
  FactoryFileStatus,
  FactoryPatchScope,
} from 'nocodb-sdk';

/** Reading what `git diff` says about a checkout. Pure string work, shared by the agent and the backend. */

/**
 * Where the checkout's starting commit is pinned, so "what did this session
 * change" stays answerable. HEAD is not that answer — the agent commits as it
 * goes, so by the end HEAD *is* the work. Written once at clone time and never
 * moved, so a diff against it covers committed and uncommitted alike.
 *
 * Under `refs/nocodb/` rather than a tag or branch: nothing there is pushed,
 * listed by `git branch`, or in the way of the user's own names.
 */
export const SESSION_BASE_REF = 'refs/nocodb/session-base';

/**
 * The working tree as each turn began, untracked files included: the "Last turn"
 * review's base. Only while it is absent does that review use the session base.
 */
export const TURN_BASE_REF = 'refs/nocodb/turn-base';

export const PATCH_SCOPES: readonly FactoryPatchScope[] = [
  'branch',
  'last_turn',
  'uncommitted',
  'unstaged',
  'staged',
  'commit',
];

/** `git diff --name-status` lines, keyed by path. */
export function parseNameStatus(text: string): Map<string, FactoryFileEntry> {
  const byPath = new Map<string, FactoryFileEntry>();

  for (const line of text.split('\n')) {
    // `X\tpath`, or `R100\told\tnew` for a rename — the new name is the one
    // that exists to open, so it is the one the tree lists.
    const parts = line.split('\t');

    if (parts.length < 2) continue;

    const code = parts[0].trim();
    const path = unquote((parts[parts.length - 1] ?? '').trim());

    if (!code || !path) continue;

    byPath.set(path, { path, status: statusOf(code) });
  }

  return byPath;
}

/**
 * A file's line counts, from `--numstat` where git has them.
 *
 * An untracked file has no diff to count, so its every line is an addition —
 * which is what git would say about it once added.
 */
export function countLines(
  numstat: string,
  modified: string,
  status: FactoryFileStatus,
): { additions?: number; deletions?: number } {
  const [added, removed] = (numstat.trim().split('\n')[0] ?? '').split('\t');

  // Truthiness, not `!== undefined`: an empty `--numstat` splits to `['']`,
  // and `Number('')` is 0 rather than NaN — so an absent count read as a
  // real zero, and an untracked file reported `+0` instead of its length.
  // `-` on both counts is how `--numstat` reports a binary file.
  if (added && added !== '-' && !Number.isNaN(Number(added))) {
    return { additions: Number(added), deletions: Number(removed) || 0 };
  }

  if (status !== 'untracked' || !modified) return {};

  // A final newline ends the last line rather than starting another.
  const lines = modified.split('\n').length - (modified.endsWith('\n') ? 1 : 0);

  return { additions: lines, deletions: 0 };
}

/** Git quotes paths with non-ASCII or spaces; the tree wants the real name. */
export function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;

  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

/** A `--name-status` code: `A`, `D`, `M`, or `R`/`C` with a similarity score. */
export function statusOf(code: string): FactoryFileStatus {
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('A') || code.startsWith('R') || code.startsWith('C')) {
    return 'added';
  }
  return 'modified';
}
