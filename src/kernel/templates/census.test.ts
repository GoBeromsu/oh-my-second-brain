import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestBytes } from "./canonical.js";
import { MAX_TEMPLATE_SOURCE_BYTES, scanTemplateSources } from "./census.js";

const encoder = new TextEncoder();
const roots: string[] = [];

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oms-template-census-"));
  roots.push(root);
  return root;
}

async function put(root: string, relativePath: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(root, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

/** Byte-level image of the vault, so "reads nothing" is proved rather than assumed. */
async function signature(root: string): Promise<string> {
  const rows: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const name = relative(root, full).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) rows.push(`link ${name}`);
      else if (entry.isDirectory()) {
        rows.push(`dir ${name}`);
        await walk(full);
      } else if (entry.isFile()) rows.push(`file ${name} ${digestBytes(new Uint8Array(await readFile(full)))}`);
      else rows.push(`other ${name}`);
    }
  }
  await walk(root);
  return rows.join("\n");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("raw template source discovery", () => {
  it("preserves raw Templater text, a BOM, and CRLF without parsing or executing it", async () => {
    const root = await vault();
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("line\r\n<% tp.file.title %>\r\n${Date.now()}\r\n", "utf8"),
    ]);
    await put(root, "Templates/raw.md", bytes);

    const inventory = await scanTemplateSources(root, [{ path: "Templates", kind: "folder" }]);

    expect(inventory.complete).toBe(true);
    expect(inventory.sources).toHaveLength(1);
    expect(inventory.sources[0]?.path).toBe("Templates/raw.md");
    expect(inventory.sources[0]?.text).toBe("\uFEFFline\r\n<% tp.file.title %>\r\n${Date.now()}\r\n");
    expect(inventory.sources[0]?.rawDigest).toBe(digestBytes(new Uint8Array(bytes)));
    // The execution syntax survives as text; nothing evaluated it.
    expect(inventory.sources[0]?.text).toContain("<% tp.file.title %>");
    expect(inventory.diagnostics).toEqual([]);
  });

  it("reports a non-UTF8 or oversize source without dropping the raw digest of its bytes", async () => {
    const root = await vault();
    const invalid = Uint8Array.from([0xff, 0xfe, 0x00]);
    const oversize = new Uint8Array(MAX_TEMPLATE_SOURCE_BYTES + 1).fill(0x61);
    await put(root, "Templates/invalid.md", invalid);
    await put(root, "Templates/big.md", oversize);
    await put(root, "Templates/good.md", "usable\n");

    const inventory = await scanTemplateSources(root, [{ path: "Templates", kind: "folder" }]);

    const byPath = new Map(inventory.sources.map(source => [source.path, source]));
    expect(byPath.get("Templates/good.md")?.text).toBe("usable\n");
    // Unusable bytes are still identified; they are simply not decoded.
    expect(byPath.get("Templates/invalid.md")).toMatchObject({ text: null, rawDigest: digestBytes(invalid) });
    expect(byPath.get("Templates/big.md")?.text ?? null).toBeNull();
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics.map(item => item.code)).toEqual(
      expect.arrayContaining(["TEMPLATE_SOURCE_MALFORMED", "TEMPLATE_PROPOSAL_OVERSIZE"]),
    );
  });

  it("keeps explicit file and folder selections raw and refuses symlink or private paths", async () => {
    const root = await vault();
    const outside = await vault();
    await put(outside, "secret.md", "outside\n");
    await put(root, "Templates/kept.md", "kept\n");
    await put(root, "Notes/one.md", "note\n");
    await put(root, ".oms/templates/managed.md", "managed\n");
    await symlink(join(outside, "secret.md"), join(root, "Templates", "alias.md"));
    const before = await signature(root);

    const explicit = await scanTemplateSources(root, [{ path: "Templates/kept.md", kind: "file" }]);
    expect(explicit.sources.map(source => source.path)).toEqual(["Templates/kept.md"]);

    const folder = await scanTemplateSources(root, [{ path: "Templates", kind: "folder" }]);
    // The symlink alias is refused, not followed outside the vault.
    expect(folder.sources.map(source => source.path)).toEqual(["Templates/kept.md"]);
    expect(folder.complete).toBe(false);
    expect(JSON.stringify(folder)).not.toContain("outside");

    // A private control path is never a discoverable source.
    const priv = await scanTemplateSources(root, [{ path: ".oms/templates", kind: "folder" }]);
    expect(priv.sources).toEqual([]);
    expect(priv.diagnostics.length).toBeGreaterThan(0);

    expect(await signature(root)).toBe(before);
  });

  it("reports a missing selection and writes nothing at all", async () => {
    const root = await vault();
    await put(root, "Templates/kept.md", "kept\n");
    const before = await signature(root);

    const inventory = await scanTemplateSources(root, [
      { path: "Templates/kept.md", kind: "file" },
      { path: "Templates/absent.md", kind: "file" },
    ]);

    expect(inventory.sources.map(source => source.path)).toEqual(["Templates/kept.md"]);
    expect(inventory.complete).toBe(false);
    expect(inventory.diagnostics.map(item => item.code)).toContain("TEMPLATE_SOURCE_MISSING");
    expect(await signature(root)).toBe(before);
    // Discovery never creates the private control directory.
    expect(await readdir(root)).toEqual(["Templates"]);
  });
});
