import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { HostOperationOptions } from "./types.js";

export class InstallTargetSymlinkError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`Refusing to replace symlinked Oh My Second Brain install target: ${target}`);
    this.name = "InstallTargetSymlinkError";
    this.target = target;
  }
}

export function commandExists(command: string): boolean {
  const result = spawnSync(
    process.platform === "win32" ? "where" : "command",
    process.platform === "win32" ? [command] : ["-v", command],
    {
      stdio: "ignore",
      shell: process.platform !== "win32",
    },
  );
  return result.status === 0;
}

export function hostHome(homeDir: string | undefined, dirname: string, envName: string): string {
  const override = process.env[envName];
  return override ? path.resolve(override) : path.join(homeDir ?? homedir(), dirname);
}

export function mcpArgs(options: HostOperationOptions): string[] {
  return ["mcp", "--vault", options.vault];
}

export function jsonString(value: string): string {
  return JSON.stringify(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeJsonObject(
  file: string,
  data: Record<string, unknown>,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return true;
}

export async function readYamlObject(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = yamlParse(await readFile(file, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeYamlObject(
  file: string,
  data: Record<string, unknown>,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, yamlStringify(data), "utf-8");
  return true;
}

export function mcpServerEntry(options: HostOperationOptions): Record<string, unknown> {
  return {
    command: "oms",
    args: mcpArgs(options),
  };
}

export function runExternal(command: string, args: string[]): { ok: boolean; message: string } {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf-8" });
  if (result.status === 0) return { ok: true, message: `${command} ${args.join(" ")}` };
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return { ok: false, message: stderr || stdout || `${command} exited ${result.status ?? "unknown"}` };
}

function refuseSymlinkedLeaf(target: string): void {
  if (!existsSync(target)) return;
  if (lstatSync(target).isSymbolicLink()) {
    throw new InstallTargetSymlinkError(target);
  }
}

export async function replaceDirectory(source: string, target: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) return false;
  refuseSymlinkedLeaf(target);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  return true;
}
