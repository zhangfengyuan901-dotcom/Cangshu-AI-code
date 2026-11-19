// These preferences only choose a page. They never authorize a paid operation.
export const STARTUP_VIEWS = Object.freeze(['generate','chat','digital','depth','reverse','assets','canvas','history','account']);
export const isStartupView = value => STARTUP_VIEWS.includes(value);
export function configuredKinds(config = {}) {
  if(!config||typeof config!=='object')config={};
  return {image:config.configured===true,video:config.videoConfigured===true,tool:(config.toolConfigured??config.rhConfigured)===true,chat:(config.chatConfigured??config.llmConfigured)===true};
}
export function startupView(config, preferences = {}) {
  if(!config||typeof config!=='object')return 'account';
  const keys=configuredKinds(config);
  if(!Object.values(keys).some(Boolean))return 'account';
  const saved=isStartupView(preferences?.lastView)?preferences.lastView:null;
  if(saved==='generate'&&!keys.image&&!keys.video||saved==='chat'&&!keys.chat||['digital','depth','reverse'].includes(saved)&&!keys.tool)return 'account';
  return saved||(keys.image||keys.video?'generate':keys.chat?'chat':'digital');
}
export const needsMainCatalogue = view => ['generate','digital','depth'].includes(view);
export function startupGenerationType(config,current='video'){
  const keys=configuredKinds(config);
  return current==='image'&&keys.image?'image':keys.video?'video':keys.image?'image':current==='image'?'image':'video';
}
export function startupCheckKind(config, view) {
  const keys=configuredKinds(config);
  const preferred=view==='chat'?'chat':['digital','depth','reverse'].includes(view)?'tool':view==='generate'?(keys.video?'video':'image'):null;
  return preferred&&keys[preferred]?preferred:Object.keys(keys).find(kind=>keys[kind])||null;
}
// Serialize small preference writes; a slower previous write cannot win over
// the most recent navigation. No browser storage depends on a random port.
export function createViewPreferenceWriter(save) {
  let latest=null,pending=null;
  async function drain() {
    while(latest!==null){const view=latest;latest=null;try{await save({lastView:view});}catch{/* Preference failure does not block the application. */}}
  }
  function start(){
    if(!pending&&latest!==null)pending=drain().finally(()=>{pending=null;if(latest!==null)return start();});
    return pending||Promise.resolve();
  }
  return {
    remember(view){
      if(!isStartupView(view))return Promise.resolve(false);
      latest=view;
      return start();
    },
  };
}
