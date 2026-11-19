import { WorkerEntrypoint } from 'cloudflare:workers';
import { serveDownload } from './download-handler.js';
import { routeWebsiteRequest } from './download-gateway.js';

export class Download extends WorkerEntrypoint {
  fetch(request) {
    return serveDownload(request, this.env);
  }
}

export default {
  fetch(request, env, ctx) {
    return routeWebsiteRequest(request, env, normalized => ctx.exports.Download.fetch(normalized));
  }
};
