/** Keeps the first and last halves of a stream past `max` bytes. */
export class CappedOutput {
  private head: Buffer[] = [];
  private headSize = 0;
  private tail: Buffer[] = [];
  private tailSize = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer | string) {
    if (typeof chunk === 'string') chunk = Buffer.from(chunk);

    const half = Math.floor(this.max / 2);

    if (this.headSize < half) {
      const take = chunk.subarray(0, half - this.headSize);
      this.head.push(take);
      this.headSize += take.byteLength;
      chunk = chunk.subarray(take.byteLength);
    }

    if (!chunk.byteLength) return;

    this.tail.push(chunk);
    this.tailSize += chunk.byteLength;

    while (this.tailSize > half && this.tail.length) {
      const first = this.tail[0];
      const over = this.tailSize - half;

      this.truncated = true;

      if (first.byteLength <= over) {
        this.tail.shift();
        this.tailSize -= first.byteLength;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailSize -= over;
      }
    }
  }

  get empty() {
    return !this.headSize && !this.tailSize;
  }

  toString() {
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');

    return this.truncated
      ? `${head}\n… output truncated …\n${tail}`
      : head + tail;
  }
}

/** The most output one process may buffer, whatever its caller asked for. */
export const MAX_EXEC_OUTPUT = 8 * 1024 * 1024;
