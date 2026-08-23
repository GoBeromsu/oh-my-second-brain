import { appendFile, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const w='/tmp/oms-red-team-gates';
function run(label, args) { try { const o=execFileSync('npm',['test','--','--run',...args],{cwd:w,encoding:'utf8',stdio:['ignore','pipe','pipe']}); console.log(`${label}: PASS\n${o}`); } catch(e) { console.log(`${label}: FAIL\n${e.stdout||''}${e.stderr||''}`); } }
function restore() { execFileSync('git',['reset','--hard','HEAD'],{cwd:w}); execFileSync('git',['clean','-fdx','-e','node_modules'],{cwd:w}); }
await appendFile(w+'/src/kernel/index.ts','\nimport "../mcp/server.js";\n'); run('import-static-violation-detected',['test/architecture/import-boundary.test.ts']); restore();
await appendFile(w+'/src/kernel/index.ts','\nvoid import("../mcp/" + "server.js");\n'); run('import-computed-dynamic-evasion-passes',['test/architecture/import-boundary.test.ts']); restore();
await rm(w+'/assets/skills/write',{recursive:true,force:true}); run('surface-skill-removal-detected',['test/architecture/surface-parity.test.ts']); restore();
const server=await readFile(w+'/src/mcp/server.ts','utf8'); await writeFile(w+'/src/mcp/server.ts',server.replace('export const omsMcpTools: Tool[] = [','export const omsMcpTools: Tool[] = [{ name: "oms_extra", description: "evasion", inputSchema: { type: "object", properties: {} } },'));
run('surface-server-extra-tool-evasion-passes',['test/architecture/surface-parity.test.ts']); restore();
await appendFile(w+'/src/kernel/index.ts','\n'+Array(2205).fill('// module-size mutation').join('\n')); run('module-size-ts-violation-detected',['test/architecture/check-module-size.test.ts']); restore();
await writeFile(w+'/src/kernel/oversize.mts',Array(2205).fill('// unscanned mts production module').join('\n')); run('module-size-mts-evasion-passes',['test/architecture/check-module-size.test.ts']); restore();
await rm(w+'/assets/skills/write',{recursive:true,force:true}); run('vendor-skill-removal-detected',['test/architecture/vendor-discovery.test.ts']); restore();
const pkg=await readFile(w+'/package.json','utf8'); await writeFile(w+'/package.json',pkg.replace('    "assets",\n','')); run('vendor-package-assets-omission-evasion-passes',['test/architecture/vendor-discovery.test.ts']); restore();
await writeFile(w+'/CONTRIBUTING.md',(await readFile(w+'/CONTRIBUTING.md','utf8')).replace('src/kernel/', 'src/not-real/')); run('doc-mapping-dangling-reference-detected',['test/architecture/doc-mapping.test.ts']); restore();
await appendFile(w+'/docs/release.md','\nRuntime source is src/not-real/.\n'); run('doc-unmapped-stale-path-evasion-passes',['test/architecture/doc-mapping.test.ts']); restore();
