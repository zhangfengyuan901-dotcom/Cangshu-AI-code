const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const VIEWS = new Set(['generate','chat','digital','depth','reverse','assets','canvas','history','account']);
const MAX_BYTES = 512;

function validPreference(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Object.hasOwn(value,'lastView') && VIEWS.has(value.lastView);
}

// Only a page name is durable here. Account and authorization state stay in
// their existing protected stores and must be checked separately.
function createStartupPreferences({configPath,fsImpl=fs}) {
  const file = path.join(path.dirname(path.resolve(configPath)),'ui-preferences.json');
  if(file === path.resolve(configPath)) throw new Error('Invalid preferences location');
  let lastView = null, queue = Promise.resolve();
  try {
    const stat = fsImpl.lstatSync(file);
    if(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES) {
      const stored = JSON.parse(fsImpl.readFileSync(file,'utf8'));
      if(stored && stored.format === 1 && Object.keys(stored).length === 2 && validPreference({lastView:stored.lastView})) lastView = stored.lastView;
    }
  } catch { /* Missing or invalid preferences do not affect account data. */ }
  const get = () => ({lastView});
  const set = value => {
    if(!validPreference(value)) return Promise.reject(new Error('Invalid preferences'));
    const selected = value.lastView;
    const pending = queue.then(async () => {
      if(selected === lastView) return get();
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fsImpl.promises.mkdir(path.dirname(file),{recursive:true});
        await fsImpl.promises.writeFile(temporary,JSON.stringify({format:1,lastView:selected})+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
        await fsImpl.promises.rename(temporary,file);
        lastView = selected;
        return get();
      } finally {
        await fsImpl.promises.unlink(temporary).catch(()=>{});
      }
    });
    // A failed save does not poison later attempts or change the last good page.
    queue = pending.catch(()=>{});
    return pending;
  };
  return {get,set};
}

module.exports = {createStartupPreferences,validPreference,MAX_BYTES};
