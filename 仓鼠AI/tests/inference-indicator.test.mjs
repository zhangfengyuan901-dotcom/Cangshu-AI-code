import test from 'node:test';
import assert from 'node:assert/strict';
import {createInferenceIndicator,inferenceView} from '../public/inference-indicator.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('relay mode asks for PIKNO Key instead of legacy email login',async()=>{
 const views=[],notices=[];
 const indicator=createInferenceIndicator({isAuthenticated:()=>false,isRelay:()=>true,request:()=>assert.fail('unconfigured Key must not request'),onChange:v=>views.push(v),notify:v=>notices.push(v)});
 await indicator.check({manual:true});
 assert.match(notices[0],/PIKNO Key/);
 assert.doesNotMatch(notices[0],/邮箱|登录/);
 assert.equal(views.at(-1).connected,false);
 assert.match(inferenceView({status:'rejected'},true,true).message,/Key 验证未通过/);
});
test('closed relay intelligence is explicit, gray and never exposes a service response',async()=>{
 const views=[];
 const indicator=createInferenceIndicator({isAuthenticated:()=>true,isRelay:()=>true,request:()=>Promise.reject(Object.assign(Error('private sk-secret https://upstream.test'),{status:503})),onChange:view=>views.push(view)});
 await indicator.check();assert.equal(views.at(-1).connected,false);assert.equal(views.at(-1).status,'unavailable');
 assert.match(views.at(-1).label,/尚未开放或暂时不可用/);assert.doesNotMatch(views.at(-1).label,/sk-secret|upstream/);
});
function fixture(){let authenticated=false,calls=0,reply=()=>Promise.resolve({configured:true});const views=[],notices=[];const indicator=createInferenceIndicator({isAuthenticated:()=>authenticated,request:()=>{calls++;return reply();},onChange:v=>views.push(v),notify:v=>notices.push(v)});return {indicator,views,notices,get view(){return views.at(-1);},get calls(){return calls;},login:()=>authenticated=true,logout:()=>{authenticated=false;indicator.reset();},respond:fn=>reply=fn};}
test('unauthenticated logo never sends requests; login alone cannot show connected',async()=>{
 const f=fixture();await f.indicator.check({manual:true});assert.equal(f.calls,0);assert.equal(f.view.status,'signed-out');assert.match(f.notices[0],/尚未登录/);
 f.login();f.indicator.render();assert.equal(f.view.connected,false);
 const wait=deferred();f.respond(()=>wait.promise);const check=f.indicator.check();assert.equal(f.view.checking,true);assert.equal(f.view.connected,false);wait.resolve({configured:true});await check;assert.equal(f.view.connected,true);
});
test('repeated clicks share one check; subsequent manual click rechecks remotely',async()=>{
 const f=fixture();f.login();const wait=deferred();f.respond(()=>wait.promise);const first=f.indicator.check({manual:true}),second=f.indicator.check({manual:true});assert.equal(first,second);await Promise.resolve();assert.equal(f.calls,1);
 wait.resolve({configured:true});await first;assert.equal(f.notices.length,1);await f.indicator.check({manual:true});assert.equal(f.calls,2);
});
test('network and auth errors gray the logo, suppress private messages, recovery lights it',async()=>{
 const f=fixture();f.login();await f.indicator.check();assert.equal(f.view.connected,true);
 for(const status of [503,401,403]){f.respond(()=>Promise.reject(Object.assign(Error('private provider endpoint secret'),{status})));await f.indicator.check({manual:true});assert.equal(f.view.connected,false);assert.doesNotMatch(f.notices.at(-1),/private|provider|secret/);}
 f.respond(()=>Promise.resolve({configured:'true'}));await f.indicator.check();assert.equal(f.view.connected,false);
 f.respond(()=>Promise.resolve({configured:true}));await f.indicator.check();assert.equal(f.view.connected,true);
 assert.equal(inferenceView({status:'error',activated:true},true).connected,false);
});
test('logout or offline invalidates pending success and suppresses its toast',async()=>{
 const f=fixture();f.login();const wait=deferred();f.respond(()=>wait.promise);const check=f.indicator.check({manual:true});await Promise.resolve();f.logout();wait.resolve({configured:true});await check;assert.equal(f.view.status,'signed-out');assert.equal(f.notices.length,0);
 f.login();const pending=deferred();f.respond(()=>pending.promise);const again=f.indicator.check();await Promise.resolve();f.indicator.reset('error');pending.resolve({configured:true});await again;assert.equal(f.view.status,'error');assert.equal(f.view.connected,false);
});
test('stale request cannot overwrite a later successful session check',async()=>{
 const f=fixture();f.login();const wait=deferred();f.respond(()=>wait.promise);const old=f.indicator.check();await Promise.resolve();f.logout();f.login();f.respond(()=>Promise.resolve({configured:true}));await f.indicator.check();wait.reject(Object.assign(Error('expired'),{status:401}));await old;assert.equal(f.view.connected,true);
});
