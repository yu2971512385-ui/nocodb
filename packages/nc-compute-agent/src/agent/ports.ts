import { promises as fsp } from 'fs';
import { appPorts } from '../port-filter';
import { AGENT_PORT } from '../protocol';
import type { FactoryPort } from 'nocodb-sdk';

/** VS Code's floor for its own scan; reading /proc is cheap enough to go lower. */
const SCAN_MS = 1000;

/** `0A` is TCP_LISTEN in /proc/net/tcp. */
const LISTEN = '0A';

interface Listener {
  port: number;
  inode: string;
}

async function listeners(): Promise<Listener[]> {
  const found = new Map<number, Listener>();

  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');

    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);

      if (cols[3] !== LISTEN) continue;

      const port = parseInt(cols[1]?.split(':')[1] ?? '', 16);

      if (!Number.isInteger(port) || found.has(port)) continue;

      found.set(port, { port, inode: cols[9] ?? '' });
    }
  }

  return [...found.values()];
}

/** Socket inode → process name, by walking every process's open descriptors. */
async function processNames(inodes: Set<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const pids = (await fsp.readdir('/proc').catch(() => [])).filter((p) =>
    /^\d+$/.test(p),
  );

  await Promise.all(
    pids.map(async (pid) => {
      const fds = await fsp
        .readdir(`/proc/${pid}/fd`)
        .catch(() => [] as string[]);
      let owned: string | undefined;

      for (const fd of fds) {
        const target = await fsp
          .readlink(`/proc/${pid}/fd/${fd}`)
          .catch(() => '');
        const inode = target.match(/^socket:\[(\d+)\]$/)?.[1];

        if (inode && inodes.has(inode)) {
          owned ??= (
            await fsp.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')
          ).trim();
          if (owned) names.set(inode, owned);
        }
      }
    }),
  );

  return names;
}

let current: FactoryPort[] = [];
let currentKey = '';
let scanning: ReturnType<typeof setInterval> | undefined;
const watchers = new Set<(ports: FactoryPort[]) => void>();

async function scan(): Promise<FactoryPort[]> {
  const found = (await listeners()).filter((l) => l.port !== AGENT_PORT);
  const key = found
    .map((l) => `${l.port}:${l.inode}`)
    .sort()
    .join(',');

  // The /proc walk only when something started or stopped listening.
  if (key !== currentKey) {
    const names = await processNames(new Set(found.map((l) => l.inode)));

    currentKey = key;
    current = appPorts(
      found.map((l) => {
        const name = names.get(l.inode);
        return name ? { port: l.port, process: name } : { port: l.port };
      }),
    );

    for (const watcher of watchers) watcher(current);
  }

  return current;
}

export async function listPorts(): Promise<FactoryPort[]> {
  return scanning ? current : scan();
}

/** Scans only while someone watches; the first snapshot is sent at once. */
export function watchPorts(
  onPorts: (ports: FactoryPort[]) => void,
): () => void {
  watchers.add(onPorts);

  if (!scanning) {
    // Matches no scan, so the first one is always sent, even an empty one.
    currentKey = '\0';
    scanning = setInterval(() => void scan().catch(() => undefined), SCAN_MS);
    void scan().catch(() => undefined);
  } else {
    onPorts(current);
  }

  return () => {
    watchers.delete(onPorts);

    if (!watchers.size && scanning) {
      clearInterval(scanning);
      scanning = undefined;
    }
  };
}
