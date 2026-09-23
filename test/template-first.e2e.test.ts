import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeApprovedVault } from "../src/kernel/templates/approved-vault-fixture.js";

/**
 * Guide, save, check, search — end to end through the built CLI.
 *
 * The agent writes the note. OMS guides before the save, inspects the bytes
 * afterwards, and keeps search working regardless of whether any note satisfies
 * its contract.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCli = path.join(repoRoot, "dist", "cli", "oms.js");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function runCli(args: readonly string[]) {
  if (!existsSync(distCli)) {
    throw new Error("dist/cli/oms.js is missing; run npm run build before end-to-end tests.");
  }
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, OMS_NO_UPDATE_NOTICE: "1" },
  });
}

function parse(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function vault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "oms-template-first-"));
  roots.push(root);
  await writeApprovedVault(root, {
    properties: {
      title: { type: "text", intent: "Note title." },
      status: { type: "select", intent: "Workflow state.", allowedValues: ["open", "closed"] },
    },
    templates: {
      note: {
        fields: ["title", "status"],
        approvedMarkdown: "---\ntemplate: note\ntitle: Untitled\nstatus: open\n---\n\n## Summary\n",
        headings: [{ headingId: "summary", title: "Summary", level: 2 }],
        targetFolder: "notes",
      },
    },
    folders: { notes: { intent: "Working notes." } },
    obsidianTypes: { title: "text", status: "select" },
  });
  await mkdir(path.join(root, "notes"), { recursive: true });
  return root;
}

describe("guide, save, check, search", () => {
  it("guides before the save, then checks the bytes the agent wrote", async () => {
    const root = await vault();

    const guide = runCli(["note", "guide", "notes/alpha.md", "--vault", root, "--template-id", "note"]);
    expect(guide.status).toBe(0);
    const guidance = parse(guide.stdout);
    expect(guidance.status).toBe("guided");
    // Guidance never creates the note.
    expect(await readdir(path.join(root, "notes"))).toEqual([]);

    // The agent saves an incomplete note.
    const notePath = path.join(root, "notes", "alpha.md");
    await writeFile(notePath, "---\ntemplate: note\ntitle: Alpha\n---\n\nBody without the required heading.\n");
    const incomplete = runCli(["note", "check", "notes/alpha.md", "--vault", root]);
    const failing = parse(incomplete.stdout);
    expect(failing.status).toBe("fail");
    const findings = (failing.machine as { readonly findings: readonly { readonly targetId: string }[] }).findings;
    expect(findings.map(finding => finding.targetId)).toEqual(
      expect.arrayContaining(["field/status", "heading/summary"]),
    );

    // OMS reports; it does not repair the note.
    expect(await readFile(notePath, "utf8")).toContain("Body without the required heading.");

    await writeFile(notePath, "---\ntemplate: note\ntitle: Alpha\nstatus: open\nextra: kept\n---\n\n## Summary\n\nDone.\n");
    const complete = runCli(["note", "check", "notes/alpha.md", "--vault", root]);
    const passing = parse(complete.stdout);
    expect(passing.status).toBe("pass");
    // An undeclared property is preserved and never judged.
    expect(await readFile(notePath, "utf8")).toContain("extra: kept");
  });

  it("rejects a disallowed value without inventing one", async () => {
    const root = await vault();
    await writeFile(
      path.join(root, "notes", "bad-status.md"),
      "---\ntemplate: note\ntitle: Bad\nstatus: archived\n---\n\n## Summary\n\nBody.\n",
    );

    const checked = parse(runCli(["note", "check", "notes/bad-status.md", "--vault", root]).stdout);

    expect(checked.status).toBe("fail");
    const findings = (checked.machine as { readonly findings: readonly { readonly targetId: string }[] }).findings;
    expect(findings.map(finding => finding.targetId)).toContain("field/status");
    expect(await readFile(path.join(root, "notes", "bad-status.md"), "utf8")).toContain("status: archived");
  });

  it("searches unbound, unknown-template, and malformed notes alike", async () => {
    const root = await vault();
    await writeFile(path.join(root, "notes", "bound.md"), "---\ntemplate: note\ntitle: Bound\nstatus: open\n---\n\n## Summary\n\nIndexable prose about ataraxia.\n");
    await writeFile(path.join(root, "notes", "unbound.md"), "Plain note about ataraxia with no frontmatter.\n");
    await writeFile(path.join(root, "notes", "unknown.md"), "---\ntemplate: ghost\n---\n\nUnknown template, still about ataraxia.\n");
    await writeFile(path.join(root, "notes", "malformed.md"), "---\ntitle: [unterminated\n---\n\nMalformed frontmatter, still about ataraxia.\n");

    const search = runCli(["search", "query", "ataraxia", "--vault", root]);

    expect(search.status).toBe(0);
    const payload = parse(search.stdout);
    const hits = (payload.hits ?? payload.results) as { readonly path?: string; readonly notePath?: string }[];
    const paths = hits.map(hit => hit.path ?? hit.notePath);
    expect(paths).toEqual(expect.arrayContaining([
      "notes/bound.md",
      "notes/unbound.md",
      "notes/unknown.md",
      "notes/malformed.md",
    ]));
  });

  it("keeps searching when the approved contract is unreadable", async () => {
    const root = await vault();
    await writeFile(path.join(root, "notes", "bound.md"), "---\ntemplate: note\ntitle: Bound\nstatus: open\n---\n\n## Summary\n\nProse about ataraxia.\n");
    await writeFile(path.join(root, ".oms", "template-policy.json"), "{");

    const search = runCli(["search", "query", "ataraxia", "--vault", root]);

    expect(search.status).toBe(0);
    const payload = parse(search.stdout);
    const hits = (payload.hits ?? payload.results) as { readonly path?: string; readonly notePath?: string }[];
    expect(hits.map(hit => hit.path ?? hit.notePath)).toContain("notes/bound.md");
  });

  it("does not create .oms while reading a vault that has none", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oms-template-first-bare-"));
    roots.push(root);
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes", "plain.md"), "Prose about ataraxia.\n");

    const search = runCli(["search", "query", "ataraxia", "--vault", root]);

    expect(search.status).toBe(0);
    expect(existsSync(path.join(root, ".oms"))).toBe(false);
  });
});
