'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const app=path.resolve(__dirname,'..'),tests=path.join(app,'tests'),manifest=JSON.parse(fs.readFileSync(path.join(tests,'release-suite.json'),'utf8'));
assert.equal(manifest.format,1);assert.equal(manifest.scope,'accepted-current-release-contracts');
assert(Array.isArray(manifest.files)&&manifest.files.length&&new Set(manifest.files).size===manifest.files.length);
const files=manifest.files.map(name=>{assert(/^[a-z0-9-]+\.test\.(?:js|mjs)$/.test(name));const file=path.join(tests,name);assert(fs.statSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());return file;});
console.log(JSON.stringify({scope:manifest.scope,files:files.length,fullSuiteCommand:manifest.fullSuiteCommand,includesHistoricalUnreleasedAssertions:false}));
const result=cp.spawnSync(process.execPath,['--test','--test-timeout=20000',...files],{cwd:app,stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
