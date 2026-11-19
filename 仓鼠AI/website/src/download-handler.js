export const CLIENT_DOWNLOAD_URL = 'https://pan.baidu.com/s/1DKXKc83TxY4YQf563spXdw?pwd=96f8';

export function redirectClientDownload(request) {
  const headers = {
    'Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  }
  return new Response(null, { status: 302, headers: { ...headers, Location: CLIENT_DOWNLOAD_URL } });
}
