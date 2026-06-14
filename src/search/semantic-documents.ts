import path from "node:path";
import { readSemanticIndex } from "./semantic-index.js";
import type {
  SemanticDocument,
  SemanticDocumentResult,
  SemanticGetOptions,
  SemanticIndexedDocument,
  SemanticMultiGetOptions,
} from "./semantic-types.js";

interface TargetRange {
  readonly target: string;
  readonly fromLine?: number;
  readonly lineCount?: number;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

function parseTargetRange(target: string): TargetRange {
  const parts = target.split(":");
  const lineCount = parsePositiveInteger(parts.at(-1));
  const fromLine = parsePositiveInteger(parts.at(-2));
  if (fromLine && lineCount && parts.length >= 3) {
    return { target: parts.slice(0, -2).join(":"), fromLine, lineCount };
  }
  return { target };
}

function lineSlice(
  content: string,
  opts: { readonly fromLine?: number; readonly lineCount?: number; readonly lineLimit?: number; readonly lineNumbers?: boolean },
): string {
  const lines = content.split(/\r?\n/u);
  const start = Math.max(0, (opts.fromLine ?? 1) - 1);
  const count = opts.lineCount ?? opts.lineLimit ?? lines.length;
  const selected = lines.slice(start, start + Math.max(0, count));
  return selected
    .map((line, index) => (opts.lineNumbers === true ? `${start + index + 1}: ${line}` : line))
    .join("\n");
}

function normalizePath(value: string): string {
  if (value.startsWith("qmd://")) return decodeURIComponent(value.slice("qmd://".length)).replace(/^\/+/u, "");
  if (value.startsWith("oms://")) {
    const withoutScheme = value.slice("oms://".length);
    const slash = withoutScheme.indexOf("/");
    return slash >= 0 ? decodeURIComponent(withoutScheme.slice(slash + 1)) : "";
  }
  return value.replace(/\\/g, "/").replace(/^\.?\//u, "");
}

function isUnsafeTarget(value: string): boolean {
  const normalized = normalizePath(value);
  return path.isAbsolute(value) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../");
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1] ?? "";
    if (char === "*" && next === "*") {
      source += ".*";
      index++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if ("|\\{}()[]^$+?.".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, "u");
}

function documentMatchesTarget(document: SemanticIndexedDocument, target: string): boolean {
  if (isUnsafeTarget(target)) return false;
  const normalized = normalizePath(target);
  if (normalized.startsWith("#")) return document.docid === normalized;
  if (normalized.includes("*")) return globRegex(normalized).test(document.path);
  return document.path === normalized || path.basename(document.path) === normalized;
}

function selectedDocuments(
  documents: readonly SemanticIndexedDocument[],
  target: string,
  collection: string | undefined,
): readonly SemanticIndexedDocument[] {
  const filtered = collection
    ? documents.filter((document) => document.collection === collection)
    : documents;
  return filtered.filter((document) => documentMatchesTarget(document, target));
}

function semanticDocument(
  source: SemanticIndexedDocument,
  target: string,
  opts: {
    readonly fromLine?: number;
    readonly lineCount?: number;
    readonly lineLimit?: number;
    readonly lineNumbers?: boolean;
    readonly fullPath?: boolean;
    readonly vault: string;
  },
): SemanticDocument {
  return {
    target,
    path: opts.fullPath === true ? path.join(opts.vault, source.path) : source.path,
    docid: source.docid,
    title: source.title,
    uri: source.uri,
    content: lineSlice(source.content, opts),
  };
}

export async function getSemanticDocument(opts: SemanticGetOptions): Promise<SemanticDocumentResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, documents: [] };
  const targetRange = parseTargetRange(opts.target);
  if (isUnsafeTarget(targetRange.target)) {
    return { available: false, reason: "OMS semantic document target must stay inside the vault.", documents: [] };
  }
  const matches = selectedDocuments(loaded.index.documents, targetRange.target, opts.collection);
  if (matches.length === 0) {
    return { available: false, reason: `No OMS semantic document matched "${targetRange.target}".`, documents: [] };
  }
  const [first] = matches;
  if (!first) {
    return { available: false, reason: `No OMS semantic document matched "${targetRange.target}".`, documents: [] };
  }
  return {
    available: true,
    documents: [
      semanticDocument(first, opts.target, {
        fromLine: opts.fromLine ?? targetRange.fromLine,
        lineCount: opts.lineCount ?? targetRange.lineCount,
        lineNumbers: opts.lineNumbers,
        fullPath: opts.fullPath,
        vault: loaded.index.vault,
      }),
    ],
  };
}

export async function multiGetSemanticDocuments(opts: SemanticMultiGetOptions): Promise<SemanticDocumentResult> {
  const loaded = await readSemanticIndex(opts);
  if (!loaded.available) return { available: false, reason: loaded.reason, documents: [] };
  const documents: SemanticDocument[] = [];
  const seen = new Set<string>();
  let usedBytes = 0;
  for (const rawTarget of opts.targets) {
    const targetRange = parseTargetRange(rawTarget);
    if (isUnsafeTarget(targetRange.target)) {
      return { available: false, reason: "OMS semantic document target must stay inside the vault.", documents: [] };
    }
    for (const match of selectedDocuments(loaded.index.documents, targetRange.target, opts.collection)) {
      if (seen.has(match.docid)) continue;
      const document = semanticDocument(match, rawTarget, {
        fromLine: targetRange.fromLine,
        lineCount: targetRange.lineCount,
        lineLimit: opts.lineLimit,
        lineNumbers: opts.lineNumbers,
        fullPath: opts.fullPath,
        vault: loaded.index.vault,
      });
      const nextBytes = Buffer.byteLength(document.content, "utf-8");
      if (opts.maxBytes && usedBytes + nextBytes > opts.maxBytes) return { available: true, documents };
      seen.add(match.docid);
      usedBytes += nextBytes;
      documents.push(document);
    }
  }
  return { available: true, documents };
}
