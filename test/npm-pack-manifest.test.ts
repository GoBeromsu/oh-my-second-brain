import { describe, expect, it } from "vitest";
import { parseNpmPackManifest } from "../scripts/npm-pack-manifest.mjs";

const name = "oh-my-second-brain";
// Synthetic package metadata with the fields returned by npm 10/11 and 12.
// Error responses below are deliberately not repaired into successful packages.
const manifest = {
  id: `${name}@1.0.0`, name, version: "1.0.0", size: 512, unpackedSize: 64,
  shasum: "0".repeat(40), integrity: "sha512-c3ludGhldGlj", filename: `${name}-1.0.0.tgz`,
  files: [{ path: "package.json", size: 64, mode: 420 }], entryCount: 1, bundled: [],
};
const formats = [
  ["npm 10/11 array", (pack: unknown) => [pack]],
  ["npm 12 keyed record", (pack: unknown) => ({ [name]: pack })],
] as const;

describe("single-package npm pack manifests", () => {
  it.each(formats)("accepts the %s and preserves its metadata", (_label, wrap) => {
    expect(parseNpmPackManifest(JSON.stringify(wrap(manifest)), name)).toEqual(manifest);
  });

  it("supports package-name keys for scoped packages", () => {
    const scoped = { ...manifest, id: "@example/fixture@1.0.0", name: "@example/fixture", filename: "example-fixture-1.0.0.tgz",
      files: [...manifest.files, { path: "docs/한글 note.md", size: 0, mode: 420 }], entryCount: 2 };
    expect(parseNpmPackManifest(JSON.stringify({ [scoped.name]: scoped }), scoped.name)).toEqual(scoped);
  });

  it.each([
    ["empty array", []], ["multiple array entries", [manifest, manifest]],
    ["empty record", {}], ["multiple package keys", { [name]: manifest, other: manifest }],
    ["wrong package key", { other: manifest }], ["unkeyed report", manifest],
    ["npm error", { error: { code: "ENOENT", summary: "Missing package.json", detail: "synthetic failure" } }],
    ["error alongside a package", { [name]: manifest, error: { code: "EPERM" } }],
    ["null", null], ["string", "package"], ["number", 1], ["boolean", true],
  ])("rejects %s containers", (_label, output) => {
    expect(() => parseNpmPackManifest(JSON.stringify(output), name)).toThrow(/Invalid npm pack JSON/);
  });

  for (const [label, wrap] of formats) {
    it.each([
      ["null report", null], ["array report", [manifest]],
      ["error report", { error: { code: "ENOENT" } }],
      ["error on otherwise valid report", { ...manifest, error: { code: "EPERM" } }],
      ["missing name", { ...manifest, name: undefined }],
      ["wrong name", { ...manifest, name: "another-package" }],
      ["missing files", { ...manifest, files: undefined }],
      ["non-array files", { ...manifest, files: { path: "package.json" } }],
      ["empty files", { ...manifest, files: [] }],
      ["null file", { ...manifest, files: [null] }],
      ["array file", { ...manifest, files: [["package.json"]] }],
      ["missing file path", { ...manifest, files: [{}] }],
      ["numeric file path", { ...manifest, files: [{ path: 1 }] }],
      ["empty file path", { ...manifest, files: [{ path: "" }] }],
      ["duplicate file path", { ...manifest, files: [...manifest.files, ...manifest.files] }],
      ["escaping file path", { ...manifest, files: [{ path: "../outside" }] }],
      ["absolute file path", { ...manifest, files: [{ path: "/outside" }] }],
      ["drive file path", { ...manifest, files: [{ path: "C:/outside" }] }],
      ["backslash file path", { ...manifest, files: [{ path: "dir\\file" }] }],
      ["NUL file path", { ...manifest, files: [{ path: "file\0" }] }],
      ["missing filename", { ...manifest, filename: undefined }],
      ["empty filename", { ...manifest, filename: "" }],
      ["numeric filename", { ...manifest, filename: 1 }],
      ["non-tarball filename", { ...manifest, filename: "package.json" }],
      ["missing filename stem", { ...manifest, filename: ".tgz" }],
      ["escaping filename", { ...manifest, filename: "../outside.tgz" }],
      ["nested filename", { ...manifest, filename: "dir/package.tgz" }],
    ])(`rejects %s in ${label}`, (_reason, pack) => {
      expect(() => parseNpmPackManifest(JSON.stringify(wrap(pack)), name)).toThrow(/Invalid npm pack JSON/);
    });
  }

  it("rejects invalid JSON instead of salvaging a partial response", () => {
    expect(() => parseNpmPackManifest("npm notice\n" + JSON.stringify([manifest]), name)).toThrow(/could not parse JSON/);
  });

  it.each([undefined, null, "", "  "])("requires an expected package name (%s)", expectedName => {
    expect(() => parseNpmPackManifest(JSON.stringify([manifest]), expectedName)).toThrow(/expected package name/);
  });
});
