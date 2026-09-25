/**
 * Timeout-protected, size-capped stdin reader for OMS hook processes.
 * Mirrors the pattern in OMC hooks/lib/stdin.mjs.
 */

export const MAX_STDIN_BYTES = 8 * 1024 * 1024;

export interface StdinRead {
  readonly text: string;
  /** Input went past `maxBytes`; `text` holds only the first `maxBytes`. */
  readonly truncated: boolean;
  /** The timeout fired before stdin ended; `text` holds what arrived. */
  readonly timedOut: boolean;
}

export async function readStdinTimeout(timeoutMs = 5000, maxBytes = MAX_STDIN_BYTES): Promise<StdinRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (truncated: boolean, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ text: Buffer.concat(chunks).toString("utf-8"), truncated, timedOut });
    };

    const timeout = setTimeout(() => {
      process.stdin.removeAllListeners();
      finish(false, true);
    }, timeoutMs);

    process.stdin.on("data", (chunk: Buffer) => {
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        process.stdin.removeAllListeners();
        process.stdin.destroy();
        finish(true, false);
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
    });

    process.stdin.on("end", () => finish(false, false));

    process.stdin.on("error", () => {
      chunks.length = 0;
      finish(false, false);
    });

    if (process.stdin.readableEnded) finish(false, false);
  });
}
