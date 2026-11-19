'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const hook=fs.readFileSync(path.join(__dirname,'../electron/installer.nsh'),'utf8');
const guard=hook.match(/!macro customCheckAppRunning\s+([\s\S]*?)!macroend/)?.[1];

test('silent installer and uninstaller replace automatic process shutdown with an exact non-destructive process query',()=>{
 assert(guard,'customCheckAppRunning must override the shared template hook');
 assert.match(guard,/\$\{nsProcess::FindProcess\}\s+"\$\{APP_EXECUTABLE_FILENAME\}"\s+\$0/);
 assert.doesNotMatch(guard,/KillProcess|CloseProcess|Stop-Process|taskkill|Exec(?:Wait|Shell)?\s|MessageBox/);
 assert.equal((hook.match(/!macro customCheckAppRunning/g)||[]).length,1);
});

test('running clients exit with 20 and only the explicit process-not-running result can continue',()=>{
 assert.match(guard,/\$\{If\}\s+\$0\s*==\s*0\s+[\s\S]*?SetErrorLevel\s+20\s+Quit\s+\$\{ElseIf\}\s+\$0\s*!=\s*603\s+[\s\S]*?SetErrorLevel\s+21\s+Quit\s+\$\{EndIf\}/);
 assert.match(guard,/^\s*(?:;[^\n]*\n\s*)*Push \$0/);
 const branches=guard.split(/\$\{If\}|\$\{ElseIf\}|\$\{EndIf\}/);
 for(const branch of branches.slice(1))assert.match(branch,/\$\{nsProcess::Unload\}\s+Pop \$0/);
});

test('runtime preparation and cleanup keep their existing synchronous error and data-preservation contract',()=>{
 assert.match(hook,/!macro customInstall[\s\S]*?ExecWait[^\n]*--hamster-prepare-installed-runtime[^\n]*\$0/);
 assert.match(hook,/!macro customUnInstall[\s\S]*?ExecWait[^\n]*--hamster-remove-installed-runtime[^\n]*\$0/);
 assert.equal((hook.match(/SetErrorLevel 1\s+MessageBox[\s\S]*?Abort/g)||[]).length,2);
 assert.doesNotMatch(hook,/--delete-app-data|RMDir/);
});
