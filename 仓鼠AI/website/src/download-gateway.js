import { redirectClientDownload } from './download-handler.js';

export async function routeWebsiteRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/download' || url.pathname.startsWith('/download/')) {
    return redirectClientDownload(request);
  }
  if (url.hostname === 'www.hamsterai.cc') {
    url.hostname = 'hamsterai.cc';
    return Response.redirect(url, 308);
  }
  return env.ASSETS.fetch(request);
}
