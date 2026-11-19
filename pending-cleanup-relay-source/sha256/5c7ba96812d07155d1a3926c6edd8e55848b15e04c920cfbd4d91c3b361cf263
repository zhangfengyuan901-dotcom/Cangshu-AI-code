import { downloadError, enforceDownloadConditions, publishedDownload } from './download-handler.js';

export async function routeWebsiteRequest(request, env, downloadFetch) {
  const url = new URL(request.url);
  if (url.hostname === 'www.hamsterai.cc') {
    url.hostname = 'hamsterai.cc';
    return Response.redirect(url, 308);
  }
  if (!publishedDownload(url.pathname)) {
    return url.pathname.startsWith('/download/')
      ? downloadError(404, 'File not found')
      : env.ASSETS.fetch(request);
  }
  if (!['GET', 'HEAD'].includes(request.method)) return downloadError(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  // The released file is byte-identical for all query parameters. Normalize
  // before the cached entrypoint so tracking parameters cannot fragment it.
  url.search = '';
  url.hash = '';
  const normalized = new Request(url, request);
  return enforceDownloadConditions(normalized, await downloadFetch(normalized));
}
