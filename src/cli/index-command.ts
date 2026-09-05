import {
  booleanOption,
  numberOption,
  printJson,
  stringOption,
  type ParsedSearchArgs,
} from "./search-args.js";
import { runEngineSession } from "./engine-session.js";
import { searchUsage } from "./search-usage.js";
import { repairEngineStore } from "../kernel/engine/embed/repair.js";
import { engineStoreDiagnostic } from "../kernel/engine/embed/store.js";
import { engineStorePath } from "../kernel/engine/paths.js";
import { existsSync } from "node:fs";
import type { WriteTargetSource } from "../kernel/conventions/write-protocol.js";

export interface IndexCommandOptions {
  readonly args: ParsedSearchArgs;
  readonly vault: string;
  readonly source: WriteTargetSource;
  readonly write: (message: string) => void;
  readonly writeError: (message: string) => void;
}

const INDEX_LEAF_FLAGS: Readonly<Record<string, {
  readonly value: ReadonlySet<string>;
  readonly boolean: ReadonlySet<string>;
}>> = {
  sync: {
    value: new Set(["vault", "collection", "index", "chunk-strategy", "max-docs-per-batch", "max-batch-mb"]),
    boolean: new Set(),
  },
  embed: {
    value: new Set(["vault", "collection", "index", "chunk-strategy", "max-docs-per-batch", "max-batch-mb"]),
    boolean: new Set(),
  },
  status: {
    value: new Set(["vault", "view", "index", "collection"]),
    boolean: new Set(),
  },
  clean: {
    value: new Set(["vault", "index"]),
    boolean: new Set(),
  },
  repair: {
    value: new Set(["vault", "mode"]),
    boolean: new Set(["dry-run"]),
  },
};

/**
 * Validate the public index grammar before resolving a vault or assembling an
 * engine. parseSearchArgs intentionally serves several older internal callers
 * and is permissive; the public family must not silently discard their flags.
 */
export function validateIndexFamilyArgs(argv: readonly string[]): void {
  const leaf = argv[0];
  const contract = leaf === undefined ? undefined : INDEX_LEAF_FLAGS[leaf];
  if (contract === undefined) {
    throw new Error(`INDEX_ARGS_INVALID: unknown index subcommand ${leaf ?? "(none)"}`);
  }
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--") || token.includes("=")) {
      throw new Error(`INDEX_ARGS_INVALID: unexpected index ${leaf} argument ${token}`);
    }
    const flag = token.slice(2);
    if (!contract.value.has(flag) && !contract.boolean.has(flag)) {
      throw new Error(`INDEX_ARGS_INVALID: --${flag} is not valid for index ${leaf}`);
    }
    if (seen.has(flag)) {
      throw new Error(`INDEX_ARGS_INVALID: --${flag} may be specified only once`);
    }
    seen.add(flag);
    if (contract.boolean.has(flag)) continue;
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`INDEX_ARGS_INVALID: --${flag} requires a value`);
    }
  }
}

export async function runIndexCommand(options: IndexCommandOptions): Promise<number> {
  const { args, vault, write, writeError } = options;
  const command = args.positional[1];

  const ensureMutableTarget = (): boolean => {
    if (options.source !== "cwd") return true;
    writeError("Index mutations require --vault or an existing verified vault/bridge/env target.");
    return false;
  };
  const onlyOptions = (allowed: readonly string[]): boolean => {
    const unsupported = Object.keys(args.options).filter((key) => !allowed.includes(key));
    if (unsupported.length === 0) return true;
    writeError(`[oms] Unsupported index ${command ?? "(none)"} option: --${unsupported[0]!.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
    return false;
  };

  if (command === "repair") {
    if (!ensureMutableTarget()) return 1;
    const mode = stringOption(args, "mode");
    if (args.positional.some((value) => value.startsWith("--mode="))) {
      writeError('CLI "--mode=rebuild" is unsupported; use "--mode rebuild".');
      return 1;
    }
    if (args.positional.length !== 2) {
      writeError("Usage: oms index repair --mode rebuild|drop [--dry-run]");
      return 1;
    }
    if (typeof args.options["mode"] === "string" && args.options["mode"].includes("\u0000")) {
      writeError('CLI "--mode" may be specified only once.');
      return 1;
    }
    if (mode === undefined) {
      writeError('CLI "oms index repair" requires "--mode rebuild" or "--mode drop".');
      return 1;
    }
    if (mode !== "rebuild" && mode !== "drop") {
      writeError('CLI "oms index repair --mode" must be "rebuild" or "drop".');
      return 1;
    }
    if (!onlyOptions(["mode", "dryRun"])) return 1;
    printJson(write, repairEngineStore({ vault, mode, dryRun: booleanOption(args, "dryRun") }));
    return 0;
  }

  if (command === "sync") {
    if (!ensureMutableTarget()) return 1;
    if (args.positional.length !== 2 || !onlyOptions(["collection", "index", "chunkStrategy", "maxDocsPerBatch", "maxBatchMb"])) {
      if (args.positional.length !== 2) writeError("Usage: oms index sync [options]");
      return 1;
    }
    return runEngineSession(vault, { write: true, embed: false }, async (adapter) => {
      const result = await adapter.syncEmbeddings({
        vault,
        collection: stringOption(args, "collection"),
        index: stringOption(args, "index"),
        embed: false,
        chunkStrategy: stringOption(args, "chunkStrategy"),
        maxDocsPerBatch: numberOption(args, "maxDocsPerBatch"),
        maxBatchMb: numberOption(args, "maxBatchMb"),
      });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "embed") {
    if (!ensureMutableTarget()) return 1;
    if (args.positional.length !== 2 || !onlyOptions(["collection", "index", "chunkStrategy", "maxDocsPerBatch", "maxBatchMb"])) {
      if (args.positional.length !== 2) writeError("Usage: oms index embed [options]");
      return 1;
    }
    return runEngineSession(vault, { write: true, embed: true }, async (adapter) => {
      const result = await adapter.syncEmbeddings({
        vault,
        collection: stringOption(args, "collection"),
        index: stringOption(args, "index"),
        embed: true,
        chunkStrategy: stringOption(args, "chunkStrategy"),
        maxDocsPerBatch: numberOption(args, "maxDocsPerBatch"),
        maxBatchMb: numberOption(args, "maxBatchMb"),
      });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "status") {
    const viewFlag = args.positional[2];
    const view = viewFlag === "--view" ? args.positional[3] : "status";
    if (
      (args.positional.length !== 2 && args.positional.length !== 4)
      || (args.positional.length === 4 && viewFlag !== "--view")
      || (view !== "status" && view !== "collections" && view !== "contexts")
      || !onlyOptions(["index", "collection"])
    ) {
      writeError("Usage: oms index status [--view status|collections|contexts] [--index <path>]");
      return 1;
    }
    if (!existsSync(engineStorePath(vault))) {
      writeError("No engine store; run `oms index sync`.");
      return 1;
    }
    try {
      return await runEngineSession(vault, { write: false }, async (adapter) => {
        if (view === "collections") {
          const result = adapter.listCollections({ vault, index: stringOption(args, "index") });
          if (!result.available) {
            printJson(write, result);
            return 1;
          }
          const collection = stringOption(args, "collection");
          printJson(write, {
            collections: collection === undefined
              ? result.collections
              : result.collections.filter((item) => item.name === collection),
          });
          return 0;
        }
        if (view === "contexts") {
          const result = await adapter.listContexts({ vault, index: stringOption(args, "index") });
          printJson(write, result);
          return result.available ? 0 : 1;
        }
        const result = await adapter.semanticStatus({ vault, index: stringOption(args, "index") });
        printJson(write, result);
        return result.available ? 0 : 1;
      });
    } catch (error) {
      if (engineStoreDiagnostic(error) === "corrupt-or-incompatible" && error instanceof Error) {
        writeError(`${error.message} Run "oms index repair --mode rebuild" to create a fresh store.`);
        return 1;
      }
      throw error;
    }
  }

  if (command === "clean") {
    if (!ensureMutableTarget()) return 1;
    if (args.positional.length !== 2 || !onlyOptions(["index"])) {
      if (args.positional.length !== 2) writeError("Usage: oms index clean [--index <path>]");
      return 1;
    }
    return runEngineSession(vault, { write: true }, async (adapter) => {
      const result = await adapter.cleanup({ vault, index: stringOption(args, "index") });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  writeError(`[oms] Unknown index subcommand: ${command ?? "(none)"}`);
  writeError(searchUsage());
  return 1;
}
