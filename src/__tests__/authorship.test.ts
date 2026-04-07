import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  addAuthorship,
  hasAuthorship,
  removeAuthorship,
  DEFAULT_AUTHORSHIP,
} from "../authorship/marker.js";
import type { AuthorshipConfig } from "../authorship/marker.js";

const CFG: AuthorshipConfig = DEFAULT_AUTHORSHIP;

describe("addAuthorship", () => {
  it("adds frontmatter with created_by when no frontmatter exists", () => {
    const content = "# My Note\n\nSome content.";
    const result = addAuthorship(content, CFG);
    assert.ok(result.startsWith("---\n"));
    assert.ok(result.includes('created_by: "[[claude]]"'));
    assert.ok(result.includes("# My Note"));
  });

  it("inserts created_by into existing frontmatter that lacks it", () => {
    const content = "---\ntitle: Hello\n---\n# Body";
    const result = addAuthorship(content, CFG);
    assert.ok(result.includes('created_by: "[[claude]]"'));
    assert.ok(result.includes("title: Hello"));
    assert.ok(!result.includes("modified_by"));
  });

  it("adds modified_by when created_by already present", () => {
    const content = '---\ntitle: Hello\ncreated_by: "[[claude]]"\n---\n# Body';
    const result = addAuthorship(content, CFG);
    assert.ok(result.includes('modified_by: "[[claude]]"'));
    assert.ok(result.includes('created_by: "[[claude]]"'));
  });

  it("updates existing modified_by when both fields already present", () => {
    const content = '---\ncreated_by: "[[claude]]"\nmodified_by: "[[old-agent]]"\n---\n# Body';
    const result = addAuthorship(content, CFG);
    assert.ok(result.includes('modified_by: "[[claude]]"'));
    assert.ok(!result.includes('"[[old-agent]]"'));
  });

  it("respects custom field names from config", () => {
    const customCfg: AuthorshipConfig = {
      agent_name: "gpt",
      created_by_field: "author",
      modified_by_field: "last_editor",
    };
    const content = "No frontmatter here.";
    const result = addAuthorship(content, customCfg);
    assert.ok(result.includes('author: "[[gpt]]"'));
  });

  it("does not duplicate created_by when called twice", () => {
    const content = "# Note";
    const once = addAuthorship(content, CFG);
    const twice = addAuthorship(once, CFG);
    const matches = (twice.match(/created_by/g) ?? []).length;
    assert.equal(matches, 1);
  });
});

describe("hasAuthorship", () => {
  it("returns false for both fields when no frontmatter", () => {
    const result = hasAuthorship("# Just a heading\n\nContent.", CFG);
    assert.equal(result.hasCreatedBy, false);
    assert.equal(result.hasModifiedBy, false);
  });

  it("detects created_by when present", () => {
    const content = '---\ncreated_by: "[[claude]]"\n---\n# Body';
    const result = hasAuthorship(content, CFG);
    assert.equal(result.hasCreatedBy, true);
    assert.equal(result.hasModifiedBy, false);
  });

  it("detects both fields when both present", () => {
    const content = '---\ncreated_by: "[[claude]]"\nmodified_by: "[[claude]]"\n---\n# Body';
    const result = hasAuthorship(content, CFG);
    assert.equal(result.hasCreatedBy, true);
    assert.equal(result.hasModifiedBy, true);
  });

  it("returns false for both when frontmatter has neither field", () => {
    const content = "---\ntitle: Hello\ntags: [test]\n---\n# Body";
    const result = hasAuthorship(content, CFG);
    assert.equal(result.hasCreatedBy, false);
    assert.equal(result.hasModifiedBy, false);
  });
});

describe("removeAuthorship", () => {
  it("removes created_by and modified_by from frontmatter", () => {
    const content = '---\ntitle: Hello\ncreated_by: "[[claude]]"\nmodified_by: "[[claude]]"\n---\n# Body';
    const result = removeAuthorship(content, CFG);
    assert.ok(!result.includes("created_by"));
    assert.ok(!result.includes("modified_by"));
    assert.ok(result.includes("title: Hello"));
  });

  it("returns content unchanged when no frontmatter", () => {
    const content = "# No frontmatter\n\nJust content.";
    const result = removeAuthorship(content, CFG);
    assert.equal(result, content);
  });

  it("removes only created_by if only created_by exists", () => {
    const content = '---\ncreated_by: "[[claude]]"\ntitle: Note\n---\n# Body';
    const result = removeAuthorship(content, CFG);
    assert.ok(!result.includes("created_by"));
    assert.ok(result.includes("title: Note"));
  });

  it("is idempotent: removing twice yields same result", () => {
    const content = '---\ncreated_by: "[[claude]]"\ntitle: Note\n---\n# Body';
    const once = removeAuthorship(content, CFG);
    const twice = removeAuthorship(once, CFG);
    assert.equal(once, twice);
  });

  it("round-trip: add then remove returns original structure", () => {
    const original = "---\ntitle: Hello\n---\n# Body";
    const added = addAuthorship(original, CFG);
    const removed = removeAuthorship(added, CFG);
    // The original frontmatter fields should still be there
    assert.ok(removed.includes("title: Hello"));
    assert.ok(!removed.includes("created_by"));
  });
});
