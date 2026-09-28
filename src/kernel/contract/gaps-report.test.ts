import { describe, expect, it, vi } from "vitest";
import type { GapEvent, GapLedger } from "./gap-ledger.js";
import { gapsReport } from "./gaps-report.js";
import { contractRevision } from "./revision.js";
import type { ContractView, VaultContract } from "./types.js";
import type { SealState } from "./vault-id.js";

const VAULT_ID = "3f2a9c1e-7b4d-4e8a-9c2b-1d5e6f7a8b9c";
const NOTE_REV = `sha256:${"a".repeat(64)}`;
const OLD_REV = `sha256:${"b".repeat(64)}`;
const DRAFT = "draft-12345678-1234-4234-8234-123456789abc.md";

const CONTRACT: VaultContract = {
  folders: { Inbox: { meaning: "", searchExclude: false } },
  properties: { status: { meaning: "", type: "text", default: false, required: false, rules: [{ kind: "allowed", values: [] }] } },
  templates: {},
};
const SEALED: ContractView = { state: "sealed", contract: CONTRACT };
const CURRENT = contractRevision(SEALED)!;

function seal(view: ContractView, vaultId: string | null = VAULT_ID): () => Promise<SealState> {
  return async () => ({ row: "sealed" as SealState["row"], view, vaultId, shared: false, settingsInvalid: false });
}

function event(id: string, extra: Partial<Extract<GapEvent, { type: "gap" }>> = {}): GapEvent {
  return {
    type: "gap", id, at: 1, notePath: "Inbox/a.md", noteRevision: NOTE_REV, contractRevision: CURRENT,
    axis: "property", kind: "no-fit", chosen: null, wanted: { field: "mood", value: "SECRET" }, reason: "dropped: unknown-property",
    ...extra,
  };
}

describe("gapsReport", () => {
  it("reports open gaps with stale and drafted flags, counts, corrupt lines and contradictions, never the wanted value", async () => {
    const ledger: GapLedger = {
      events: [
        event("g1"),
        event("g2", { axis: "folder", wanted: { field: "Elsewhere" }, contractRevision: OLD_REV, draftRef: DRAFT }),
        event("g3", { kind: "choice", axis: "template", wanted: { field: "template" } }),
        { type: "resolved", id: "g3", at: 2, reason: "chosen" },
      ],
      corrupt: [4],
    };
    const readGapLedger = vi.fn(async () => ledger);
    const report = await gapsReport("/vault", { root: "/store", resolveSealState: seal(SEALED), readGapLedger });
    expect(readGapLedger).toHaveBeenCalledWith("/store", VAULT_ID);
    expect(report).toEqual({
      contract: "sealed",
      contractRevision: CURRENT,
      ledger: "ok",
      open: 2,
      byAxis: { folder: 1, property: 1, value: 0, template: 0 },
      byKind: { "no-fit": 2, choice: 0 },
      gaps: [
        { id: "g1", notePath: "Inbox/a.md", axis: "property", kind: "no-fit", field: "mood", drafted: false, stale: false },
        { id: "g2", notePath: "Inbox/a.md", axis: "folder", kind: "no-fit", field: "Elsewhere", drafted: true, stale: true },
      ],
      corruptLines: [4],
      contradictions: [{ field: "status", kind: "allowed-empty" }],
    });
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("reads no ledger without a vault id and reports an open contract with no revision", async () => {
    const readGapLedger = vi.fn(async (): Promise<GapLedger> => ({ events: [], corrupt: [] }));
    const report = await gapsReport("/vault", { root: "/store", resolveSealState: seal({ state: "open" }, null), readGapLedger });
    expect(readGapLedger).not.toHaveBeenCalled();
    expect(report).toMatchObject({ contract: "open", contractRevision: null, ledger: "ok", open: 0, gaps: [], corruptLines: [], contradictions: [] });
  });

  it("marks every gap stale and reports no contradictions under an unreadable contract", async () => {
    const report = await gapsReport("/vault", {
      root: "/store",
      resolveSealState: seal({ state: "unreadable" }),
      readGapLedger: async () => ({ events: [event("g1")], corrupt: [] }),
    });
    expect(report).toMatchObject({ contract: "unreadable", contractRevision: null, open: 1, gaps: [{ id: "g1", stale: true }], contradictions: [] });
  });

  it("reports an unreadable ledger instead of throwing", async () => {
    const report = await gapsReport("/vault", {
      root: "/store",
      resolveSealState: seal(SEALED),
      readGapLedger: async () => { throw new Error("GAP_LEDGER_TOO_LARGE"); },
    });
    expect(report).toMatchObject({ contract: "sealed", ledger: "unreadable", open: 0, gaps: [], corruptLines: [] });
  });
});
