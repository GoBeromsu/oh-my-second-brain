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

export interface IndexCommandOptions {
  readonly args: ParsedSearchArgs;
  readonly vault: string;
  readonly write: (message: string) => void;
  readonly writeError: (message: string) => void;
}

export async function runIndexCommand(options: IndexCommandOptions): Promise<number> {
  const { args, vault, write, writeError } = options;
  const command = args.positional[1];

  if (command === "repair") {
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
    const unsupported = Object.keys(args.options).filter((key) => key !== "mode" && key !== "dryRun");
    if (unsupported.length > 0) {
      writeError(`[oms] Unsupported index repair option: --${unsupported[0]!.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
      return 1;
    }
    printJson(write, repairEngineStore({ vault, mode, dryRun: booleanOption(args, "dryRun") }));
    return 0;
  }

  if (command === "sync") {
    return runEngineSession(vault, { write: true, embed: false }, async (adapter) => {
      const result = await adapter.syncEmbeddings({
        vault,
        collection: stringOption(args, "collection"),
        index: stringOption(args, "index"),
        embed: false,
        force: booleanOption(args, "force"),
        chunkStrategy: stringOption(args, "chunkStrategy"),
        maxDocsPerBatch: numberOption(args, "maxDocsPerBatch"),
        maxBatchMb: numberOption(args, "maxBatchMb"),
      });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "status") {
    if (!existsSync(engineStorePath(vault))) {
      writeError("No engine store; run `oms index sync`.");
      return 1;
    }
    try {
      return await runEngineSession(vault, { write: false }, async (adapter) => {
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

  if (command === "cleanup") {
    return runEngineSession(vault, { write: true }, async (adapter) => {
      const result = await adapter.cleanup({ vault, index: stringOption(args, "index") });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  if (command === "collections") {
    return runEngineSession(vault, { write: false }, async (adapter) => {
      const result = adapter.listCollections({ vault, index: stringOption(args, "index") });
      if (!result.available) {
        printJson(write, result);
        return 1;
      }
      const name = args.positional[2];
      printJson(write, { collections: name ? result.collections.filter((collection) => collection.name === name) : result.collections });
      return 0;
    });
  }

  if (command === "contexts") {
    return runEngineSession(vault, { write: false }, async (adapter) => {
      const result = await adapter.listContexts({ vault, index: stringOption(args, "index") });
      printJson(write, result);
      return result.available ? 0 : 1;
    });
  }

  writeError(`[oms] Unknown index subcommand: ${command ?? "(none)"}`);
  writeError(searchUsage());
  return 1;
}
