/**
 * nc-compute-agent: the daemon baked into every compute image, and what the
 * backend needs to talk to it — the wire protocol and the helpers both sides
 * share. `pnpm build` produces the bundle the images ship.
 */
export * from './protocol';
export * from './diff';
export * from './port-filter';
export * from './capped-output';
