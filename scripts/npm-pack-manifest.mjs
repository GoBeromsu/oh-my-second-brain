// npm 12 changed pack --json from an array to a record keyed by package name.
// https://github.com/npm/cli/releases/tag/v12.0.0
// Keep every packaging gate on the same strict single-package contract.
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const packagePath = value => typeof value === "string" && value.length > 0
  && !value.includes("\\") && !value.includes("\0") && !/^[a-z]:/iu.test(value)
  && value.split("/").every(part => part !== "" && part !== "." && part !== "..");

function invalid(detail) {
  throw new Error(`Invalid npm pack JSON: ${detail}.`);
}

/**
 * Accept one legacy array entry or one npm-12 package-name entry. An error
 * response, an unkeyed report, or multiple packages is never a valid manifest.
 * Unused npm metadata is preserved; the fields consumed by our gates are checked.
 * @param {string} output
 * @param {string} expectedName Name from the package being checked.
 */
export function parseNpmPackManifest(output, expectedName) {
  if (typeof expectedName !== "string" || expectedName.trim() === "") invalid("expected package name is required");
  let result;
  try { result = JSON.parse(output); }
  catch { invalid("could not parse JSON"); }

  let pack;
  if (Array.isArray(result)) {
    if (result.length !== 1) invalid("expected exactly one package");
    [pack] = result;
  } else if (isRecord(result)) {
    const keys = Object.keys(result);
    if (keys.length !== 1 || keys[0] !== expectedName) invalid("expected one entry keyed by the package name");
    pack = result[expectedName];
  } else invalid("expected a single-package array or keyed record");

  if (!isRecord(pack) || Object.hasOwn(pack, "error") || pack.name !== expectedName) invalid("package name does not match or report contains an error");
  if (!packagePath(pack.filename) || pack.filename.includes("/") || pack.filename.length <= 4 || !pack.filename.endsWith(".tgz")) invalid("expected a tarball filename");
  if (!Array.isArray(pack.files) || pack.files.length === 0) invalid("expected a non-empty files array");
  const paths = new Set();
  for (const file of pack.files) {
    if (!isRecord(file) || !packagePath(file.path) || paths.has(file.path)) invalid("invalid or duplicate file path");
    paths.add(file.path);
  }
  return pack;
}
