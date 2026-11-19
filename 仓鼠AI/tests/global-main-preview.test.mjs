import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {safeMaterialPreviewUrl} from '../public/material-preview.mjs';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);}
function fixture(){
 const state={tasks:[]},calls={mount:0,refresh:0,close:0},options=[];
 const context={state,safeMaterialPreviewUrl:value=>safeMaterialPreviewUrl(value,'http://127.0.0.1:12345'),escapeHtml:value=>String(value).replaceAll('"','&quot;').replaceAll('<','&lt;'),
  STATUS_LABEL:{unknown:'任务待确认',succeeded:'已完成'},taskProgressHtml:()=>'',
  mountMaterialPreview(container,configuration){calls.mount++;options.push(configuration);return {refresh(){calls.refresh++;},close(){calls.close++;}};},
 };
 vm.createContext(context);vm.runInContext(section('function taskIsText(t)','function taskKind(t)')+section('function taskPreviewEntry(task)','function taskModelLabel(task)')+section('function patchTaskCards(container,list)','function renderTaskFeed()'),context);
 return {context,state,calls,options};
}
test('all completed visual task channels use the same safe preview source and keep click distinct from card actions',()=>{
 const f=fixture();
 for(const channel of ['generate','digital','depth'])for(const type of ['image','video']){
  const task={key:channel+'-'+type,source:channel,type,status:'succeeded',result:{local_url:'/api/media/local/file'}};
  f.state.tasks=[task];const button={closest:()=>({dataset:{taskKey:task.key}})};
  assert.equal(f.context.taskResultPreviewEntry(button).kind,type);
  const markup=f.context.resultHtml(task);assert.match(markup,/^<button type="button" class="task-media-frame task-media-preview" data-preview-result/);
  assert.doesNotMatch(markup,/data-(?:retry-task|save-asset|copy-task-prompt)|data-preview-src/);
  if(type==='video'){assert.match(markup,/preload="none" muted playsinline/);assert.doesNotMatch(markup,/\bautoplay\b|\bcontrols\b/);}
 }
});
test('pending, failed, unknown, removed and externally sourced task results do not become hover media',()=>{
 const f=fixture(),task={key:'current',type:'video',status:'succeeded',result:{local_url:'/api/media/local/file'}};
 const button={closest:()=>({dataset:{taskKey:task.key}})};f.state.tasks=[task];assert(f.context.taskResultPreviewEntry(button));
 for(const status of ['queued','processing','submitting','unknown','failed']){
  task.status=status;assert.equal(f.context.taskResultPreviewEntry(button),null);assert.doesNotMatch(f.context.resultHtml(task),/<video|data-preview-result/);
 }
 task.status='succeeded';task.result={video_url:'https://synthetic.invalid/result.mp4'};
 assert.equal(f.context.taskResultPreviewEntry(button),null);assert.doesNotMatch(f.context.resultHtml(task),/synthetic\.invalid|<video|data-preview-result/);
 task.result={local_url:'/api/media/local/file'};f.state.tasks=[];assert.equal(f.context.taskResultPreviewEntry(button),null);
});
test('task feeds mount one delegated controller and refresh it after keyed updates',()=>{
 const f=fixture(),container={querySelectorAll:()=>[],children:[]};
 f.context.patchTaskCards(container,[]);f.context.patchTaskCards(container,[]);
 assert.equal(f.calls.mount,1);assert.equal(f.calls.refresh,2);assert.equal(f.options[0].selector,'[data-preview-result]');
});
test('changing motion preference disables and re-enables existing list animation controllers',()=>{
 const controllers=[],document={documentElement:{dataset:{}}},window={addEventListener(){}},initial={effectiveReducedMotion:false};let observe;
 const context={document,window,refreshIcons(){},$:()=>({}),getInteractionPreferences:()=>initial,
  observeInteractionPreferences:callback=>{observe=callback;return ()=>{};},autoAnimate:()=>{const state={enabled:0,disabled:0};controllers.push(state);return {enable(){state.enabled++;},disable(){state.disabled++;}};}};
 vm.createContext(context);vm.runInContext(section('function initUiComponents()','function escapeHtml(s)'),context);context.initUiComponents();
 assert.equal(controllers.length,5);assert(controllers.every(item=>item.enabled===1));observe({effectiveReducedMotion:true});
 assert(controllers.every(item=>item.disabled===1));assert.equal(document.documentElement.dataset.uiMotion,'reduced');
 observe({effectiveReducedMotion:false});assert(controllers.every(item=>item.enabled===2));
});
