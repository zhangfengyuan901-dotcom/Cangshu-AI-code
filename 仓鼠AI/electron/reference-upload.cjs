'use strict';
const { tosUploadHeaders } = require('../reference-media-upload.cjs');

const maximumBytes = 50 * 1024 * 1024;

function createReferenceUpload(net) {
  return async (url, { headers, body, signal }) => {
    const length = Number(headers['Content-Length']);
    if (!Number.isSafeInteger(length) || length < 12 || length > maximumBytes) throw Error('Invalid reference length');
    signal.throwIfAborted();

    // Chromium sets Content-Length from a complete body. The signed ticket
    // and storage service both require that exact length.
    const bytes = Buffer.isBuffer(body) ? body : Buffer.allocUnsafe(length);
    if (!Buffer.isBuffer(body)) {
      let offset = 0;
      const stopReading = () => body.destroy();
      signal.addEventListener('abort', stopReading, { once:true });
      try {
        for await (const chunk of body) {
          if (offset + chunk.length > length) throw Error('Reference length mismatch');
          offset += chunk.copy(bytes, offset);
        }
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      } finally {
        signal.removeEventListener('abort', stopReading);
      }
      signal.throwIfAborted();
      if (offset !== length) throw Error('Reference length mismatch');
    }
    if (bytes.length !== length) throw Error('Reference length mismatch');

    const outgoingHeaders = headers.Authorization ? { Authorization:headers.Authorization, 'Content-Type':headers['Content-Type'] } : tosUploadHeaders(url,headers);
    // Chromium computes the exact length from the complete body for both paths.
    delete outgoingHeaders['Content-Length'];
    return new Promise((resolve, reject) => {
      const request = net.request({ url, method:'PUT', redirect:'error', credentials:'omit',
        headers:outgoingHeaders });
      const clear = () => signal.removeEventListener('abort', abort);
      const abort = () => { clear(); request.abort(); reject(signal.reason); };
      request.once('error', error => { clear(); reject(error); });
      request.once('response', response => {
        clear();
        response.on('error', () => {});
        response.resume();
        resolve({ ok:response.statusCode >= 200 && response.statusCode < 300, status:response.statusCode });
      });
      signal.addEventListener('abort', abort, { once:true });
      if (signal.aborted) abort();
      else request.end(bytes);
    });
  };
}

module.exports = { createReferenceUpload };
