import released from '../release/worker-release.js';
import { createMigrationWorker } from './router.mjs';

export default createMigrationWorker(released);
