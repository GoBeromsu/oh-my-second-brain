import { constants, type BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";

const FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;

/** Null means the filesystem has not supplied reliable metadata change evidence. */
export function fileMetadataWitness(info: unknown): string | null {
  if (info === null || typeof info !== "object") return null;
  if (!("isFile" in info) || typeof info.isFile !== "function" || !info.isFile()) return null;
  const values = info as Partial<Record<typeof FIELDS[number], unknown>>;
  if (FIELDS.some(field => typeof values[field] !== "bigint")) return null;
  const { dev, ino, size, mtimeNs, ctimeNs } = values as Record<typeof FIELDS[number], bigint>;
  // Coarse/unknown timestamps or inode zero cannot authorize a body-free read.
  if (dev <= 0n || ino <= 0n || size < 0n || mtimeNs <= 0n || ctimeNs <= 0n
    || mtimeNs % 1_000_000n === 0n || ctimeNs % 1_000_000n === 0n) return null;
  return JSON.stringify(FIELDS.map(field => (values[field] as bigint).toString()));
}

function changed(filename: string): never { throw new Error(`File source "${filename}" changed while being read; retry the operation.`); }

function usable(field: typeof FIELDS[number], value: unknown): value is bigint {
  if (typeof value !== "bigint") return false;
  if (field === "size") return value >= 0n;
  if (value <= 0n) return false;
  return field === "dev" || field === "ino" || value % 1_000_000n !== 0n;
}

/** Compare usable evidence only; weak/asymmetric fields require the byte fallback. */
function assertCompatible(filename: string, before: BigIntStats, after: BigIntStats): void {
  if (!before.isFile() || !after.isFile()) changed(filename);
  for (const field of FIELDS) {
    if (usable(field, before[field]) && usable(field, after[field]) && before[field] !== after[field]) changed(filename);
  }
}

async function readOpened(filename: string, expected: BigIntStats) {
  // NONBLOCK avoids waiting on a FIFO substituted after the path was checked.
  const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    assertCompatible(filename, expected, before);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertCompatible(filename, before, after);
    if ((typeof before.size === "bigint" && before.size !== BigInt(bytes.byteLength))
      || (typeof after.size === "bigint" && after.size !== BigInt(bytes.byteLength))) changed(filename);
    const current = await stat(filename, { bigint: true });
    assertCompatible(filename, after, current);
    const witness = fileMetadataWitness(before);
    return { bytes, metadata: current, witness: witness !== null && witness === fileMetadataWitness(after)
      && witness === fileMetadataWitness(current) ? witness : null };
  } finally { await handle.close(); }
}

/** Bind captured bytes to the opened inode and, when provided, the outer scan's identity. */
export async function readFileSnapshot(filename: string, expected?: BigIntStats): Promise<{
  readonly bytes: Buffer;
  readonly metadata: BigIntStats;
  readonly witness: string | null;
}> {
  const initial = expected ?? await stat(filename, { bigint: true });
  const first = await readOpened(filename, initial);
  const witness = fileMetadataWitness(initial);
  if (witness !== null && witness === first.witness && witness === fileMetadataWitness(first.metadata)) return first;
  // Weak metadata stays on byte validation. Reopen by pathname to ensure the
  // observed bytes also match a second read, rather than attesting unknown stamps.
  const second = await readOpened(filename, first.metadata);
  if (!first.bytes.equals(second.bytes)) changed(filename);
  return { bytes: first.bytes, metadata: second.metadata, witness: null };
}
