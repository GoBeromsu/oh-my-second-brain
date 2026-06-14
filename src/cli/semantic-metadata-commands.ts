import {
  addSemanticContext,
  listSemanticCollections,
  listSemanticContexts,
  removeSemanticCollection,
  removeSemanticContext,
  syncSemanticEmbeddingStore,
  updateSemanticCollection,
  renameSemanticCollection,
} from "../search/semantic.js";
import {
  booleanOption,
  printJson,
  semanticStorageOption,
  stringListOption,
  stringOption,
  type ParsedSemanticArgs,
} from "./semantic-args.js";
import { semanticUsageText } from "./semantic-usage.js";

export async function runCollectionCommand(
  action: string | undefined,
  collectionPath: string | undefined,
  args: ParsedSemanticArgs,
  vault: string,
  write: (message: string) => void,
  writeError: (message: string) => void,
): Promise<number> {
  if (action === "add") {
    const result = await syncSemanticEmbeddingStore({
      vault,
      collection: stringOption(args, "collection"),
      collectionPath,
      pattern: stringOption(args, "pattern"),
      ignore: stringListOption(args, "ignore"),
      includeByDefault: booleanOption(args, "includeDefault"),
      updateCommand: stringOption(args, "updateCommand"),
      index: stringOption(args, "index"),
      storage: semanticStorageOption(args),
      modelPath: stringOption(args, "modelPath"),
      chunkStrategy: stringOption(args, "chunkStrategy"),
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }
  if (action === "list" || action === "show") {
    const result = await listSemanticCollections({ vault, index: stringOption(args, "index"), storage: semanticStorageOption(args) });
    if (!result.available) {
      printJson(write, result);
      return 1;
    }
    const name = action === "show" ? collectionPath : undefined;
    const collections = name ? result.collections.filter((collection) => collection.name === name) : result.collections;
    printJson(write, { collections });
    return 0;
  }
  if (action === "remove") {
    const result = await removeSemanticCollection({
      vault,
      index: stringOption(args, "index"),
      storage: semanticStorageOption(args),
      collection: collectionPath ?? "",
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }
  if (action === "rename") {
    const index = args.positional.indexOf(collectionPath ?? "");
    const result = await renameSemanticCollection({
      vault,
      index: stringOption(args, "index"),
      storage: semanticStorageOption(args),
      from: collectionPath ?? "",
      to: args.positional[index + 1] ?? "",
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }
  if (action === "update-cmd" || action === "include" || action === "exclude") {
    const index = args.positional.indexOf(collectionPath ?? "");
    const result = await updateSemanticCollection({
      vault,
      index: stringOption(args, "index"),
      storage: semanticStorageOption(args),
      collection: collectionPath ?? "",
      updateCommand: action === "update-cmd" ? args.positional.slice(index + 1).join(" ") : undefined,
      includeByDefault: action === "include" ? true : action === "exclude" ? false : undefined,
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }
  writeError(semanticUsageText());
  return 1;
}

function contextTarget(target: string | undefined): { readonly collection?: string; readonly pathPrefix?: string } {
  if (!target || target === "global") return { pathPrefix: "." };
  const slash = target.indexOf("/");
  if (slash < 0) return { collection: target, pathPrefix: "." };
  return { collection: target.slice(0, slash), pathPrefix: target.slice(slash + 1) || "." };
}

export async function runContextCommand(
  action: string | undefined,
  rest: readonly string[],
  args: ParsedSemanticArgs,
  vault: string,
  write: (message: string) => void,
  writeError: (message: string) => void,
): Promise<number> {
  if (action === "list" || !action) {
    const result = await listSemanticContexts({ vault, index: stringOption(args, "index"), storage: semanticStorageOption(args) });
    printJson(write, result);
    return result.available ? 0 : 1;
  }
  const target = contextTarget(rest[1]);
  if (action === "add") {
    const context = rest.slice(2).join(" ").trim();
    if (!context) {
      writeError("Usage: oms semantic context add [collection[/path]] <text>");
      return 1;
    }
    const result = await addSemanticContext({
      vault,
      index: stringOption(args, "index"),
      storage: semanticStorageOption(args),
      ...target,
      context,
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }
  if (action === "rm" || action === "remove") {
    const result = await removeSemanticContext({
      vault,
      index: stringOption(args, "index"),
      storage: semanticStorageOption(args),
      ...target,
    });
    printJson(write, result);
    return result.available ? 0 : 1;
  }
  writeError(semanticUsageText());
  return 1;
}
