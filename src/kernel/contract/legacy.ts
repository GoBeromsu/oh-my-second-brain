import type { ContractView, LegacyTemplateContract, VaultContract } from "./types.js";

/**
 * The templates an old (version 1 or 2) generation sealed, joined back onto its folders
 * and properties for the readers that still use them: interview, scaffold, exclusion and
 * search. A version 3 head has none, so the join is empty there. The judge never sees it.
 */
export type TemplatedContract = VaultContract & {
  readonly templates: Readonly<Record<string, LegacyTemplateContract>>;
};

/** The legacy templates of a sealed view; empty for a version 3 head or an unsealed view. */
export function legacyTemplatesOf(view: ContractView): Readonly<Record<string, LegacyTemplateContract>> {
  return view.state === "sealed" ? view.legacy?.templates ?? {} : {};
}

/** The sealed contract of `view` with its legacy templates joined on. */
export function templatedContract(view: ContractView & { readonly state: "sealed" }): TemplatedContract {
  return { ...view.contract, templates: legacyTemplatesOf(view) };
}
