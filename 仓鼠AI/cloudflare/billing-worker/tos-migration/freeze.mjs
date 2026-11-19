import released from '../src/worker.mjs';
import { freezeStorageRoutes } from '../../../../deploy/tool-control/tos-migration/storage-freeze.mjs';

export { GenerationWorkflow } from '../src/worker.mjs';

export default freezeStorageRoutes(released, {
  POST: ['/v1/tasks', '/v1/upload'],
  DELETE: ['/v1/objects'],
});
