import released, { GenerationWorkflow as ReleasedGenerationWorkflow } from '../src/worker.mjs';
import { createRemoteStorage } from '../../../../deploy/tool-control/tos-migration/proxy.mjs';

function storageEnvironment(env, storageFactory) {
  const results = storageFactory({ origin: env.TOS_STORAGE_PROXY_ORIGIN, namespace: 'hamster-billing-results', secret: env.TOS_STORAGE_PROXY_SECRET });
  if (env.TOS_STORAGE_READ_ONLY !== 'true') return { ...env, RESULTS: results };
  // This guard is only for an already drained migration window. It is not a
  // Workflow pause mechanism and must not be enabled while accepted work runs.
  const reject = () => { throw Error('Storage writes blocked for migration'); };
  return { ...env, RESULTS: { ...results, put: reject, delete: reject } };
}

export function createTosBillingWorker(worker, { storageFactory = createRemoteStorage } = {}) {
  return {
    fetch(request, env, context) {
      return worker.fetch(request, storageEnvironment(env, storageFactory), context);
    },
    scheduled(controller, env, context) {
      return worker.scheduled(controller, storageEnvironment(env, storageFactory), context);
    },
  };
}

export function withTosWorkflow(Workflow, { storageFactory = createRemoteStorage } = {}) {
  return class extends Workflow {
    async run(event, step) {
      // Keep the actual Cloudflare Workflow instance, context, event and step.
      // The original implementation reads this.env inside every durable step.
      this.env = storageEnvironment(this.env, storageFactory);
      return super.run(event, step);
    }
  };
}

export class GenerationWorkflow extends withTosWorkflow(ReleasedGenerationWorkflow) {}

export default createTosBillingWorker(released);
