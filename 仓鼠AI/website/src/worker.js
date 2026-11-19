import { routeWebsiteRequest } from './download-gateway.js';

export default {
  fetch(request, env) {
    return routeWebsiteRequest(request, env);
  }
};
