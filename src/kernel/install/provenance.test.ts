import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeTreeDigest,
  decideOwnership,
  parseProvenance,
  serializeProvenance,
  type OmsInstallProvenance,
} from "./provenance.js";

const roots: string[] = [];
const expected = { version: "0.11.0", skillTreeDigest: "expected-digest" };
const matching: OmsInstallProvenance = {
  schemaVersion: 1,
  source: "npm",
  version: expected.version,
  skillTreeDigest: expected.skillTreeDigest,
  installedAt: "2026-09-01T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }))));
});

describe("OMS install provenance", () => {
  it("round-trips valid records and tolerates unknown fields", () => {
    const serialized = serializeProvenance(matching);
    expect(parseProvenance(serialized)).toEqual(matching);
    expect(parseProvenance('{"schemaVersion":1,"source":"npm","version":"0.11.0","skillTreeDigest":"x","installedAt":"now","future":true}')).toMatchObject({ version: "0.11.0" });
    expect(parseProvenance("not json")).toBeNull();
    expect(parseProvenance('{"schemaVersion":2}')).toBeNull();
  });

  it("hashes sorted relative paths and bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-provenance-"));
    roots.push(root);
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "z.txt"), "z");
    await writeFile(path.join(root, "nested", "a.txt"), "a");

    expect(await computeTreeDigest(root)).toBe("11931989af15faac33fe84458ebc88e766673f121a4d5de4ab3bbaeefbb8df9d");
  });

  it.each([
    ["installs an absent tree", null, null, "install"],
    ["adopts a matching unrecorded legacy tree", null, expected.skillTreeDigest, "adopt-legacy-candidate"],
    ["rejects an unrecorded foreign tree", null, "foreign-digest", "reject-foreign"],
    ["accepts a complete matching npm identity", matching, expected.skillTreeDigest, "noop"],
    ["replaces an older npm version", { ...matching, version: "0.10.1" }, expected.skillTreeDigest, "replace"],
    ["replaces a tampered npm tree", matching, "tampered-digest", "replace"],
    ["rejects a newer npm version", { ...matching, version: "0.11.1" }, expected.skillTreeDigest, "reject-newer"],
  ] as const)("%s", (_name, existing, actualTreeDigest, action) => {
    expect(decideOwnership(existing, expected, actualTreeDigest).action).toBe(action);
  });
});
