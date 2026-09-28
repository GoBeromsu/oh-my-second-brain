// This module necessarily names the removed 0.18 command families: each entry
// is the one-line migration a user sees when an old spelling is typed. Nothing
// here executes the old command; a removed family is never an alias.

/** Removed 0.18 families and older retired names, each mapped to its 0.19 replacement. */
export const REMOVED_FAMILY_GUIDANCE: Readonly<Record<string, string>> = {
  contract: "Use `oms setup`, `oms setup extract`, `oms setup status`, or `oms doctor contract`.",
  note: "Use `oms search --path <note>` or `oms doctor audit`.",
  link: "Use `oms search --link <note>` or `oms doctor link-check <note>`.",
  bridge: "Use `oms setup bridge add|remove|status`.",
  index: "Use `oms doctor sync-embeddings --mode sync|embed|repair`, `oms doctor cleanup`, or `oms doctor status`.",
  graph: "Use `oms doctor build-graph` or `oms doctor status`.",
  host: "Use `oms setup host install|remove|sync|status`.",
  package: "Use `oms setup package check|update`.",
  model: "Use `oms setup model install|select|waive|status`.",
  status: "Use `oms doctor status`.",
  template: "Use `oms setup`, `oms setup extract`, `oms setup status`, or `oms doctor contract`.",
  audit: "Use `oms doctor audit`.",
  reconcile: "Use `oms setup host sync`.",
  linkify: "Use `oms search --link <note>` or `oms doctor link-check <note>`; OMS does not edit note bodies.",
  embed: "Use `oms doctor sync-embeddings --mode embed`.",
  doc: "Use `oms search --path <note>`.",
  mcp: "Use `oms serve mcp`.",
  lint: "Use `oms doctor link-check`.",
  install: "Use `oms setup host install`.",
  uninstall: "Use `oms setup host remove`.",
  update: "Use `oms setup package update`.",
};

/** The ten families 0.19 removed; the remaining guidance keys were retired earlier. */
export const REMOVED_0_19_FAMILIES: readonly string[] = [
  "contract", "note", "link", "bridge", "index", "graph", "host", "package", "model", "status",
];

/** The one-line migration for a removed or retired command, or undefined for an unknown one. */
export function removedFamilyMessage(command: string): string | undefined {
  if (!Object.hasOwn(REMOVED_FAMILY_GUIDANCE, command)) return undefined;
  const kind = REMOVED_0_19_FAMILIES.includes(command) ? "was removed in 0.19" : "is retired";
  return `[oms] Command \`${command}\` ${kind}. ${REMOVED_FAMILY_GUIDANCE[command]}`;
}
