import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadOntology } from "../ontology/loader.js";
import type { Concept, Ontology } from "../ontology/types.js";
import {
  commitCapture,
  evaluateStagedNote,
  prepareCapture,
  safeVaultNotePath,
  writeNote,
} from "./safe.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../");
const fixtureVault = path.join(repoRoot, "test", "fixtures", "vault");
const ontologyDir = path.join(repoRoot, "core", "ontology");

let tmpVault: string | undefined;

afterEach(async () => {
  if (tmpVault) {
    await rm(tmpVault, { recursive: true, force: true });
    tmpVault = undefined;
  }
});

describe("safe capture", () => {
  it("rejects paths outside the vault and internal Oh My Second Brain folders", () => {
    expect(() => safeVaultNotePath("/tmp/vault", "../../escape.md")).toThrow(/unsafe|inside/);
    expect(() => safeVaultNotePath("/tmp/vault", "/tmp/vault/note.md")).toThrow(/relative/);
    expect(() => safeVaultNotePath("/tmp/vault", ".oms/cache/bad.md")).toThrow(/internal/);
    expect(() => safeVaultNotePath("/tmp/vault", "references/no-extension")).toThrow(/\.md/);
  });

  it("asks for missing required fields instead of writing incomplete captures", async () => {
    const ontology = await loadOntology(ontologyDir);
    const plan = prepareCapture({
      vault: "/tmp/vault",
      ontology,
      concept: "literature",
      frontmatter: { title: "Incomplete" },
    });

    expect(plan.action).toBe("ask-missing-fields");
    expect(plan.missingFields).toEqual(["source-url"]);

    const whitespacePlan = prepareCapture({
      vault: "/tmp/vault",
      ontology,
      concept: "literature",
      frontmatter: { title: "   ", "source-url": "https://example.com" },
    });
    expect(whitespacePlan.action).toBe("ask-missing-fields");
    expect(whitespacePlan.missingFields).toEqual(["title"]);
  });

  it("routes ambiguous captures to inbox", async () => {
    const ontology = await loadOntology(ontologyDir);
    const plan = prepareCapture({
      vault: "/tmp/vault",
      ontology,
      concept: "missing-concept",
      folder: "unknown",
      frontmatter: { title: "Loose thought" },
    });

    expect(plan.action).toBe("route-to-inbox");
    expect(plan.folder).toBe("inbox");
    expect(plan.notePath.startsWith("inbox/")).toBe(true);
  });

  it("does not return unsafe planned paths from caller-supplied filenames", async () => {
    const ontology = await loadOntology(ontologyDir);
    const plan = prepareCapture({
      vault: "/tmp/vault",
      ontology,
      concept: "literature",
      filename: "../../escape.md",
      frontmatter: {
        title: "Safe title",
        "source-url": "https://example.com/safe-title",
      },
    });

    expect(plan.action).toBe("route-to-inbox");
    expect(plan.notePath).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-safe-title\.md$/);
    expect(plan.notePath).not.toContain("..");
  });

  it("creates and appends only inside the vault after contract validation", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-capture-"));
    await cp(fixtureVault, tmpVault, { recursive: true });
    const ontology = await loadOntology(ontologyDir);
    const notePath = "references/new-book.md";
    const frontmatter = {
      title: "New Book",
      "source-url": "https://example.com/new-book",
    };

    await expect(
      commitCapture({
        vault: tmpVault,
        source: "vault",
        ontology,
        notePath,
        frontmatter,
        body: "Initial body.",
        mode: "create",
      }),
    ).resolves.toEqual({ written: true, mode: "create", notePath });

    await expect(
      commitCapture({
        vault: tmpVault,
        source: "vault",
        ontology,
        notePath,
        frontmatter,
        body: "Appended body.",
        mode: "append",
      }),
    ).resolves.toEqual({ written: true, mode: "append", notePath });

    const written = await readFile(path.join(tmpVault, notePath), "utf-8");
    expect(written).toContain("Initial body.");
    expect(written).toContain("Appended body.");

    await expect(
      commitCapture({
        vault: tmpVault,
        source: "vault",
        ontology,
        notePath: "../../outside.md",
        frontmatter,
        body: "Bad",
        mode: "create",
      }),
    ).rejects.toThrow(/unsafe|inside/);
  });
});

const LITERATURE: Concept = {
  concept: "literature",
  intent: "A processed reference.",
  folder: "references",
  fields: [
    { name: "title", type: "string", required: true, intent: "Title." },
    { name: "source-url", type: "url", required: true, intent: "Canonical URL." },
    {
      name: "status",
      type: "string",
      required: false,
      intent: "Publication state.",
      enum: ["draft", "published", "archived"],
    },
  ],
};

function testOntology(): Ontology {
  return {
    taxonomy: {
      version: 1,
      folders: {
        references: { intent: "refs", concept: "literature" },
        inbox: { intent: "inbox", concept: "inbox" },
      },
    },
    concepts: new Map([
      ["literature", LITERATURE],
      ["inbox", { concept: "inbox", intent: "inbox", folder: "inbox", fields: [] }],
    ]),
  };
}

describe("writeNote kernel", () => {
  it("asks on create when required or enum fields fail and does not write", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-write-ask-"));
    const ontology = testOntology();
    const missing = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "create",
      dryRun: false,
      concept: "literature",
      frontmatter: { title: "Only title" },
      body: "Body",
    });
    expect(missing.status).toBe("ask");
    expect(missing.missingFields).toContain("source-url");
    expect(missing.fields.map((field) => field.name)).toContain("source-url");

    const badEnum = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "create",
      dryRun: false,
      notePath: "references/enum.md",
      frontmatter: {
        title: "Enum",
        "source-url": "https://example.com/enum",
        status: "preview",
      },
      body: "Body",
    });
    expect(badEnum.status).toBe("ask");
    expect(badEnum.violations.map((violation) => violation.rule)).toContain("enum");
  });

  it("creates, appends, and updates when the contract passes, preserving extra keys", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-write-ok-"));
    const ontology = testOntology();
    const notePath = "references/new-book.md";
    const created = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "create",
      dryRun: false,
      notePath,
      frontmatter: {
        title: "New Book",
        "source-url": "https://example.com/new-book",
        "my-rating": 5,
      },
      body: "Initial body.",
    });
    expect(created).toMatchObject({ status: "written", mode: "create", notePath });
    expect(created.receipt).toMatchObject({
      mode: "create",
      notePath,
      postconditionVerified: true,
    });

    const appended = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "append",
      dryRun: false,
      notePath,
      body: "Appended body.",
    });
    expect(appended).toMatchObject({ status: "written", mode: "append", notePath });
    expect(appended.receipt).toMatchObject({ mode: "append", postconditionVerified: true });

    const updated = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "update",
      dryRun: false,
      notePath,
      frontmatter: { status: "published" },
    });
    expect(updated.status).toBe("written");
    expect(updated.receipt).toMatchObject({ mode: "update", postconditionVerified: true });
    expect(updated.frontmatter["my-rating"]).toBe(5);
    expect(updated.frontmatter["status"]).toBe("published");

    const written = await readFile(path.join(tmpVault, notePath), "utf-8");
    expect(written).toContain("Initial body.");
    expect(written).toContain("Appended body.");
    expect(written).toContain("my-rating: 5");
    expect(written).toContain("status: published");
  });

  it("rejects update that breaks required fields and leaves the file unchanged", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-write-reject-"));
    const ontology = testOntology();
    const notePath = "references/keep.md";
    await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "create",
      dryRun: false,
      notePath,
      frontmatter: {
        title: "Keep",
        "source-url": "https://example.com/keep",
      },
      body: "Original.",
    });

    const rejected = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "update",
      dryRun: false,
      notePath,
      frontmatter: { title: "" },
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.violations.map((violation) => violation.rule)).toContain("required");

    const written = await readFile(path.join(tmpVault, notePath), "utf-8");
    expect(written).toContain("title: Keep");
    expect(written).toContain("Original.");
  });

  it("rejects an explicit unsafe notePath instead of writing", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-write-path-"));
    const rejected = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "../../outside.md",
      frontmatter: {
        title: "Nope",
        "source-url": "https://example.com/nope",
      },
      body: "Bad",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toMatch(/unsafe|inside|relative/);
  });
});


describe("writeNote admission rules", () => {
  const goodFrontmatter = {
    title: "Admission",
    "source-url": "https://example.com/admission",
  };

  it("rejects an unverified cwd target without touching disk", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-cwd-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "cwd" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "references/cwd.md",
      frontmatter: goodFrontmatter,
      body: "Body.",
    });

    expect(result.status).toBe("rejected");
    expect(result.rejection?.stage).toBe("admission");
    expect(result.rejection?.code).toBe("target-unverified");
    expect(result.rejection?.recoverable).toBe(true);
    expect(result.rejection?.remediation).toContain("oms setup");
    expect(result.receipt).toBeUndefined();
    expect(await readdir(tmpVault)).toEqual([]);
  });

  it("rejects an unverified cwd target for append and update too", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-cwd-modes-"));
    for (const mode of ["append", "update"] as const) {
      const result = await writeNote({
        target: { vault: tmpVault, source: "cwd" },
        ontology: testOntology(),
        mode,
        dryRun: false,
        notePath: "references/cwd.md",
        frontmatter: goodFrontmatter,
        body: "Body.",
      });
      expect(result.status).toBe("rejected");
      expect(result.rejection?.code).toBe("target-unverified");
      expect(result.mode).toBe(mode);
    }
    expect(await readdir(tmpVault)).toEqual([]);
  });

  it("rejects a global target whose vault lacks a .oms ontology", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-global-stale-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "global" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "references/stale.md",
      frontmatter: goodFrontmatter,
      body: "Body.",
    });

    expect(result.status).toBe("rejected");
    expect(result.rejection?.stage).toBe("admission");
    expect(result.rejection?.code).toBe("target-invalid");
    expect(result.rejection?.recoverable).toBe(false);
    expect(await readdir(tmpVault)).toEqual([]);
  });

  it("admits a global target whose vault carries a .oms ontology", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-global-ok-"));
    await mkdir(path.join(tmpVault, ".oms"), { recursive: true });
    await writeFile(path.join(tmpVault, ".oms", "taxonomy.yaml"), "version: 1\n", "utf-8");

    const result = await writeNote({
      target: { vault: tmpVault, source: "global" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "references/global-ok.md",
      frontmatter: goodFrontmatter,
      body: "Body.",
    });

    expect(result.status).toBe("written");
    expect(result.rejection).toBeUndefined();
    expect(await readFile(path.join(tmpVault, "references/global-ok.md"), "utf-8")).toContain(
      "Body.",
    );
  });

  it("admits a global target whose vault carries a .oms concepts dir", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-global-concepts-"));
    await mkdir(path.join(tmpVault, ".oms", "concepts"), { recursive: true });

    const result = await writeNote({
      target: { vault: tmpVault, source: "global" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "references/global-concepts.md",
      frontmatter: goodFrontmatter,
      body: "Body.",
    });

    expect(result.status).toBe("written");
    expect(result.rejection).toBeUndefined();
  });

  it("trusts vault/bridge/env/explicit sources without an ontology presence check", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-trusted-"));
    const ontology = testOntology();
    for (const source of ["vault", "bridge", "env", "explicit"] as const) {
      const result = await writeNote({
        target: { vault: tmpVault, source },
        ontology,
        mode: "create",
        dryRun: false,
        notePath: `references/${source}.md`,
        frontmatter: goodFrontmatter,
        body: "Body.",
      });
      expect(result.status).toBe("written");
      expect(result.rejection).toBeUndefined();
    }
  });

  it("stamps admission rejection codes on every legacy pre-write failure", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-legacy-"));
    const ontology = testOntology();
    const target = { vault: tmpVault, source: "vault" } as const;

    await writeNote({
      target,
      ontology,
      mode: "create",
      dryRun: false,
      notePath: "references/exists.md",
      frontmatter: goodFrontmatter,
      body: "Body.",
    });
    await writeFile(
      path.join(tmpVault, "references", "unbound.md"),
      "---\ntitle: Unbound\n---\n\nBody.\n",
      "utf-8",
    );
    await mkdir(path.join(tmpVault, "loose"), { recursive: true });
    await writeFile(
      path.join(tmpVault, "loose", "unbound.md"),
      "---\ntitle: Unbound\n---\n\nBody.\n",
      "utf-8",
    );

    const cases: Array<{
      name: string;
      input: Parameters<typeof writeNote>[0];
      code: string;
      reason: RegExp;
    }> = [
      {
        name: "note-exists",
        input: {
          target,
          ontology,
          mode: "create",
          dryRun: false,
          notePath: "references/exists.md",
          frontmatter: goodFrontmatter,
          body: "Body.",
        },
        code: "note-exists",
        reason: /Cannot create capture: target note already exists/,
      },
      {
        name: "note-missing",
        input: {
          target,
          ontology,
          mode: "update",
          dryRun: false,
          notePath: "references/nope.md",
          frontmatter: { status: "draft" },
        },
        code: "note-missing",
        reason: /Cannot update capture: target note does not exist/,
      },
      {
        name: "body-missing (create)",
        input: {
          target,
          ontology,
          mode: "create",
          dryRun: false,
          notePath: "references/no-body.md",
          frontmatter: goodFrontmatter,
        },
        code: "body-missing",
        reason: /create requires a body/,
      },
      {
        name: "body-missing (append)",
        input: {
          target,
          ontology,
          mode: "append",
          dryRun: false,
          notePath: "references/exists.md",
        },
        code: "body-missing",
        reason: /append requires a body/,
      },
      {
        name: "args-invalid (append notePath)",
        input: { target, ontology, mode: "append", dryRun: false, body: "Body." },
        code: "args-invalid",
        reason: /append requires notePath/,
      },
      {
        name: "args-invalid (update notePath)",
        input: { target, ontology, mode: "update", dryRun: false, frontmatter: { a: 1 } },
        code: "args-invalid",
        reason: /update requires notePath/,
      },
      {
        name: "args-invalid (update payload)",
        input: {
          target,
          ontology,
          mode: "update",
          dryRun: false,
          notePath: "references/exists.md",
        },
        code: "args-invalid",
        reason: /update requires frontmatter or body/,
      },
      {
        name: "concept-unbound (append)",
        input: {
          target,
          ontology,
          mode: "append",
          dryRun: false,
          notePath: "loose/unbound.md",
          body: "More.",
        },
        code: "concept-unbound",
        reason: /notePath does not resolve to a concept binding/,
      },
      {
        name: "concept-unbound (update)",
        input: {
          target,
          ontology,
          mode: "update",
          dryRun: false,
          notePath: "loose/unbound.md",
          frontmatter: { title: "Renamed" },
        },
        code: "concept-unbound",
        reason: /notePath does not resolve to a concept binding/,
      },
      {
        name: "path-unsafe (traversal)",
        input: {
          target,
          ontology,
          mode: "create",
          dryRun: false,
          notePath: "../../outside.md",
          frontmatter: goodFrontmatter,
          body: "Body.",
        },
        code: "path-unsafe",
        reason: /unsafe|inside|relative/,
      },
      {
        name: "path-unsafe (absolute)",
        input: {
          target,
          ontology,
          mode: "append",
          dryRun: false,
          notePath: `${tmpVault}/references/exists.md`,
          body: "Body.",
        },
        code: "path-unsafe",
        reason: /relative/,
      },
      {
        name: "path-unsafe (hidden dir)",
        input: {
          target,
          ontology,
          mode: "update",
          dryRun: false,
          notePath: ".oms/cache/bad.md",
          frontmatter: { title: "Bad" },
        },
        code: "path-unsafe",
        reason: /hidden|internal|dependency/,
      },
    ];

    for (const testCase of cases) {
      const result = await writeNote(testCase.input);
      expect(result.status, testCase.name).toBe("rejected");
      expect(result.rejection?.code, testCase.name).toBe(testCase.code);
      expect(result.rejection?.stage, testCase.name).toBe("admission");
      expect(result.receipt, testCase.name).toBeUndefined();
      expect(result.reason ?? "", testCase.name).toMatch(testCase.reason);
    }
  });

  it("attaches a contract-violation rejection to ask results without changing status", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-ask-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "references/ask.md",
      frontmatter: { title: "Only title" },
      body: "Body.",
    });

    expect(result.status).toBe("ask");
    expect(result.missingFields).toContain("source-url");
    expect(result.rejection?.stage).toBe("admission");
    expect(result.rejection?.code).toBe("contract-violation");
    expect(result.rejection?.recoverable).toBe(true);
    expect(result.rejection?.remediation).toContain("source-url");
    expect(result.receipt).toBeUndefined();
    expect(await readdir(tmpVault)).toEqual([]);
  });

  it("keeps inbox routing free of rejection and receipt payloads", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-admit-inbox-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      concept: "missing-concept",
      folder: "unknown",
      frontmatter: { title: "Loose thought" },
      body: "Body.",
    });

    expect(result.status).toBe("inbox");
    expect(result.rejection).toBeUndefined();
    expect(result.receipt).toBeUndefined();
  });
});

describe("writeNote acceptance criteria", () => {
  const goodFrontmatter = {
    title: "Acceptance",
    "source-url": "https://example.com/acceptance",
  };

  const RATED: Concept = {
    concept: "literature",
    intent: "A processed reference with a numeric rating.",
    folder: "references",
    fields: [
      { name: "title", type: "string", required: true, intent: "Title." },
      { name: "source-url", type: "url", required: true, intent: "Canonical URL." },
      { name: "rating", type: "number", required: true, intent: "Numeric rating." },
    ],
  };

  it("issues a receipt naming the resolved vault and resolution source on create", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-create-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "explicit" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "references/receipt.md",
      frontmatter: goodFrontmatter,
      body: "Body.",
    });

    expect(result.status).toBe("written");
    expect(result.rejection).toBeUndefined();
    expect(result.receipt).toEqual({
      resolvedVault: tmpVault,
      resolutionSource: "explicit",
      notePath: "references/receipt.md",
      mode: "create",
      concept: "literature",
      postconditionVerified: true,
    });
  });

  it("issues receipts for append and update on an existing note", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-modes-"));
    const ontology = testOntology();
    const notePath = "references/modes.md";
    await writeNote({
      target: { vault: tmpVault, source: "bridge" },
      ontology,
      mode: "create",
      dryRun: false,
      notePath,
      frontmatter: goodFrontmatter,
      body: "Initial body.",
    });

    const appended = await writeNote({
      target: { vault: tmpVault, source: "bridge" },
      ontology,
      mode: "append",
      dryRun: false,
      notePath,
      body: "Appended body.",
    });
    expect(appended.status).toBe("written");
    expect(appended.receipt).toEqual({
      resolvedVault: tmpVault,
      resolutionSource: "bridge",
      notePath,
      mode: "append",
      concept: "literature",
      postconditionVerified: true,
    });

    const updated = await writeNote({
      target: { vault: tmpVault, source: "env" },
      ontology,
      mode: "update",
      dryRun: false,
      notePath,
      frontmatter: { status: "published" },
    });
    expect(updated.status).toBe("written");
    expect(updated.receipt).toEqual({
      resolvedVault: tmpVault,
      resolutionSource: "env",
      notePath,
      mode: "update",
      concept: "literature",
      postconditionVerified: true,
    });
  });

  it("keeps receipt.mode aligned with result.mode when append creates the note", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-append-create-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology: testOntology(),
      mode: "append",
      dryRun: false,
      notePath: "references/fresh.md",
      frontmatter: goodFrontmatter,
      body: "Fresh body.",
    });

    expect(result.status).toBe("written");
    expect(result.mode).toBe("append");
    expect(result.receipt?.mode).toBe("append");
    expect(result.receipt?.postconditionVerified).toBe(true);
    expect(await readFile(path.join(tmpVault, "references/fresh.md"), "utf-8")).toContain(
      "Fresh body.",
    );
  });

  it("rejects a staged render whose body is empty without touching disk", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-staged-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "references/blank-body.md",
      frontmatter: goodFrontmatter,
      // Passes the admission body check (defined) but renders to an empty body.
      body: "   \n\t\n",
    });

    expect(result.status).toBe("rejected");
    expect(result.rejection?.stage).toBe("acceptance");
    expect(result.rejection?.code).toBe("body-missing");
    expect(result.receipt).toBeUndefined();
    expect(await readdir(tmpVault)).toEqual([]);
  });

  it("evaluates the staged render directly against the concept contract", () => {
    // A staged render that diverges from its input frontmatter: the declared
    // number field arrived as a string in the rendered note.
    const staged = `---\ntitle: Staged\nsource-url: https://example.com/staged\nrating: "4"\n---\n\nBody.\n`;
    const evaluation = evaluateStagedNote(staged, RATED, "references/staged.md", new Set());
    expect(evaluation.ok).toBe(false);
    expect(evaluation.violations.map((violation) => violation.field)).toContain("rating");
    expect(evaluation.violations.map((violation) => violation.rule)).toContain("type");
    expect(evaluation.body.trim()).toBe("Body.");

    const clean = `---\ntitle: Staged\nsource-url: https://example.com/staged\nrating: 4\n---\n\nBody.\n`;
    const ok = evaluateStagedNote(clean, RATED, "references/staged.md", new Set());
    expect(ok.ok).toBe(true);
    expect(ok.violations).toEqual([]);
    expect(ok.frontmatter["rating"]).toBe(4);
  });

  it("flags a staged render missing a routing-law field the input carried", () => {
    // Divergence shape the staged gate exists for: the rendered note lost a
    // field the caller supplied, so the strict-zone routing law now fails.
    const staged = `---\ntitle: Staged\nsource-url: https://example.com/staged\nrating: 4\n---\n\nBody.\n`;
    const evaluation = evaluateStagedNote(
      staged,
      RATED,
      "references/staged.md",
      new Set(["references"]),
    );
    expect(evaluation.ok).toBe(false);
    expect(evaluation.violations.map((violation) => violation.rule)).toContain("routing-law");
  });

  it("keeps multiline and date-like frontmatter values intact through the staged render", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-roundtrip-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath: "references/roundtrip.md",
      frontmatter: {
        title: "2024-01-02",
        "source-url": "https://example.com/roundtrip",
        note: "line one\nline two",
      },
      body: "Body.",
    });

    expect(result.status).toBe("written");
    expect(result.receipt?.postconditionVerified).toBe(true);
    const persisted = await readFile(path.join(tmpVault, "references/roundtrip.md"), "utf-8");
    expect(persisted).toContain("line one");
    expect(persisted).toContain("line two");
  });

  it("rejects with postcondition-failed when the persisted note fails re-validation", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-postcondition-"));
    const notePath = "references/postcondition.md";
    const result = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology: testOntology(),
      mode: "create",
      dryRun: false,
      notePath,
      frontmatter: goodFrontmatter,
      body: "Body.",
      readBack: async () => "---\ntitle: \"\"\n---\n\nCorrupted.\n",
    });

    expect(result.status).toBe("rejected");
    expect(result.rejection?.stage).toBe("acceptance");
    expect(result.rejection?.code).toBe("postcondition-failed");
    expect(result.rejection?.recoverable).toBe(false);
    expect(result.rejection?.remediation).toContain(path.join(tmpVault, notePath));
    expect(result.receipt).toBeUndefined();

    // The persisted file is NOT auto-deleted: it stays on disk for inspection.
    const persisted = await readFile(path.join(tmpVault, notePath), "utf-8");
    expect(persisted).toContain("Body.");
  });

  it("rejects with postcondition-failed when the persisted body is missing on append", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-postcondition-append-"));
    const ontology = testOntology();
    const notePath = "references/append-postcondition.md";
    await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "create",
      dryRun: false,
      notePath,
      frontmatter: goodFrontmatter,
      body: "Initial body.",
    });

    const result = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "append",
      dryRun: false,
      notePath,
      body: "Appended body.",
      readBack: async () =>
        `---\ntitle: Acceptance\nsource-url: https://example.com/acceptance\n---\n\nInitial body.\n`,
    });

    expect(result.status).toBe("rejected");
    expect(result.rejection?.code).toBe("postcondition-failed");
    expect(result.reason).toContain("persisted body does not match the staged content");
    expect(result.receipt).toBeUndefined();
    const persisted = await readFile(path.join(tmpVault, notePath), "utf-8");
    expect(persisted).toContain("Appended body.");
  });

  it("returns staged results with no receipt and no disk writes on dryRun create", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-dryrun-"));
    const result = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology: testOntology(),
      mode: "create",
      dryRun: true,
      notePath: "references/dry.md",
      frontmatter: goodFrontmatter,
      body: "Body.",
    });

    expect(result.status).toBe("written");
    expect(result.notePath).toBe("references/dry.md");
    expect(result.receipt).toBeUndefined();
    expect(result.rejection).toBeUndefined();
    expect(await readdir(tmpVault)).toEqual([]);
  });

  it("returns no receipt on dryRun append and update", async () => {
    tmpVault = await mkdtemp(path.join(tmpdir(), "oms-accept-dryrun-modes-"));
    const ontology = testOntology();
    const notePath = "references/dry-modes.md";
    await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "create",
      dryRun: false,
      notePath,
      frontmatter: goodFrontmatter,
      body: "Initial body.",
    });
    const before = await readFile(path.join(tmpVault, notePath), "utf-8");

    const appended = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "append",
      dryRun: true,
      notePath,
      body: "Dry append.",
    });
    expect(appended.status).toBe("written");
    expect(appended.receipt).toBeUndefined();

    const updated = await writeNote({
      target: { vault: tmpVault, source: "vault" },
      ontology,
      mode: "update",
      dryRun: true,
      notePath,
      frontmatter: { status: "published" },
    });
    expect(updated.status).toBe("written");
    expect(updated.receipt).toBeUndefined();

    expect(await readFile(path.join(tmpVault, notePath), "utf-8")).toBe(before);
  });
});
