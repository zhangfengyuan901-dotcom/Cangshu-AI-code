import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createPresignRoute } from './presign-route.mjs';

const key = 'synthetic-only-'.padEnd(48, 'x');
const id = '0'.repeat(32);
const now = 1794642000;
const target = 'https://www.piknoai.com/media/v1/assets/' + id + '/presign';
const sha256 = 'a'.repeat(64);

function ticket(overrides) {
  const claims = {v:1,aud:'pikno-relay-media',uid:7,id,op:'upload',iat:now - 2,exp:now + 580,mime:'image/png',size:1420828,...overrides};
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}

function request({ token = ticket(), body = JSON.stringify({sha256}), headers = {}, path = target, method = 'POST' } = {}) {
  return new Request(path, { method, ...(method === 'POST' ? {body} : {}), headers:{
    authorization:'Bearer '+token, 'content-type':'application/json', 'content-length':String(Buffer.byteLength(body)),...headers,
  } });
}

function fixture(includeTimed = false) {
  let frozen = false, allowed = true;
  const signings = [], limits = [];
  const handler = createPresignRoute({ key, includeTimed, now:() => now * 1000, readOnly:async () => frozen,
    limiter:{ limit: ({key}) => { limits.push(key); return {success:allowed}; } },
    signer(claims) { signings.push(claims); return {url:'https://synthetic.invalid/only-object',headers:{'Content-Length':'1420828'}}; },
  });
  return {handler,signings,limits,freeze:() => { frozen = true; },deny:() => { allowed = false; }};
}

test('a valid image ticket only authorizes its owner, object, size, hash and bounded lifetime', async () => {
  const f=fixture();
  const response = await f.handler(request());
  assert.equal(response.status,201);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(f.limits,['7']);
  assert.deepEqual(f.signings,[{v:1,aud:'pikno-relay-media',uid:7,id,op:'upload',iat:now-2,exp:now+240,mime:'image/png',size:1420828,sha256}]);
  assert.deepEqual(await response.json(),{id,transport:'tos-v1',method:'PUT',upload_url:'https://synthetic.invalid/only-object',headers:{'Content-Length':'1420828'},expires_at:now+240});
  await f.handler(request({token:ticket({exp:now+5})}));
  assert.equal(f.signings[1].exp,now+5);
});

test('tickets for a different object, operation, MIME, time or signature do not reach the signer', async () => {
  const f=fixture();
  for (const token of [ticket({id:'1'.repeat(32)}),ticket({op:'read'}),ticket({mime:'video/unknown'}),ticket({uid:0}),
    ticket({iat:now+31}),ticket({exp:now}),ticket({exp:now+601}),ticket({size:30*1024*1024+1}),ticket().slice(0,-2)+'zz','x.y']) {
    assert.equal((await f.handler(request({token}))).status,403);
  }
  assert.equal(f.signings.length,0);
  assert.equal(f.limits.length,0);
});

test('timed reference tickets keep the existing 50 MiB limit and legacy capability behavior', async () => {
  const legacy=fixture(), current=fixture(true), limit=50*1024*1024;
  for (const mime of ['video/mp4','video/webm','video/quicktime','audio/mpeg','audio/wav','audio/mp4','audio/aac']) {
    const authorized=ticket({mime,size:limit});
    assert.equal((await legacy.handler(request({token:authorized}))).status,404);
    assert.equal((await current.handler(request({token:authorized}))).status,201);
    assert.equal((await current.handler(request({token:ticket({mime,size:limit+1})}))).status,403);
  }
  assert.equal(current.signings.length,7);
  assert.equal(legacy.signings.length,0);
});

test('the route fences methods, unsigned input, disabled writes and account rate limits', async () => {
  const f=fixture();
  assert.equal((await f.handler(request({method:'GET'}))).status,405);
  assert.equal((await f.handler(request({path:target+'?x=1'}))).status,404);
  for (const body of ['{}', 'null', JSON.stringify({sha256,id}), JSON.stringify({sha256:'A'.repeat(64)}), ' '.repeat(129)]) {
    assert.equal((await f.handler(request({body}))).status,400);
  }
  assert.equal((await f.handler(request({headers:{'content-encoding':'gzip'}}))).status,400);
  f.deny();
  assert.equal((await f.handler(request())).status,429);
  f.freeze();
  assert.equal((await f.handler(request())).status,503);
  assert.equal(f.signings.length,0);
});
