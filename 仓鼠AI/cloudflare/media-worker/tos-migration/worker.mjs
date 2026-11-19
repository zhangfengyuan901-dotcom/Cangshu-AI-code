import released from '../src/worker.js';
import { createRemoteStorage } from '../../../../deploy/tool-control/tos-migration/proxy.mjs';

export function createTosMediaWorker(worker, { storageFactory = createRemoteStorage } = {}) {
  return {
    fetch(request, env, context) {
      const media = storageFactory({ origin: env.TOS_STORAGE_PROXY_ORIGIN, namespace: 'hamster-ai-media', secret: env.TOS_STORAGE_PROXY_SECRET });
      if (env.TOS_STORAGE_READ_ONLY === 'true') {
        const reject = () => { throw Error('Storage writes blocked for migration'); };
        return worker.fetch(request, { ...env, MEDIA: { ...media, put: reject, delete: reject } }, context);
      }
      return worker.fetch(request, { ...env, MEDIA: media }, context);
    },
  };
}

export default createTosMediaWorker(released);
