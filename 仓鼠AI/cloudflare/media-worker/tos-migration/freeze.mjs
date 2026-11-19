import released from '../src/worker.js';
import { freezeStorageRoutes } from '../../../../deploy/tool-control/tos-migration/storage-freeze.mjs';

export default freezeStorageRoutes(released, {
  POST: ['/v1/upload'],
  DELETE: ['/v1/objects'],
});
