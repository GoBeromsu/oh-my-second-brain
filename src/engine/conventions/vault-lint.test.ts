import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { Concept, Ontology } from "../../core/ontology/types.js";
import { lintNoteFrontmatter, lintVault, routingLawStrictFolders } from "./vault-lint.js";

// ── Inline fixtures — never touch the real vault ──────────────────────────────

/** A literature concept that includes an `enum` constraint on the `status` field. */
const LITERATURE_CONCEPT: Concept = {
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
    { name: "tags", type: "list", required: false, intent: "Topical tags." },
    { name: "created_by", type: "string", required: false, intent: "Authoring agent." },
  ],
};

/** Folders where the routing-law check fires. */
const AGENT_ZONES = new Set(["references"]);

/** A note path inside an agent-writable zone. */
const AGENT_NOTE = "references/clean-code.md";
/** A note path outside any agent zone. */
const PERSONAL_NOTE = "personal/journal.md";

// ── Known-GOOD fixtures ───────────────────────────────────────────────────────

describe("lintNoteFrontmatter — GOOD (zero violations)", () => {
  it("passes a fully valid literature note in agent zone with created_by", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "https://www.example.com/clean-code",
      status: "published",
      tags: ["engineering", "best-practices"],
      created_by: "agent:oms-capture",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    expect(violations).toHaveLength(0);
  });

  it("passes a note outside any agent zone — no routing-law check applies", () => {
    const fm: Record<string, unknown> = {
      title: "My Journal Entry",
      "source-url": "https://example.com",
    };
    const violations = lintNoteFrontmatter(
      fm,
      PERSONAL_NOTE,
      LITERATURE_CONCEPT,
      new Set(), // no agent zones
    );
    expect(violations.filter((v) => v.rule === "routing-law")).toHaveLength(0);
  });

  it("passes when optional fields are absent", () => {
    const fm: Record<string, unknown> = {
      title: "Minimal Note",
      "source-url": "https://example.com",
      created_by: "agent:oms",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    expect(violations).toHaveLength(0);
  });
});

// ── Known-BAD fixtures ────────────────────────────────────────────────────────

describe("lintNoteFrontmatter — BAD: (1) allowlist — rogue key", () => {
  it("reports a violation for an undeclared frontmatter key", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "https://example.com",
      created_by: "agent:oms",
      "rogue-key": "this key is not in the concept schema",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "allowlist");
    expect(v).toBeDefined();
    expect(v?.field).toBe("rogue-key");
    expect(v?.message).toContain("rogue-key");
  });

  it("reports one violation per rogue key when multiple are present", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "https://example.com",
      created_by: "agent:oms",
      "rogue-a": 1,
      "rogue-b": 2,
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const allowlistViolations = violations.filter((x) => x.rule === "allowlist");
    expect(allowlistViolations).toHaveLength(2);
  });
});

describe("lintNoteFrontmatter — BAD: (2) required — missing required field", () => {
  it("reports a required violation when title is absent", () => {
    const fm: Record<string, unknown> = {
      "source-url": "https://example.com",
      created_by: "agent:oms",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "required" && x.field === "title");
    expect(v).toBeDefined();
  });

  it("reports a required violation when source-url is an empty string", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "",
      created_by: "agent:oms",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "required" && x.field === "source-url");
    expect(v).toBeDefined();
  });
});

describe("lintNoteFrontmatter — BAD: (3) type — wrong value type", () => {
  it("reports a type violation when title is a number instead of string", () => {
    const fm: Record<string, unknown> = {
      title: 42,
      "source-url": "https://example.com",
      created_by: "agent:oms",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "type" && x.field === "title");
    expect(v).toBeDefined();
  });

  it("reports a type violation when source-url is not a valid URL", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "not-a-valid-url",
      created_by: "agent:oms",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "type" && x.field === "source-url");
    expect(v).toBeDefined();
  });

  it("reports a type violation when tags is a string instead of list", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "https://example.com",
      tags: "not-a-list",
      created_by: "agent:oms",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "type" && x.field === "tags");
    expect(v).toBeDefined();
  });
});

describe("lintNoteFrontmatter — BAD: (4) enum — invalid enum value", () => {
  it("reports an enum violation when status is not in the declared list", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "https://example.com",
      status: "rogue-status",
      created_by: "agent:oms",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "enum" && x.field === "status");
    expect(v).toBeDefined();
    expect(v?.message).toContain("rogue-status");
    expect(v?.message).toContain('"draft"');
  });

  it("does NOT fire enum violation when the value is absent (required check handles missing)", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "https://example.com",
      created_by: "agent:oms",
      // status absent
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const enumV = violations.filter((x) => x.rule === "enum");
    expect(enumV).toHaveLength(0);
  });
});

describe("lintNoteFrontmatter — BAD: (5) routing-law — missing created_by in agent zone", () => {
  it("reports a routing-law violation when created_by is absent in agent zone", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "https://example.com",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "routing-law");
    expect(v).toBeDefined();
    expect(v?.field).toBe("created_by");
    expect(v?.notePath).toBe(AGENT_NOTE);
    expect(v?.message).toContain("ROUTING LAW");
  });

  it("reports a routing-law violation when created_by is an empty string", () => {
    const fm: Record<string, unknown> = {
      title: "Clean Code",
      "source-url": "https://example.com",
      created_by: "  ",
    };
    const violations = lintNoteFrontmatter(fm, AGENT_NOTE, LITERATURE_CONCEPT, AGENT_ZONES);
    const v = violations.find((x) => x.rule === "routing-law");
    expect(v).toBeDefined();
  });

  it("does NOT fire routing-law outside an agent zone", () => {
    const fm: Record<string, unknown> = {
      title: "Journal Entry",
      "source-url": "https://example.com",
      // no created_by
    };
    const violations = lintNoteFrontmatter(
      fm,
      PERSONAL_NOTE,
      LITERATURE_CONCEPT,
      AGENT_ZONES, // references is agent zone, but PERSONAL_NOTE is in "personal/"
    );
    expect(violations.filter((v) => v.rule === "routing-law")).toHaveLength(0);
  });
});

describe("lintVault", () => {
  it("uses routingLawStrict folders, folder scoping, and exclude globs", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-vault-lint-"));
    try {
      await mkdir(path.join(vault, "references"), { recursive: true });
      await mkdir(path.join(vault, "notes"), { recursive: true });
      await writeFile(
        path.join(vault, "references", "missing-created-by.md"),
        [
          "---",
          "title: Strict Zone",
          "source-url: https://example.com/strict",
          "---",
          "",
          "Body.",
        ].join("\n"),
        "utf-8",
      );
      await writeFile(
        path.join(vault, "references", "skip.template.md"),
        [
          "---",
          "rogue: true",
          "---",
          "",
          "Template.",
        ].join("\n"),
        "utf-8",
      );
      await writeFile(
        path.join(vault, "notes", "user-note.md"),
        [
          "---",
          "title: User Zone",
          "source-url: https://example.com/user",
          "---",
          "",
          "Body.",
        ].join("\n"),
        "utf-8",
      );

      const ontology: Ontology = {
        taxonomy: {
          version: 1,
          folders: {
            references: {
              intent: "strict",
              concept: "literature",
              agentWritable: true,
              routingLawStrict: true,
            },
            notes: {
              intent: "writable but mixed",
              concept: "literature",
              agentWritable: true,
            },
          },
          exclude: ["**/*.template.md"],
        },
        concepts: new Map([["literature", LITERATURE_CONCEPT]]),
      };

      expect(routingLawStrictFolders(ontology)).toEqual(new Set(["references"]));

      const fullReport = await lintVault(vault, ontology);
      expect(fullReport.scannedNotes).toBe(2);
      expect(fullReport.excludedNotes).toBe(1);
      expect(fullReport.violations.map((violation) => violation.notePath)).toEqual([
        "references/missing-created-by.md",
      ]);
      expect(fullReport.violations[0]?.rule).toBe("routing-law");

      const scopedReport = await lintVault(vault, ontology, { folder: "notes" });
      expect(scopedReport.scannedNotes).toBe(1);
      expect(scopedReport.excludedNotes).toBe(0);
      expect(scopedReport.violations).toEqual([]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
  it("rejects invalid folder scopes before returning a clean report", async () => {
    const vault = await mkdtemp(path.join(tmpdir(), "oms-vault-lint-folder-"));
    try {
      await mkdir(path.join(vault, "references"), { recursive: true });

      const ontology: Ontology = {
        taxonomy: {
          version: 1,
          folders: {
            references: {
              intent: "strict",
              concept: "literature",
            },
            inbox: {
              intent: "declared but absent",
              concept: "literature",
            },
          },
        },
        concepts: new Map([["literature", LITERATURE_CONCEPT]]),
      };

      await expect(lintVault(vault, ontology, { folder: "references/missing" })).rejects.toThrow(
        /path separators/,
      );
      await expect(lintVault(vault, ontology, { folder: ".." })).rejects.toThrow(/path separators/);
      await expect(lintVault(vault, ontology, { folder: "unknown" })).rejects.toThrow(
        /not declared/,
      );
      await expect(lintVault(vault, ontology, { folder: "inbox" })).rejects.toThrow(
        /does not exist/,
      );
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
