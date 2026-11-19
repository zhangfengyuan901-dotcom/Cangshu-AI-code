import {getInteractionPreferences,observeInteractionPreferences,claimMediaPlayback} from './interaction-policy.mjs';
let previewSequence = 0;

export function safeMaterialPreviewUrl(value, origin = globalThis.location?.origin) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  try {
    const base = new URL(origin), url = new URL(value, base);
    if (!['http:', 'https:'].includes(base.protocol) || url.origin !== base.origin || url.username || url.password) return null;
    return ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function materialPreviewPosition(anchor, size, viewport, gap = 12) {
  const margin = 12, maxX = Math.max(margin, viewport.width - size.width - margin);
  let left = anchor.right + gap, top = anchor.top;
  if (left > maxX) left = anchor.left - size.width - gap;
  if (left < margin) { left = Math.min(Math.max(margin, anchor.left), maxX); top = anchor.top - size.height - gap; }
  if (top < margin) top = anchor.bottom + gap;
  return {left:Math.max(margin, Math.min(left, maxX)), top:Math.max(margin, Math.min(top, viewport.height - size.height - margin))};
}

// Delegated listeners survive progress updates and keyed card reuse.
export function mountMaterialPreview(container, {resolve, selector='[data-material-preview]', openSelector=selector, onOpen,
  document=container?.ownerDocument || globalThis.document, window=document?.defaultView || globalThis.window,
  setTimer=setTimeout, clearTimer=clearTimeout, openDelay=180, closeDelay=120} = {}) {
  if (!container || !document || typeof resolve !== 'function') throw new TypeError('Material preview requires a container and resolver');
  const node=(tag,cls)=>{const element=document.createElement(tag);element.className=cls;return element;};
  const popup=node('div','material-hover-preview');popup.hidden=true;popup.id=`material-hover-preview-${++previewSequence}`;popup.setAttribute('role','tooltip');
  const image=node('img','material-hover-image'),name=node('span','material-hover-name'),error=node('span','material-hover-error');
  const video=node('video','material-hover-video');video.muted=true;video.loop=true;video.playsInline=true;video.preload='none';video.hidden=true;
  const detail=node('span','material-hover-detail');detail.hidden=true;
  error.textContent='图片暂时无法预览';error.hidden=true;popup.append(image,error,name,video,detail);(container.closest?.('dialog')||document.body).append(popup);
  const modal=node('dialog','material-image-dialog'),heading=node('h2','material-image-title'),close=node('button','material-image-close');
  heading.id=`material-image-title-${previewSequence}`;modal.setAttribute('aria-labelledby',heading.id);
  close.type='button';close.textContent='关闭';close.setAttribute('aria-label','关闭图片预览');
  const full=node('img','material-image-full'),fullError=node('p','material-image-error');fullError.textContent='图片暂时无法预览';fullError.hidden=true;
  const fullVideo=node('video','material-image-full material-full-video'),fullAudio=node('audio','material-full-audio');
  fullVideo.controls=true;fullVideo.playsInline=true;fullVideo.preload='none';fullVideo.hidden=true;fullAudio.controls=true;fullAudio.preload='none';fullAudio.hidden=true;
  modal.append(heading,close,full,fullError,fullVideo,fullAudio);document.body.append(modal);
  let target=null,current=null,opening=null,closing=null,disposed=false,returnFocus=null,dialogItem=null,suppressFocus=false,blockedPointer=null,hoverRelease=null,modalRelease=null;
  const stopMedia=media=>{try{media.pause?.();media.removeAttribute('src');media.load?.();}catch{}};
  const itemFor=button=>{
    try { const value=resolve(button),src=safeMaterialPreviewUrl(value?.src,window.location?.origin),kind=value?.kind||'image';return src&&['image','video','audio','document'].includes(kind)?{...value,src,kind,name:typeof value.name==='string'?value.name:'素材'}:null; }
    catch { return null; }
  };
  const match=event=>{const button=event.target?.closest?.(selector);return button&&container.contains(button)?button:null;};
  function timers(){if(opening!==null)clearTimer(opening);if(closing!==null)clearTimer(closing);opening=closing=null;}
  function removeDescription(){
    if(!target)return;
    const values=(target.getAttribute('aria-describedby')||'').split(/\s+/).filter(value=>value&&value!==popup.id);
    if(values.length)target.setAttribute('aria-describedby',values.join(' '));else target.removeAttribute('aria-describedby');
  }
  function closeDialog(restore=true){
    // Native dialog.close() can synchronously restore focus to its trigger.
    // Suppress that focusin before calling close, as well as our explicit restore.
    const focus=returnFocus,wasSuppressed=suppressFocus;suppressFocus=true;
    try {
      if(modal.open){suppressPointer(focus);modal.close();}full.removeAttribute('src');stopMedia(fullVideo);stopMedia(fullAudio);modalRelease?.();modalRelease=null;fullError.hidden=true;
      if(restore&&focus?.isConnected)focus.focus({preventScroll:true});
    } finally {suppressFocus=wasSuppressed;returnFocus=null;dialogItem=null;}
  }
  function hide(){timers();removeDescription();target=null;current=null;popup.hidden=true;image.removeAttribute('src');stopMedia(video);hoverRelease?.();hoverRelease=null;}
  // Removing a modal can put the unchanged pointer back over its source.
  // Wait for a real exit before accepting another pointer entry there.
  function suppressPointer(button){if(button&&container.contains(button)){blockedPointer=button;if(target===button)hide();}}
  function position(){
    if(popup.hidden||!target?.isConnected)return;
    const rect=target.getBoundingClientRect();
    if(!rect.width||!rect.height||rect.bottom<0||rect.top>window.innerHeight){hide();return;}
    const size=popup.getBoundingClientRect(),at=materialPreviewPosition(rect,{width:size.width,height:size.height},{width:window.innerWidth,height:window.innerHeight});
    popup.style.left=`${at.left}px`;popup.style.top=`${at.top}px`;
  }
  function show(button){
    if(disposed||!button?.isConnected)return hide();
    const item=itemFor(button);if(!item)return hide();
    const prefs=getInteractionPreferences(window);if(item.kind==='video'&&(!prefs.hoverVideo||prefs.effectiveReducedMotion))return hide();
    const release=claimMediaPlayback(window,hide);hoverRelease=release;
    removeDescription();target=button;current=item;name.textContent=item.name;image.alt=item.name;error.hidden=true;
    image.hidden=item.kind!=='image';video.hidden=item.kind!=='video';detail.hidden=!['audio','document'].includes(item.kind);
    if(item.kind==='image'){error.textContent='图片暂时无法预览';image.src=item.src;}
    else if(item.kind==='video'){video.muted=true;video.src=item.src;try{Promise.resolve(video.play?.()).catch(()=>{if(current?.src===item.src){video.hidden=true;error.textContent='视频暂时无法播放，请点击查看';error.hidden=false;position();}});}catch{video.hidden=true;error.textContent='视频暂时无法播放，请点击查看';error.hidden=false;}}
    else detail.textContent=item.detail||(item.kind==='audio'?'音频 · 点击播放':'文档 · 点击查看');
    popup.hidden=false;
    const description=(button.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);description.push(popup.id);button.setAttribute('aria-describedby',[...new Set(description)].join(' '));position();
  }
  function queue(button){
    if(disposed||modal.open||!button||button.disabled||!itemFor(button))return;
    const item=itemFor(button),prefs=getInteractionPreferences(window);if(item.kind==='video'&&(!prefs.hoverVideo||prefs.effectiveReducedMotion))return;
    if(target===button&&!popup.hidden){if(closing!==null)clearTimer(closing);closing=null;return;}
    hide();target=button;opening=setTimer(()=>{opening=null;show(button);},item.kind==='video'?350:openDelay);
  }
  function leave(event){
    const button=match(event);if(!button||button!==target||button.contains(event.relatedTarget)||popup.contains(event.relatedTarget))return;
    if(opening!==null){hide();return;}
    if(closing!==null)clearTimer(closing);closing=setTimer(hide,closeDelay);
  }
  function open(event){
    const button=event.target?.closest?.(openSelector),item=button&&container.contains(button)&&itemFor(button);if(!item||button.disabled)return;
    event.preventDefault();hide();
    if(onOpen){modalRelease?.();modalRelease=claimMediaPlayback(window,()=>{hide();modalRelease=null;});onOpen(item,button);return;}
    closeDialog(false);modalRelease=claimMediaPlayback(window,()=>closeDialog(false));returnFocus=button;dialogItem=item;heading.textContent=item.name;full.alt=item.name;fullError.hidden=true;
    fullError.textContent='媒体暂时无法预览';full.hidden=item.kind!=='image';fullVideo.hidden=item.kind!=='video';fullAudio.hidden=item.kind!=='audio';
    if(item.kind==='image')full.src=item.src;
    else if(item.kind==='video'||item.kind==='audio'){const player=item.kind==='video'?fullVideo:fullAudio;player.src=item.src;if(item.kind==='video'){try{Promise.resolve(player.play?.()).catch(()=>{});}catch{}}}
    else {fullError.textContent=item.detail||'请在原页面打开此文档';fullError.hidden=false;}
    try {modal.showModal();close.focus();}catch{closeDialog(false);}
  }
  const over=event=>{const button=match(event);if(event.pointerType!=='touch'&&button!==blockedPointer)queue(button);},focus=event=>{if(!suppressFocus)queue(match(event));};
  const out=event=>{const button=match(event);if(button&&button===blockedPointer&&!button.contains(event.relatedTarget))blockedPointer=null;leave(event);};
  const pointerAway=event=>{if(blockedPointer&&!blockedPointer.contains(event.target))blockedPointer=null;};
  const popupEnter=()=>{if(closing!==null)clearTimer(closing);closing=null;},popupLeave=event=>{if(target?.contains(event.relatedTarget))return;closing=setTimer(hide,closeDelay);};
  const key=event=>{if(event.key==='Escape'){const visible=!popup.hidden||modal.open;hide();closeDialog();if(visible)event.preventDefault();}};
  const page=()=>{hide();closeDialog(false);};
  const visibility=()=>{if(document.visibilityState==='hidden')page();};
  const refresh=()=>{
    if(modal.open){const item=returnFocus?.isConnected&&itemFor(returnFocus);if(!item||item.src!==dialogItem?.src)closeDialog(false);}
    if(target){const item=target.isConnected&&itemFor(target);if(!item||current&&(item.src!==current.src||item.kind!==current.kind))hide();else if(!popup.hidden)position();}
  };
  const preferencesChanged=()=>{const prefs=getInteractionPreferences(window);if(current?.kind==='video'&&(!prefs.hoverVideo||prefs.effectiveReducedMotion))hide();};
  const unobservePreferences=observeInteractionPreferences(preferencesChanged,window);
  image.onload=position;image.onerror=()=>{image.hidden=true;error.hidden=false;position();};
  video.onloadedmetadata=position;video.onerror=()=>{if(current?.kind==='video'){video.hidden=true;error.textContent='视频暂时无法播放，请点击查看';error.hidden=false;position();}};
  full.onerror=()=>{full.hidden=true;fullError.hidden=false;};
  for(const player of [fullVideo,fullAudio]){player.onerror=()=>{player.hidden=true;fullError.textContent='媒体暂时无法播放';fullError.hidden=false;};player.addEventListener('play',()=>{modalRelease?.();modalRelease=claimMediaPlayback(window,()=>closeDialog(false));});}
  close.onclick=()=>closeDialog();modal.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  modal.addEventListener('click',event=>{if(event.target===modal)closeDialog();});
  popup.addEventListener('pointerenter',popupEnter);popup.addEventListener('pointerleave',popupLeave);
  container.addEventListener('pointerover',over);container.addEventListener('pointerout',out);container.addEventListener('focusin',focus);container.addEventListener('focusout',leave);container.addEventListener('click',open);
  document.addEventListener('keydown',key);document.addEventListener('visibilitychange',visibility);document.addEventListener('pointerover',pointerAway);
  window.addEventListener('scroll',hide,true);window.addEventListener('resize',hide);window.addEventListener('pagehide',page);window.addEventListener('hamster-view-changed',page);
  return {hide,refresh,suppressPointer,close:page,destroy(){
    if(disposed)return;disposed=true;page();
    unobservePreferences();
    container.removeEventListener('pointerover',over);container.removeEventListener('pointerout',out);container.removeEventListener('focusin',focus);container.removeEventListener('focusout',leave);container.removeEventListener('click',open);
    document.removeEventListener('keydown',key);document.removeEventListener('visibilitychange',visibility);document.removeEventListener('pointerover',pointerAway);
    window.removeEventListener('scroll',hide,true);window.removeEventListener('resize',hide);window.removeEventListener('pagehide',page);window.removeEventListener('hamster-view-changed',page);
    popup.remove();modal.remove();
  }};
}
