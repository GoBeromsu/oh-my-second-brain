import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
}

describe("docs governance surfaces", () => {
  it("documents the docs/process SSOT split and OMC reference policy in README", () => {
    const readme = readRepoFile("README.md");

    assert.match(readme, /Planning\/process SSOT vs runtime enforcement SSOT/);
    assert.match(readme, /docs\/`.*product, planning, and development-process SSOT/s);
    assert.match(readme, /guideline folder -> omsb\.config\.json -> \.omsb\/rules\.json/);
    assert.match(readme, /## Reference/);
    assert.match(readme, /yeachan-heo\/oh-my-claudecode/);
  });

  it("captures the issue -> branch -> PR workflow in CONTRIBUTING", () => {
    const contributing = readRepoFile("CONTRIBUTING.md");

    assert.match(contributing, /## Default delivery flow/);
    assert.match(contributing, /Create or refine an issue\./);
    assert.match(contributing, /Create a focused branch\./);
    assert.match(contributing, /Open a PR with verification evidence\./);
    assert.match(contributing, /Docs\/process SSOT/);
    assert.match(contributing, /Runtime enforcement SSOT/);
  });

  it("ships issue and pull request templates that enforce SSOT and verification checks", () => {
    const issueTemplate = readRepoFile(".github/ISSUE_TEMPLATE/implementation-slice.md");
    const prTemplate = readRepoFile(".github/pull_request_template.md");

    assert.match(issueTemplate, /## SSOT impact/);
    assert.match(issueTemplate, /## Verification plan/);
    assert.match(prTemplate, /## SSOT check/);
    assert.match(prTemplate, /## Verification evidence/);
    assert.match(prTemplate, /Reference policy check/);
  });

  it("ships an explicit MIT license file", () => {
    const license = readRepoFile("LICENSE");

    assert.match(license, /^MIT License/m);
    assert.match(license, /Permission is hereby granted, free of charge/m);
  });
});
