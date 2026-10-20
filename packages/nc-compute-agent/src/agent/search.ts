import { absolutePath } from './fs';
import { AgentError, run } from './util';
import type { AgentCalls } from '../protocol';

type Call<K extends keyof AgentCalls> = (
  args: AgentCalls[K]['args'],
) => Promise<AgentCalls[K]['result']>;

const SEARCH_TIMEOUT_MS = 60 * 1000;

/** Enough to hold `limit` matching lines with context; the rest is cut by line. */
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * ripgrep, run without a shell: it honours .gitignore, which is most of why
 * the results are readable rather than a wall of build output.
 */
export const searchCalls: {
  [K in 'search.grep' | 'search.glob']: Call<K>;
} = {
  'search.grep': async ({
    pattern,
    path,
    glob,
    context,
    limit,
    ignoreCase,
  }) => {
    if (typeof pattern !== 'string' || !pattern) {
      throw new AgentError('invalid', 'pattern is required');
    }

    const argv = [
      '--line-number',
      '--no-heading',
      '--color=never',
      `--max-count=${limit}`,
      ...(context ? [`--context=${context}`] : []),
      ...(glob ? ['--glob', glob] : []),
      ...(ignoreCase ? ['--ignore-case'] : []),
      '-e',
      pattern,
      '--',
      absolutePath(path),
    ];

    const result = await run('rg', argv, {
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxOutput: MAX_OUTPUT,
    });

    // Negative: rg never ran (no binary, or the path is not a directory it can start in).
    if (result.exitCode < 0) {
      return {
        matches: '',
        error: `ripgrep could not start: ${result.stderr.trim()}`,
      };
    }

    const matches = result.stdout.split('\n').slice(0, limit).join('\n').trim();

    // Killed at the timeout: what it printed so far is only part of the answer.
    if (result.timedOut) {
      return matches
        ? { matches, truncated: true }
        : {
            matches: '',
            error: `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s; narrow the path or glob.`,
          };
    }

    // 1 is "no matches"; 2 with output is one unreadable directory among many.
    if (!matches && result.exitCode > 1) {
      return {
        matches: '',
        error: result.stderr.trim() || 'ripgrep exited with an error',
      };
    }

    return { matches };
  },

  'search.glob': async ({ pattern, path, limit }) => {
    if (typeof pattern !== 'string' || !pattern) {
      throw new AgentError('invalid', 'pattern is required');
    }

    const result = await run(
      'rg',
      [
        '--files',
        '--hidden',
        '--glob',
        '!.git',
        '--glob',
        pattern.replace(/^\.?\//, ''),
        '--sortr=modified',
      ],
      {
        cwd: absolutePath(path),
        timeoutMs: SEARCH_TIMEOUT_MS,
        maxOutput: MAX_OUTPUT,
      },
    );

    if (result.exitCode < 0) {
      throw new AgentError(
        'unavailable',
        `ripgrep could not start: ${result.stderr.trim()}`,
      );
    }

    // Sorting by mtime holds every path back to the end, so a timeout leaves none.
    if (result.timedOut) {
      throw new AgentError(
        'failed',
        `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s; narrow the path or pattern.`,
      );
    }

    if (result.exitCode > 1) {
      throw new AgentError(
        'failed',
        result.stderr.trim() || 'ripgrep exited with an error',
      );
    }

    const all = result.stdout.split('\n').filter(Boolean);

    return { paths: all.slice(0, limit), truncated: all.length > limit };
  },
};
