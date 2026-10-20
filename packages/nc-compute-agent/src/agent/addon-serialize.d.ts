// The built file, not the package entry: the entry's typings pull in `@xterm/xterm`'s,
// which reference the DOM lib. Only what the agent uses is declared.
declare module '@xterm/addon-serialize/lib/addon-serialize.js' {
  export class SerializeAddon {
    serialize(opts: { scrollback: number }): string;
    activate(terminal: unknown): void;
    dispose(): void;
  }
}
