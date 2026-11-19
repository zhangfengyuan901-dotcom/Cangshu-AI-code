// Actual Python Conversations + installed SDK + loopback Worker adapter.
// The provider boundary is entirely synthetic, including the lost connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import worker,{createToken} from '../cloudflare/llm-worker/src/worker.js';
const root=path.resolve(import.meta.dirname,'..');
const python=process.env.HAMSTER_TEST_PYTHON||path.join(root,'smart-video-agent','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
test('Worker reference rejection reaches the real SDK replay path once; an unknown outcome does not replay',
  {concurrency:false,skip:!fs.existsSync(python),timeout:30000},async t=>{
  const env={ARK_API_KEY:'synthetic-protected-key',LLM_ENDPOINTS:'ep-offline-sdk-contract',TOKEN_SIGNING_KEY:'offline-sdk-contract-secret-32-bytes'},calls=[];
  const token=await createToken(env,'a'.repeat(64),7),original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).origin,'https://ark.cn-beijing.volces.com');
    const body=JSON.parse(options.body);calls.push(body);
    if(calls.length===2)return Response.json({error:{param:'previous_response_id',message:'private synthetic upstream text'}},{status:404});
    if(calls.length===4)throw Error('synthetic unknown connection outcome');
    if(calls.length===5)return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.created',response:{id:'response-synthetic-5',status:'in_progress'}})+'\n\n'));
      setTimeout(()=>controller.error(Error('synthetic accepted stream lost')),25);
    }}),{headers:{'content-type':'text/event-stream'}});
    const response={id:'response-synthetic-'+calls.length,object:'response',status:'completed',expire_at:Math.floor(Date.now()/1000)+86400,
      output:[{id:'message-synthetic',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'这是已完成的正常回答。',annotations:[]}]}]};
    return new Response('data: '+JSON.stringify({type:'response.created',response:{...response,status:'in_progress'}})+'\n\n'+'data: '+JSON.stringify({type:'response.completed',response})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const server=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      assert.equal(req.headers['x-hamster-execution-scope'],'a'.repeat(64));assert.equal(req.headers['x-hamster-config-revision'],'1');
      const headers=new Headers(req.headers);headers.set('Authorization','Bearer '+token);headers.set('X-Hamster-Client','hamster-desktop-v1');
      headers.delete('x-hamster-execution-scope');headers.delete('x-hamster-config-revision');
      const response=await worker.fetch(new Request('https://worker.test'+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}),env);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)Readable.fromWeb(response.body).on('error',()=>res.destroy()).pipe(res);else res.end();
    }catch{res.destroy();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{globalThis.fetch=original;await new Promise(resolve=>server.close(resolve));});
  const source=String.raw`
import asyncio,json,sys,tempfile,uuid
sys.path.insert(0,sys.argv[1])
from chat import Conversations,MessageRequest
async def main():
    with tempfile.TemporaryDirectory() as directory:
        config={'MODEL_AGENT_API_KEY':'hamster-cloud-session','MODEL_AGENT_API_BASE':sys.argv[2]+'/api/v3','LLM_ENDPOINT_ID':'hamster-auto','EXECUTION_SCOPE':'a'*64,'CONFIG_REVISION':1}
        chat=Conversations(directory,lambda:dict(config))
        item=chat.get(chat.create()['id'])
        async def turn(text):
            parent=item['messages'][-1]['id'] if item['messages'] else ''
            chat.start(item,MessageRequest(request_id=uuid.uuid4().hex,parent=parent,text=text))
            await chat.tasks[item['id']]
            await asyncio.sleep(0)
        try:
            await turn('first')
            assert item['status']=='completed',item['stage']
            assert item['chain']['id'].startswith('ho1_')
            await turn('continue after expired cloud context')
            assert item['status']=='completed',item['stage']
            assert len(item['messages'])==4
            await turn('unknown outcome must not replay')
            assert item['status']=='failed'
            assert len(item['messages'])==6
            await turn('an interrupted stream also must not replay')
            assert item['status']=='failed'
            assert item['messages'][-1]['text']==''
            assert len(item['messages'])==8
            print(json.dumps({'completed':True,'unknownStopped':True}))
        finally:
            chat.db.close()
asyncio.run(main())
`;
  const result=await promisify(execFile)(python,['-B','-c',source,path.join(root,'smart-video-agent'),'http://127.0.0.1:'+server.address().port],
    {windowsHide:true,timeout:20000,maxBuffer:65536,env:{...process.env,HAMSTER_REPORT_URL:'',PYTHONUTF8:'1'}});
  assert.equal(JSON.parse(result.stdout.trim()).unknownStopped,true);
  assert.equal(calls.length,5,'one initial POST, one rejected continuation, one replay, one unknown POST and one interrupted POST');
  assert.equal(calls[0].previous_response_id,undefined,'SDK null option must be omitted as no reference');
  assert.equal(calls[1].previous_response_id,'response-synthetic-1');
  assert.equal(calls[2].previous_response_id,undefined);assert.equal(calls[2].input.length,3);
  assert.equal(calls[3].previous_response_id,'response-synthetic-3');
});
