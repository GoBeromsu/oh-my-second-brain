/**
 * Timeout-protected stdin reader for OMS hook processes.
 * Mirrors the pattern in OMC hooks/lib/stdin.mjs.
 */
export async function readStdinTimeout(timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners();
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    }, timeoutMs);

    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    process.stdin.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    });

    process.stdin.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve("");
      }
    });

    if (process.stdin.readableEnded) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    }
  });
}
