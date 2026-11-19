import released from '../control-migration/worker.mjs';
import { STORE_PREFIX, isAssetPath } from '../control-migration/protocol.mjs';
import { frozenResponse } from '../../../deploy/tool-control/tos-migration/storage-freeze.mjs';

export default {
  fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (request.method === 'PUT' && isAssetPath(path) ||
        (request.method === 'PUT' || request.method === 'DELETE') && path.startsWith(STORE_PREFIX)) {
      const response = frozenResponse();
      if (request.headers.get('origin') === 'https://www.piknoai.com') {
        response.headers.set('Access-Control-Allow-Origin', 'https://www.piknoai.com');
        response.headers.set('Vary', 'Origin');
      }
      return response;
    }
    return released.fetch(request, env, context);
  },
};
