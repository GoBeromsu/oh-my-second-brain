import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveContentFormatContract,
  evaluateTemplateBodyContract,
  parseContentFormatContract,
  type ContentFormatContract,
} from "./content-contract.js";

const structural = (contract: ContentFormatContract) => contract.nodes.filter(node => node.kind !== "placeholder");
const digestFor = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function headingNodes(contract: ContentFormatContract) {
  return contract.nodes.filter(node => node.kind === "heading");
}

function fenceNodes(contract: ContentFormatContract) {
  return contract.nodes.filter(node => node.kind === "fenced-code");
}

describe("content-format contract", () => {
  it("ignores headings and lists inside fenced code", () => {
    const body = [
      "```markdown",
      "# sample",
      "- not a list",
      "```",
      "# Real heading",
      "- one",
      "- two",
    ].join("\n");
    const { contract } = deriveContentFormatContract(body);
    expect(headingNodes(contract).map(node => node.text)).toEqual(["Real heading"]);
    expect(structural(contract).filter(node => node.kind === "list")).toHaveLength(1);
    const list = structural(contract).find(node => node.kind === "list");
    expect(list?.kind === "list" ? list.itemCount : 0).toBe(2);
    expect(fenceNodes(contract)).toMatchObject([{ info: "markdown", closed: true }]);
  });

  it("requires a same-character closing run at least as long as the opening run", () => {
    const body = [
      "`````js",
      "# still inside",
      "```",
      "# still inside too",
      "`````   ",
      "# after fence",
    ].join("\n");
    const { contract } = deriveContentFormatContract(body);
    expect(fenceNodes(contract)).toMatchObject([{ fenceLength: 5, closed: true }]);
    expect(headingNodes(contract).map(node => node.text)).toEqual(["after fence"]);
  });

  it("does not close on non-whitespace trailing text and reports an unterminated fence", () => {
    const body = ["~~~", "inside", "~~~ trailing text", "# hidden"].join("\n");
    const { contract } = deriveContentFormatContract(body);
    expect(contract.wellFormed).toBe(false);
    expect(fenceNodes(contract)[0]?.closed).toBe(false);
    expect(headingNodes(contract)).toHaveLength(0);
    expect(contract.diagnostics[0]?.code).toBe("unterminated-fence");
  });

  it("keeps prose and setext headings unconstrained while recording list runs", () => {
    const body = ["A prose paragraph.", "Setext title", "====", "1. first", "2. second"].join("\n");
    const { contract } = deriveContentFormatContract(body);
    expect(headingNodes(contract)).toHaveLength(0);
    expect(structural(contract)).toMatchObject([{ kind: "list", ordered: true, itemCount: 2 }]);
    expect(contract.nodes).toHaveLength(1);
  });

  it("treats the source marker as an insertion location, not a rendered requirement", () => {
    const { contract } = deriveContentFormatContract("# {{title}}\n<!-- oms:content -->", {
      templateId: "daily",
      decisions: {
        nodes: [{
          anchorDigest: deriveContentFormatContract("# {{title}}\n<!-- oms:content -->").contract.nodes[0]!.anchorDigest,
          required: true,
        }],
      },
    });
    const result = evaluateTemplateBodyContract("# Monday\nbody", contract, { mode: "create" });
    expect(result.valid).toBe(true);
  });

  it("reports a missing confirmed required heading on update", () => {
    const observed = deriveContentFormatContract("# Title\n## Details");
    const details = observed.contract.nodes.find(node => node.kind === "heading" && node.text === "Details");
    if (details === undefined) throw new Error("test fixture did not produce Details heading");
    const { contract } = deriveContentFormatContract("# Title\n## Details", {
      decisions: { nodes: [{ anchorDigest: details.anchorDigest, required: true }] },
    });
    const result = evaluateTemplateBodyContract("# Title", contract, { mode: "update" });
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      code: "required-node-missing",
      nodeKind: "heading",
      subject: "heading:2:Details",
    });
  });

  it("enforces confirmed required-node ordering", () => {
    const observed = deriveContentFormatContract("# First\n# Second");
    const headings = observed.contract.nodes.filter(node => node.kind === "heading");
    if (headings.length !== 2) throw new Error("test fixture did not produce two headings");
    const { contract } = deriveContentFormatContract("# First\n# Second", {
      decisions: {
        order: "strict",
        nodes: headings.map(node => ({ anchorDigest: node.anchorDigest, required: true })),
      },
    });
    const result = evaluateTemplateBodyContract("# Second\n# First", contract, { mode: "update" });
    expect(result.valid).toBe(false);
    expect(result.violations.some(item => item.code === "order-mismatch")).toBe(true);
  });

  it("checks fence integrity in append mode without checking deleted nodes", () => {
    const observed = deriveContentFormatContract("# Required");
    const heading = observed.contract.nodes.find(node => node.kind === "heading");
    if (heading === undefined) throw new Error("test fixture did not produce Required heading");
    const { contract } = deriveContentFormatContract("# Required", {
      decisions: { nodes: [{ anchorDigest: heading.anchorDigest, required: true }] },
    });
    expect(evaluateTemplateBodyContract("caller body", contract, { mode: "append" }).valid).toBe(true);
    const invalid = evaluateTemplateBodyContract("```python\ncaller body", contract, { mode: "append" });
    expect(invalid.valid).toBe(false);
    expect(invalid.violations[0]?.code).toBe("unterminated-fence");
  });

  it("does not infer requiredness from observed presence", () => {
    const { contract, questions } = deriveContentFormatContract("# Heading\n- item");
    expect(structural(contract).every(node => node.required === false)).toBe(true);
    expect(questions.filter(item => item.kind === "content-section-requiredness")).toHaveLength(2);
    expect(questions.filter(item => item.kind === "content-order")).toHaveLength(0);
  });

  it("asks for order only after two independent required decisions", () => {
    const observed = deriveContentFormatContract("# First\n# Second", { templateId: "note" });
    const headings = observed.contract.nodes.filter(node => node.kind === "heading");
    expect(observed.questions.filter(item => item.kind === "content-order")).toHaveLength(0);
    const one = deriveContentFormatContract("# First\n# Second", {
      templateId: "note",
      decisions: { nodes: [{ anchorDigest: headings[0]!.anchorDigest, required: true }] },
    });
    expect(one.questions.filter(item => item.kind === "content-order")).toHaveLength(0);
    const two = deriveContentFormatContract("# First\n# Second", {
      templateId: "note",
      decisions: {
        nodes: headings.map(node => ({ anchorDigest: node.anchorDigest, required: true })),
      },
    });
    expect(two.questions.filter(item => item.kind === "content-order")).toHaveLength(1);
  });

  it("uses a sequence-sensitive anchor for strict-order decisions", () => {
    const first = deriveContentFormatContract("# First\n# Second", { templateId: "note" }).contract;
    const firstOrder = deriveContentFormatContract("# First\n# Second", {
      templateId: "note",
      decisions: {
        nodes: first.nodes
          .filter(node => node.kind !== "placeholder")
          .map(node => ({ anchorDigest: node.anchorDigest, required: true })),
      },
    }).questions.find(item => item.kind === "content-order");
    const swapped = deriveContentFormatContract("# Second\n# First", { templateId: "note" }).contract;
    const swappedOrder = deriveContentFormatContract("# Second\n# First", {
      templateId: "note",
      decisions: {
        nodes: swapped.nodes
          .filter(node => node.kind !== "placeholder")
          .map(node => ({ anchorDigest: node.anchorDigest, required: true })),
      },
    }).questions.find(item => item.kind === "content-order");
    expect(firstOrder?.anchorDigest).not.toBe(swappedOrder?.anchorDigest);
  });

  it("contextualizes repeated nodes while preserving unique anchors and spans", () => {
    const repeated = deriveContentFormatContract("# A\n# A\n# Unique", { templateId: "note" }).contract;
    const repeatedHeadings = headingNodes(repeated);
    expect(repeatedHeadings[0]?.anchorDigest).not.toBe(repeatedHeadings[1]?.anchorDigest);
    expect(repeatedHeadings[0]?.anchorMaterial).not.toBe("# A");
    const uniqueNode = repeatedHeadings.find(node => node.text === "Unique");
    expect(uniqueNode?.anchorMaterial).toBe("# Unique");
    expect(uniqueNode?.anchorDigest).toBe(digestFor("# Unique"));
    expect(repeatedHeadings[0]?.span.start).toBe(0);
    expect(repeatedHeadings[1]?.span.start).toBe(4);
    const proseChanged = deriveContentFormatContract("edited prose\n# A\n# A\n# Unique", { templateId: "note" }).contract;
    const stableRepeated = headingNodes(proseChanged);
    expect(stableRepeated.slice(0, 2).map(node => node.anchorDigest)).toEqual(repeatedHeadings.slice(0, 2).map(node => node.anchorDigest));
    expect(parseContentFormatContract(JSON.parse(JSON.stringify(repeated)))).toEqual(repeated);
  });

  it("invalidates an entire repeated group when its cardinality changes", () => {
    const old = deriveContentFormatContract("# A\n# A", { templateId: "note" }).contract;
    const oldNodes = headingNodes(old);
    const changed = deriveContentFormatContract("# A\n# A\n# A", {
      templateId: "note",
      decisions: oldNodes.map(node => ({ anchorDigest: node.anchorDigest, required: true })),
    });
    const changedNodes = headingNodes(changed.contract);
    expect(changedNodes.every(node => node.required === false)).toBe(true);
    expect(changed.questions.filter(item => item.kind === "content-section-requiredness")).toHaveLength(3);
    expect(new Set(changedNodes.map(node => node.anchorDigest)).size).toBe(3);
  });

  it("keeps repeated occurrences independently required", () => {
    const observed = deriveContentFormatContract("# A\n# A", { templateId: "note" }).contract;
    const headings = headingNodes(observed);
    const result = deriveContentFormatContract("# A\n# A", {
      templateId: "note",
      decisions: {
        nodes: [
          { anchorDigest: headings[0]!.anchorDigest, required: true },
          { anchorDigest: headings[1]!.anchorDigest, required: false },
        ],
      },
    });
    expect(headingNodes(result.contract).map(node => node.required)).toEqual([true, false]);
    expect(result.questions.filter(item => item.kind === "content-order")).toHaveLength(0);
  });

  it("keeps node question identities stable when unrelated prose changes", () => {
    const first = deriveContentFormatContract("before\n# Stable\nafter", { templateId: "note" });
    const second = deriveContentFormatContract("unrelated edit\n# Stable\nmore prose", { templateId: "note" });
    const firstQuestion = first.questions.find(item => item.subject === "heading:1:Stable");
    const secondQuestion = second.questions.find(item => item.subject === "heading:1:Stable");
    expect(firstQuestion?.questionId).toBe(secondQuestion?.questionId);
    expect(firstQuestion?.anchorDigest).toBe(secondQuestion?.anchorDigest);
  });

  it("describes BOM, EOL, and final-newline metadata without rewriting the body", () => {
    const { contract } = deriveContentFormatContract("\ufeff# Title\r\n", { bom: true });
    expect(contract).toMatchObject({ bom: true, eol: "crlf", finalNewline: true });
    expect(contract.bodySignature).toMatch(/^sha256:/);
  });

  it("rejects malformed serialized contracts strictly", () => {
    const contract = deriveContentFormatContract("# Title").contract;
    expect(() => parseContentFormatContract({ ...contract, extra: true })).toThrow(/CONTENT_CONTRACT_INVALID/);
    expect(() => parseContentFormatContract({ ...contract, nodes: [{ kind: "setext", text: "Title" }] })).toThrow(/CONTENT_CONTRACT_INVALID/);
    expect(() => parseContentFormatContract({ ...contract, bodySignature: "sha256:not-a-digest" })).toThrow(/CONTENT_CONTRACT_INVALID/);
    expect(() => parseContentFormatContract({ ...contract, diagnostics: [{ code: "unknown", message: "bad" }] })).toThrow(/CONTENT_CONTRACT_INVALID/);
  });

  it("round-trips the canonical contract through strict parsing", () => {
    const contract = deriveContentFormatContract("# Title\n<!-- oms:content -->").contract;
    expect(parseContentFormatContract(JSON.parse(JSON.stringify(contract)))).toEqual(contract);
  });
});
