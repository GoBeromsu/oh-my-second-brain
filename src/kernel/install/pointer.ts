import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const POINTER_VERSION = 1;
const POINTER_FILE = "vault.json";
const SIGNATURE_DOMAIN = "oms-host-vault-pointer";

export interface HostVaultPointer {
  readonly version: typeof POINTER_VERSION;
  readonly vault: string;
  readonly signature: string;
}

export interface HostVaultPointerReceipt {
  readonly operation: "read" | "write" | "remove";
  readonly path: string;
  readonly dryRun: boolean;
  readonly changed: boolean;
  readonly pointer?: HostVaultPointer;
}

export interface HostVaultPointerOperationOptions {
  readonly pointerPath?: string;
  readonly dryRun?: boolean;
}

export class HostVaultPointerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostVaultPointerError";
  }
}

export function hostVaultPointerPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir = homedir(),
): string {
  const configured = env["XDG_CONFIG_HOME"];
  const configHome = configured === undefined || configured === "" ? path.join(homeDir, ".config") : configured;
  if (!path.isAbsolute(configHome)) {
    throw new HostVaultPointerError("XDG_CONFIG_HOME must be an absolute path for the OMS host vault pointer.");
  }
  return path.join(configHome, "oms", POINTER_FILE);
}

function signatureFor(vault: string): string {
  return createHash("sha256").update(`${SIGNATURE_DOMAIN}\n${POINTER_VERSION}\n${vault}\n`).digest("hex");
}

function pointerPath(options: HostVaultPointerOperationOptions): string {
  return options.pointerPath ?? hostVaultPointerPath();
}

async function withPointerLock<T>(location: string, operation: () => Promise<T>): Promise<T> {
  const parent = path.dirname(location);
  const lock = `${location}.lock`;
  const token = randomUUID();
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const acquire = async (): Promise<string | null> => {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      return token;
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    let owner: { readonly pid: number; readonly token: string };
    try {
      const parsed = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf-8")) as typeof owner;
      if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.token !== "string") return null;
      owner = parsed;
    } catch {
      return null;
    }
    try {
      process.kill(owner.pid, 0);
      return null;
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") return null;
    }
    try {
      await writeFile(path.join(lock, "takeover"), `${process.pid}\n${token}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error.code === "EEXIST" || error.code === "ENOENT")) return null;
      throw error;
    }
    try {
      const claimed = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf-8")) as typeof owner;
      if (claimed.pid !== owner.pid || claimed.token !== owner.token) return null;
    } catch {
      return null;
    }
    const stale = `${lock}.stale.${token}`;
    try {
      await rename(lock, stale);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "EEXIST")) return null;
      throw error;
    }
    await rm(stale, { recursive: true, force: true });
    return acquire();
  };
  const ownerToken = await acquire();
  if (ownerToken === null) throw new HostVaultPointerError(`OMS host vault pointer is locked: ${location}.`);
  try {
    return await operation();
  } finally {
    try {
      const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf-8")) as { readonly pid: number; readonly token: string };
      if (owner.pid === process.pid && owner.token === ownerToken) {
        const released = `${lock}.released.${ownerToken}`;
        await rename(lock, released);
        await rm(released, { recursive: true, force: true });
      }
    } catch {
      // Never remove a lock instance not owned by this operation.
    }
  }
}

function parsePointer(raw: string, location: string): HostVaultPointer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HostVaultPointerError(`OMS host vault pointer is malformed: ${location}.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HostVaultPointerError(`OMS host vault pointer is malformed: ${location}.`);
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "signature" || keys[1] !== "vault" || keys[2] !== "version"
    || record["version"] !== POINTER_VERSION || typeof record["vault"] !== "string" || typeof record["signature"] !== "string") {
    throw new HostVaultPointerError(`OMS host vault pointer has an unsupported record shape: ${location}.`);
  }
  if (!path.isAbsolute(record["vault"])) {
    throw new HostVaultPointerError(`OMS host vault pointer vault must be an absolute path: ${location}.`);
  }
  if (record["signature"] !== signatureFor(record["vault"])) {
    throw new HostVaultPointerError(`OMS host vault pointer signature is invalid: ${location}.`);
  }
  return { version: POINTER_VERSION, vault: record["vault"], signature: record["signature"] };
}

export async function canonicalHostVault(vault: string): Promise<string> {
  if (!path.isAbsolute(vault)) {
    throw new HostVaultPointerError(`OMS host vault pointer requires an absolute vault path: ${vault}.`);
  }
  let canonical: string;
  try {
    canonical = await realpath(vault);
  } catch {
    throw new HostVaultPointerError(`OMS host vault pointer vault does not exist: ${vault}.`);
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new HostVaultPointerError(`OMS host vault pointer vault is not a directory: ${canonical}.`);
  }
  return canonical;
}

async function readPointerRecord(
  options: HostVaultPointerOperationOptions,
  requireLiveVault: boolean,
): Promise<HostVaultPointerReceipt> {
  const location = pointerPath(options);
  let raw: string;
  try {
    raw = await readFile(location, "utf-8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { operation: "read", path: location, dryRun: options.dryRun === true, changed: false };
    }
    throw error;
  }
  const record = parsePointer(raw, location);
  if (requireLiveVault) {
    const canonical = await canonicalHostVault(record.vault);
    if (canonical !== record.vault) {
      throw new HostVaultPointerError(`OMS host vault pointer vault is stale: ${location}.`);
    }
  }
  return { operation: "read", path: location, dryRun: options.dryRun === true, changed: false, pointer: record };
}

export async function readHostVaultPointer(
  options: HostVaultPointerOperationOptions = {},
): Promise<HostVaultPointerReceipt> {
  return readPointerRecord(options, true);
}

/** Reads a valid signed record so an explicit install/reconcile can repair a moved vault. */
export async function readHostVaultPointerForRepair(
  options: HostVaultPointerOperationOptions = {},
): Promise<HostVaultPointerReceipt> {
  return readPointerRecord(options, false);
}

export async function writeHostVaultPointer(
  vault: string,
  expectedSignature: string | undefined,
  options: HostVaultPointerOperationOptions = {},
): Promise<HostVaultPointerReceipt> {
  const location = pointerPath(options);
  const record: HostVaultPointer = {
    version: POINTER_VERSION,
    vault: await canonicalHostVault(vault),
    signature: "",
  };
  const stamped = { ...record, signature: signatureFor(record.vault) };
  if (options.dryRun === true) {
    const current = await readHostVaultPointerForRepair({ pointerPath: location });
    if (expectedSignature !== current.pointer?.signature) {
      throw new HostVaultPointerError(`OMS host vault pointer changed concurrently: ${location}.`);
    }
    return { operation: "write", path: location, dryRun: true, changed: current.pointer?.signature !== stamped.signature, pointer: stamped };
  }
  return withPointerLock(location, async () => {
    const current = await readHostVaultPointerForRepair({ pointerPath: location });
    if (expectedSignature !== current.pointer?.signature) {
      throw new HostVaultPointerError(`OMS host vault pointer changed concurrently: ${location}.`);
    }
    const parent = path.dirname(location);
    const temporary = path.join(parent, `.${POINTER_FILE}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(stamped)}\n`, { encoding: "utf-8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, location);
    } finally {
      await rm(temporary, { force: true });
    }
    return { operation: "write", path: location, dryRun: false, changed: current.pointer?.signature !== stamped.signature, pointer: stamped };
  });
}

export async function deleteHostVaultPointer(
  expectedSignature: string | undefined,
  options: HostVaultPointerOperationOptions = {},
): Promise<HostVaultPointerReceipt> {
  const location = pointerPath(options);
  if (options.dryRun === true) {
    const current = await readHostVaultPointerForRepair({ pointerPath: location });
    if (expectedSignature !== current.pointer?.signature) {
      throw new HostVaultPointerError(`OMS host vault pointer changed concurrently: ${location}.`);
    }
    return { operation: "remove", path: location, dryRun: options.dryRun === true, changed: current.pointer !== undefined, pointer: current.pointer };
  }
  return withPointerLock(location, async () => {
    const current = await readHostVaultPointerForRepair({ pointerPath: location });
    if (expectedSignature !== current.pointer?.signature) {
      throw new HostVaultPointerError(`OMS host vault pointer changed concurrently: ${location}.`);
    }
    if (current.pointer === undefined) return { operation: "remove", path: location, dryRun: false, changed: false };
    await rm(location);
    return { operation: "remove", path: location, dryRun: false, changed: true, pointer: current.pointer };
  });
}
