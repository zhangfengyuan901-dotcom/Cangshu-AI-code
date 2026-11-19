// Internal one-time provisioning. Input is a JSON mail credential on stdin, never logged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const folder=path.resolve(__dirname,'../../output/billing-private');
const file=path.join(folder,'admin.json');
let secrets;
if(process.argv.includes('--resume')){const {endpoint,...saved}=JSON.parse(fs.readFileSync(file));if(endpoint!=='https://account.hamsterai.cc')throw Error('Unexpected target');secrets=saved;}
else {
 if(fs.existsSync(file))throw Error('Provisioning state already exists; do not rotate encryption secrets implicitly.');
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 if(!/^re_[A-Za-z0-9_]+$/.test(input.mailKey||''))throw Error('A valid mail sending credential is required.');
 const secret=()=>crypto.randomBytes(32).toString('hex');
 secrets={ADMIN_TOKEN:secret(),KEY_ENCRYPTION_SECRET:secret(),RESULT_SIGNING_SECRET:secret(),RESEND_API_KEY:input.mailKey};
 fs.mkdirSync(folder,{recursive:true});
 // Recovery copy is outside every release input and is excluded from Git.
 fs.writeFileSync(file,JSON.stringify({endpoint:'https://account.hamsterai.cc',...secrets},null,2),{mode:0o600,flag:'wx'});
}
const result=spawnSync(process.execPath,[path.join(__dirname,'node_modules/wrangler/bin/wrangler.js'),'secret','bulk'],{cwd:__dirname,input:JSON.stringify(secrets),encoding:'utf8',windowsHide:true});
if(result.status!==0){console.error('Secret provisioning failed; recovery file retained.');process.exitCode=1;}else console.log('Independent billing secrets provisioned. Recovery: output/billing-private/admin.json');
