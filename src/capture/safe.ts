import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { validateFrontmatter } from "../conventions/validate.js";
import { resolveConcept } from "../core/ontology/resolver.js";
import type { Concept, Ontology } from "../core/ontology/types.js";

export type CapturePrepareAction = "ready" | "ask-missing-fields" | "route-to-inbox";
export type CaptureWriteMode = "create" | "append";

export interface CapturePrepareInput {
  vault: string;
  ontology: Ontology;
  concept?: string;
  folder?: string;
  filename?: string;
  frontmatter?: Record<string, unknown>;
}

export interface CapturePlan {
  action: CapturePrepareAction;
  concept: string | null;
  folder: string;
  notePath: string;
  missingFields: string[];
  frontmatter: Record<string, unknown>;
  reason?: string;
}

export interface CaptureCommitInput {
  vault: string;
  ontology: Ontology;
  notePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  mode: CaptureWriteMode;
}

export interface CaptureCommitResult {
  written: true;
  mode: CaptureWriteMode;
  notePath: string;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

function conceptsForFolder(ontology: Ontology, folder: string): string[] {
  const binding = ontology.taxonomy.folders[folder]?.concept;
  if (!binding) return [];
  return Array.isArray(binding) ? binding : [binding];
}

function findConcept(ontology: Ontology, conceptName: string | undefined): Concept | undefined {
  return conceptName ? ontology.concepts.get(conceptName) : undefined;
}

function defaultInboxFolder(ontology: Ontology): string {
  if (ontology.taxonomy.folders["inbox"]) return "inbox";
  const inboxConcept = ontology.concepts.get("inbox");
  return inboxConcept?.folder ?? "inbox";
}

function requiredMissing(concept: Concept | undefined, frontmatter: Record<string, unknown>): string[] {
  if (!concept) return [];
  return validateFrontmatter(frontmatter, concept).violations
    .filter((violation) => violation.rule === "required")
    .map((violation) => violation.field);
}

export function safeVaultNotePath(vault: string, notePath: string): string {
  if (path.isAbsolute(notePath)) {
    throw new Error("notePath must be vault-relative");
  }
  const normalized = notePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw new Error("notePath must end with .md");
  }
  const segments = normalized.split("/");
  if (segments.some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("notePath must not contain unsafe path segments");
  }
  if (segments.some((part) => part.startsWith(".")) || segments.includes("node_modules")) {
    throw new Error("notePath cannot target hidden, internal, or dependency folders");
  }
  const resolved = path.resolve(vault, normalized);
  const relative = path.relative(vault, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("notePath must stay inside the configured vault");
  }
  return resolved;
}

function safeCaptureFilename(requested: string | undefined, title: string): {
  filename: string;
  safe: boolean;
} {
  if (!requested) {
    return {
      filename: `${new Date().toISOString().slice(0, 10)}-${slugify(title)}.md`,
      safe: true,
    };
  }

  const normalized = requested.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const safe =
    segments.length === 1 &&
    normalized.endsWith(".md") &&
    !segments.some((part) => part === ".." || part === "." || part === "" || part.startsWith("."));

  return {
    filename: safe ? normalized : `${new Date().toISOString().slice(0, 10)}-${slugify(title)}.md`,
    safe,
  };
}

export function prepareCapture(input: CapturePrepareInput): CapturePlan {
  const frontmatter = input.frontmatter ?? {};
  const requestedConcept = findConcept(input.ontology, input.concept);
  const folder = input.folder ?? requestedConcept?.folder ?? defaultInboxFolder(input.ontology);
  const folderConcepts = conceptsForFolder(input.ontology, folder);
  const resolvedConcept = requestedConcept ?? findConcept(input.ontology, folderConcepts[0]);
  const titleValue = frontmatter["title"];
  const title = typeof titleValue === "string" ? titleValue : "untitled";
  const filenamePlan = safeCaptureFilename(input.filename, title);
  const filename = filenamePlan.filename;
  const notePath = `${folder}/${filename}`;

  if (!filenamePlan.safe) {
    const inbox = defaultInboxFolder(input.ontology);
    return {
      action: "route-to-inbox",
      concept: "inbox",
      folder: inbox,
      notePath: `${inbox}/${filename}`,
      missingFields: [],
      frontmatter,
      reason: "Requested filename was unsafe; planned a safe inbox capture path.",
    };
  }

  if (!resolvedConcept || !folderConcepts.includes(resolvedConcept.concept)) {
    const inbox = defaultInboxFolder(input.ontology);
    return {
      action: "route-to-inbox",
      concept: "inbox",
      folder: inbox,
      notePath: `${inbox}/${filename}`,
      missingFields: [],
      frontmatter,
      reason: "No safe folder/concept binding matched the requested capture.",
    };
  }

  const missingFields = requiredMissing(resolvedConcept, frontmatter);
  return {
    action: missingFields.length > 0 ? "ask-missing-fields" : "ready",
    concept: resolvedConcept.concept,
    folder,
    notePath,
    missingFields,
    frontmatter,
  };
}

function formatNote(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${yamlStringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function commitCapture(input: CaptureCommitInput): Promise<CaptureCommitResult> {
  const fullPath = safeVaultNotePath(input.vault, input.notePath);
  const normalizedNotePath = path.relative(input.vault, fullPath).replace(/\\/g, "/");
  const concept = resolveConcept(input.ontology, normalizedNotePath);
  if (!concept) {
    throw new Error("Cannot commit capture: notePath does not resolve to a concept binding");
  }
  const validation = validateFrontmatter(input.frontmatter, concept);
  if (!validation.valid) {
    const fields = validation.violations.map((violation) => violation.field).join(", ");
    throw new Error(`Cannot commit capture: frontmatter violates the concept contract (${fields})`);
  }

  await mkdir(path.dirname(fullPath), { recursive: true });
  if (input.mode === "append") {
    try {
      await readFile(fullPath, "utf-8");
      await appendFile(fullPath, `\n\n${input.body.trim()}\n`, "utf-8");
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
      await writeFile(fullPath, formatNote(input.frontmatter, input.body), "utf-8");
    }
  } else {
    try {
      await writeFile(fullPath, formatNote(input.frontmatter, input.body), {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw new Error("Cannot create capture: target note already exists");
      }
      throw error;
    }
  }

  return { written: true, mode: input.mode, notePath: normalizedNotePath };
}
