import * as fs from "node:fs";
import * as path from "node:path";

export function writeProposal(
  vaultPath: string,
  slug: string,
  content: string,
  now = new Date(),
): string {
  const proposalsDir = path.join(vaultPath, ".omsb", "proposals");
  fs.mkdirSync(proposalsDir, { recursive: true });

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${slug}.md`;
  const outPath = path.join(proposalsDir, filename);
  fs.writeFileSync(outPath, content, "utf-8");
  return outPath;
}
