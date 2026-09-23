import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseModelsConfig, type ModelsConfigV1 } from "../engine/embed/config.js";
import { proposeTemplateFolders, type TemplateFolderCandidate, type TemplateHintDiagnostic } from "../templates/hints.js";
import { approvalDigest, digestBytes, outputDigest } from "../templates/canonical.js";
import { parseTemplatePolicy, serializeDerivedProjection, serializeTemplatePolicy } from "../templates/policy.js";
import { controlGenerationDigest, expectedProjectionManaged, taxonomyRouting } from "../templates/resolver.js";
import { executeTemplateTransaction, TEMPLATE_TRANSACTION_MARKER_PATH } from "../templates/transaction.js";
import {
  DEFAULT_MANAGED_TEMPLATE_PATH,
  type FileExpectation,
  type GuardedTemplateRequest,
  type ManagedTemplatePath,
  type TemplateCompositionManifest,
  type TemplatePolicy,
  type TemplateTransactionReceipt,
  type VerifiedFileState,
} from "../templates/types.js";
import { describeTemplateSetup, type TemplateSetupDocument } from "./documents.js";

/**
 * Setup proposes an empty version 4 policy and publishes it only through the
 * approved transaction. It ships no note-type defaults, discovers no templates,
 * and never writes a note.
 */

const encoder = new TextEncoder();
const POLICY_PATH = ".oms/template-policy.json" as const;
const TAXONOMY_PATH = ".oms/taxonomy.json" as const;
const PROJECTION_PATH = ".oms/types.json" as const;

export interface SetupState {
  readonly vault: string;
  readonly policy: TemplatePolicy;
  readonly document: TemplateSetupDocument;
  readonly templateFolderCandidates: readonly TemplateFolderCandidate[];
  readonly templateFolderHintDiagnostics: readonly TemplateHintDiagnostic[];
}

export interface SetupInputs {
  /** Reserved for the interview; setup itself selects nothing. */
  readonly templateFolders?: readonly { readonly path: string }[];
}

export type SetupDecision = SetupState;

/** The empty always-on default layer every vault starts from. */
export function emptyTemplatePolicy(): TemplatePolicy {
  return parseTemplatePolicy(JSON.stringify({
    version: 4,
    properties: {},
    default: {
      templatePath: DEFAULT_MANAGED_TEMPLATE_PATH,
      approvedMarkdown: "",
      approvedMarkdownDigest: digestBytes(""),
      fields: {},
      headings: [],
      semanticCriteria: [],
    },
    templates: {},
  }));
}

async function setupState(vault: string): Promise<SetupState> {
  const policy = emptyTemplatePolicy();
  // Folder hints stay raw observations: setup selects nothing on the user's behalf.
  const hints = await proposeTemplateFolders(vault, { selected: [] });
  return {
    vault,
    policy,
    document: describeTemplateSetup(policy, hints),
    templateFolderCandidates: hints.candidates,
    templateFolderHintDiagnostics: hints.diagnostics,
  };
}

/** Discovery is side-effect free and reads only vault-resident state. */
export async function inspectSetup({ vault }: { readonly vault: string }): Promise<SetupState> {
  return setupState(vault);
}

export async function decideSetup(state: SetupState, _inputs: SetupInputs = {}): Promise<SetupDecision> {
  return setupState(state.vault);
}

export async function decideNonInteractiveSetup(state: SetupState): Promise<SetupDecision> {
  return state;
}

async function currentState(vault: string, relative: string): Promise<VerifiedFileState> {
  try {
    const bytes = new Uint8Array(await readFile(path.join(vault, relative)));
    return { state: "present", bytes, signature: digestBytes(bytes) };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" };
    throw error;
  }
}

function expectation(state: VerifiedFileState): FileExpectation {
  return state.state === "present" ? { state: "present", signature: state.signature } : { state: "absent" };
}

function present(text: string): Extract<VerifiedFileState, { readonly state: "present" }> {
  const bytes = encoder.encode(text);
  return { state: "present", bytes, signature: digestBytes(bytes) };
}

/**
 * Composes the approval manifest for the empty policy, its taxonomy, the
 * derived projection, and the empty managed default draft. Existing controls
 * are preserved as verify-only so setup never silently replaces a vault that
 * already has an approved contract.
 */
export async function composeSetup(decision: SetupDecision): Promise<TemplateCompositionManifest> {
  const vault = decision.vault;
  const [policyCurrent, taxonomyCurrent, projectionCurrent, draftCurrent] = await Promise.all([
    currentState(vault, POLICY_PATH),
    currentState(vault, TAXONOMY_PATH),
    currentState(vault, PROJECTION_PATH),
    currentState(vault, DEFAULT_MANAGED_TEMPLATE_PATH),
  ]);

  // A present control is preserved, so the derived projection must be generated
  // from the bytes that will actually be on disk. Generating it from the
  // proposal would leave the vault reporting a contract it does not have.
  const decoder = new TextDecoder();
  const policyText = policyCurrent.state === "present"
    ? decoder.decode(policyCurrent.bytes)
    : serializeTemplatePolicy(decision.policy);
  const taxonomyText = taxonomyCurrent.state === "present"
    ? decoder.decode(taxonomyCurrent.bytes)
    : `${JSON.stringify({ templates: {}, folders: {} }, null, 2)}\n`;
  const effectivePolicy = policyCurrent.state === "present"
    ? parseTemplatePolicy(policyText)
    : decision.policy;
  const generationDigest = controlGenerationDigest(encoder.encode(policyText), encoder.encode(taxonomyText));
  const projectionText = serializeDerivedProjection({
    version: "oms.types.v2",
    generatedFrom: generationDigest,
    managed: expectedProjectionManaged(
      effectivePolicy,
      taxonomyRouting(TAXONOMY_PATH, encoder.encode(taxonomyText)),
      generationDigest,
    ),
  });

  const controls = [
    { kind: "policy" as const, path: POLICY_PATH, expectedCurrent: expectation(policyCurrent), current: policyCurrent, proposed: present(policyText), action: policyCurrent.state === "absent" ? "write" as const : "verify-only" as const },
    { kind: "taxonomy" as const, path: TAXONOMY_PATH, expectedCurrent: expectation(taxonomyCurrent), current: taxonomyCurrent, proposed: present(taxonomyText), action: taxonomyCurrent.state === "absent" ? "write" as const : "verify-only" as const },
    // The projection is derived, so a stale one is rewritten rather than kept.
    { kind: "projection" as const, path: PROJECTION_PATH, expectedCurrent: expectation(projectionCurrent), current: projectionCurrent, proposed: present(projectionText), action: projectionCurrent.state === "present" && decoder.decode(projectionCurrent.bytes) === projectionText ? "verify-only" as const : "write" as const },
  ] as TemplateCompositionManifest["controls"];

  // A verify-only control must propose exactly the bytes already on disk.
  const settle = <T extends TemplateCompositionManifest["controls"][number]>(control: T): T =>
    control.action === "verify-only" && control.current.state === "present"
      ? { ...control, proposed: control.current }
      : control;
  const reconciled: TemplateCompositionManifest["controls"] = [
    settle(controls[0]),
    settle(controls[1]),
    settle(controls[2]),
  ];

  const draft = {
    templateId: null,
    path: DEFAULT_MANAGED_TEMPLATE_PATH as ManagedTemplatePath,
    expectedCurrent: expectation(draftCurrent),
    current: draftCurrent,
    proposed: draftCurrent.state === "present" ? draftCurrent : present(""),
    action: draftCurrent.state === "absent" ? "write" as const : "verify-only" as const,
  };

  const outputs = [...reconciled, draft].flatMap(transition => transition.action === "write" && transition.proposed.state === "present"
    ? [{ finalVaultRelativePath: transition.path, payloadDigest: transition.proposed.signature }]
    : []);
  const body = {
    version: 1 as const,
    markerPath: TEMPLATE_TRANSACTION_MARKER_PATH,
    controls: reconciled,
    drafts: [draft],
    operations: [{ kind: "commit-contract" as const, templateId: null, payloadDigest: digestBytes(policyText) }],
    diagnostics: [],
    outputs,
  };
  return { ...body, approvalDigest: approvalDigest(body), outputDigest: outputDigest(outputs) };
}

export async function applySetup(
  decision: SetupDecision,
  manifest: TemplateCompositionManifest,
  request: GuardedTemplateRequest,
): Promise<TemplateTransactionReceipt> {
  return executeTemplateTransaction(decision.vault, manifest, request);
}

/** Publish portable selections only after their template transaction was approved and applied. */
export async function publishSetupModels(
  decision: SetupDecision,
  receipt: TemplateTransactionReceipt,
  request: GuardedTemplateRequest,
  modelsConfig: ModelsConfigV1,
): Promise<boolean> {
  if (request.dryRun === true || (receipt.status !== "applied" && receipt.status !== "already-complete")) {
    throw new Error("SETUP_APPROVAL_MISMATCH");
  }
  const content = `${JSON.stringify(parseModelsConfig(modelsConfig), null, 2)}\n`;
  const modelsPath = path.join(decision.vault, ".oms", "models.json");
  try {
    if (await readFile(modelsPath, "utf8") === content) return false;
  } catch (error: unknown) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(modelsPath), { recursive: true });
  await writeFile(modelsPath, content, "utf8");
  return true;
}
