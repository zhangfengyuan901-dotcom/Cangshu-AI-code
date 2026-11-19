const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {_electron}=require('playwright-core');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hamster-local-account-')),out=path.resolve(__dirname,'../../output/account-local-current');fs.mkdirSync(out,{recursive:true});
execFileSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(root,'key.pem'),'-out',path.join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore',windowsHide:true});
(async()=>{
  const packaged=process.argv.includes('--packaged');
  const app=await _electron.launch({executablePath:require('electron'),args:[path.join(__dirname,'qa-local-account-main.cjs')],env:{...require('../codex-local.cjs').nativeEnvironment(),HAMSTER_LOCAL_ACCOUNT_QA_ROOT:root,HAMSTER_LOCAL_ACCOUNT_QA_PACKAGED:packaged?'1':'0'},timeout:30000});
  const errors=[];
  try{
    const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
    await page.locator('#registerLocalAccount').waitFor({state:'visible'});
    assert.equal(await page.locator('#relayAccountViewport').count(),0);
    const [auth]=await Promise.all([app.waitForEvent('window'),page.locator('#loginLocalAccount').click()]);await Promise.all([auth.waitForEvent('close'),auth.locator('#finish').click()]);
    await page.locator('#localAccountWallet').waitFor({state:'visible'});assert.equal(await page.locator('#localAccountBalance').innerText(),'¥140.00');
    await page.locator('#createImageKey').click();await page.getByRole('dialog').getByRole('button',{name:'开通并启用',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#relayImageConnection').dataset.state==='ready');
    let facts=await app.evaluate(()=>global.__localAccountQA.facts());assert.equal(facts.encrypted,true);assert.equal(facts.protected,true);assert.equal(facts.configured,true);assert.equal(facts.children,0);
    const events=await app.evaluate(()=>global.__localAccountQA.observed);assert.equal(events.creates,1);assert.equal(events.reveals,1);assert.equal(events.cookies,events.origins);assert.ok(events.cookies>=1);
    const display=await page.evaluate(()=>window.hamsterDesktopAccount.command('snapshot'));assert.doesNotMatch(JSON.stringify(display),/synthetic-access|qa-rotated|sk-/);
    const [recharge]=await Promise.all([app.waitForEvent('window'),page.locator('#payLocalAccount').click()]);
    await recharge.getByRole('button',{name:'打开合成支付'}).waitFor();
    const [pay]=await Promise.all([app.waitForEvent('window',{timeout:10000}),recharge.getByRole('button',{name:'打开合成支付'}).click()]);
    await recharge.close();assert.equal((await page.evaluate(()=>window.hamsterDesktopAccount.command('snapshot'))).code,'WINDOW_OPEN');await pay.close();
    await page.locator('#localAccountWallet').waitFor({state:'visible'});await page.locator('#refreshLocalAccount').click();await page.waitForFunction(()=>document.querySelector('#localAccountNotice').textContent==='');
    const after=await app.evaluate(()=>global.__localAccountQA.observed);assert.ok(after.cookies>=2);assert.equal(after.cookies,after.origins);assert.equal(after.creates,1);
    await page.screenshot({path:path.join(out,'account-local.png'),scale:'css'});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,720));await page.screenshot({path:path.join(out,'account-local-compact.png'),scale:'css'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,packaged?'electron-packaged-verification.json':'electron-verification.json'),JSON.stringify({ok:true,synthetic:true,packagedModules:packaged,strictSecureHttpOnlyCookie:true,cookieRotation:true,encryptedKeyStore:true,localHomeWithoutEmbeddedView:true,paymentWindowIsolation:true,observed:after,pageErrors:errors,profile:root},null,2));
    console.log(JSON.stringify({ok:true,observed:after,pageErrors:errors}));
  }catch(error){fs.writeFileSync(path.join(out,'electron-failure.json'),JSON.stringify({error:String(error),pageErrors:errors,profile:root,observed:await app.evaluate(()=>global.__localAccountQA?.observed).catch(()=>null),pages:app.windows().map(page=>page.url())},null,2));throw error;}finally{await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
