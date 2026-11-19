export async function fileFingerprint(file) {
  // Hash the complete bounded file: sampled bytes do not prove equality.
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export const MEDIA_EXPIRY_MARGIN_SECONDS = 60;

export function mediaUploadMetadata(value) {
  return {
    ...(Number.isFinite(value?.durationSeconds) && value.durationSeconds > 0 ? {durationSeconds:value.durationSeconds} : {}),
    ...(Number.isSafeInteger(value?.expires_at) && value.expires_at > 0 ? {expires_at:value.expires_at} : {}),
  };
}

export function mediaExpiryError(items, {required=false, now=Date.now()}={}) {
  return items.some(item => {
    const expiry=item?.expires_at;
    if(expiry===undefined&&!required)return false;
    return !Number.isSafeInteger(expiry)||expiry<=now/1000+MEDIA_EXPIRY_MARGIN_SECONDS;
  }) ? '参考素材已过期或即将到期，请重新上传' : '';
}

export async function refreshMediaReferences(items, {upload, current, required=false, now=Date.now}) {
  for(const item of items) {
    if(!current())return false;
    if(!mediaExpiryError([item],{required,now:now()}))continue;
    const fresh=await upload(item);
    if(!current())return false;
    if(!fresh?.url||mediaExpiryError([fresh],{required,now:now()}))throw Object.assign(new Error('参考素材已过期或即将到期，请重新上传'),{code:'media_reference_expired'});
    delete item.durationSeconds;delete item.expires_at;
    Object.assign(item,{url:fresh.url},mediaUploadMetadata(fresh));
  }
  return current();
}

export function createUploadQueue(limit = 2) {
  let active = 0;
  const waiting = [];
  function drain() {
    while (active < limit && waiting.length) {
      const job = waiting.shift();
      active++;
      Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
        active--;
        drain();
      });
    }
  }
  return work => new Promise((resolve, reject) => {
    waiting.push({work, resolve, reject});
    drain();
  });
}

export function createUploadGate(items) {
  const reserved = new Set();
  return {
    claim(kind, fingerprint) {
      const key = `${kind}:${fingerprint}`;
      if (reserved.has(key) || items().some(item => item.kind === kind && item.fingerprint === fingerprint)) return null;
      reserved.add(key);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          reserved.delete(key);
        }
      };
    },
  };
}
