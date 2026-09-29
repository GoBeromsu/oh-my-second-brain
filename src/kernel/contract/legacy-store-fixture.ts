import { mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareCodePoints, digestBytes, type Digest } from "../conventions/canonical.js";
import { manifestDigestOf } from "./digest.js";
import { storeRoot, writeIndexEntry } from "./store.js";
import type { LegacyTemplateContract, VaultContract } from "./types.js";

/**
 * Writes a generation the way manifest versions 1 and 2 did, templates included, for tests
 * and tools that need a store sealed before version 3. The current writer never produces
 * this shape; it exists so the permanent v1/v2 read path and the forward-only reseal stay
 * exercised. Like a store sealed before lineage existed, it records no lineage events.
 */

export interface LegacyGenerationRequest {
  readonly vaultRealPath: string;
  readonly vaultId: string;
  readonly contract: VaultContract;
  readonly templates: Readonly<Record<string, LegacyTemplateContract>>;
  /** Version 1 stored a declined set that also named templates; version 2 is the default. */
  readonly version?: 1 | 2;
  readonly declined?: { readonly folders: readonly string[]; readonly properties: readonly string[]; readonly templates: Readonly<Record<string, string>> };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodePoints(left, right)).map(([key, nested]) => [key, sortKeys(nested)]));
}

function stringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function legacyFiles(request: LegacyGenerationRequest): Map<string, string> {
  const files = new Map<string, string>();
  const declined = request.declined;
  if (declined !== undefined) files.set("declined.json", stringify({ version: 1, ...declined }));
  if (request.contract.folders !== null) files.set("folders.json", stringify({ version: 1, folders: request.contract.folders }));
  if (request.contract.properties !== null) files.set("properties.json", stringify({ version: 1, properties: request.contract.properties }));
  for (const [name, template] of Object.entries(request.templates)) files.set(`templates/${name}.json`, stringify(template));
  return files;
}

/** Links a new legacy generation as the head and returns its manifest digest (the revision). */
export async function sealLegacyGeneration(request: LegacyGenerationRequest, root: string = storeRoot()): Promise<Digest> {
  const id = request.vaultId;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const taken = (await readdir(root)).flatMap(name => {
    const match = new RegExp(`^\\.${id}\\.(\\d{1,9})$`).exec(name);
    return match === null ? [] : [Number(match[1])];
  });
  const generation = `.${id}.${Math.max(0, ...taken) + 1}`;
  const directory = path.join(root, generation);
  const digests: Record<string, Digest> = {};
  for (const [relative, content] of legacyFiles(request)) {
    const absolute = path.join(directory, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, content, { mode: 0o600 });
    digests[relative] = digestBytes(content);
  }
  const manifest = stringify({ version: request.version ?? 2, files: digests });
  await writeFile(path.join(directory, "manifest.json"), manifest, { mode: 0o600 });
  const temporary = path.join(root, `.${id}.link-tmp`);
  await rm(temporary, { force: true });
  await symlink(generation, temporary);
  await rename(temporary, path.join(root, id));
  await writeIndexEntry(request.vaultRealPath, id, root);
  return manifestDigestOf(manifest);
}
