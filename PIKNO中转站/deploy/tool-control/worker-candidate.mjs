var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/tools-config.mjs
var encoder = new TextEncoder();
var ACTIVE = "tool-config/active";
var versionPattern = /^[a-f0-9]{32}$/;
var keyPattern = /^[a-f0-9]{64}$/;
var encode = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))), "encode");
var decode = /* @__PURE__ */ __name((value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0)), "decode");
async function readConfiguration(env) {
  const object = await env.MEDIA.get(ACTIVE);
  if (!object) return { version: "", updated_at: "", etag: null };
  if (object.size > 2048) throw Error("Invalid tool configuration");
  const value = await object.json();
  if (!versionPattern.test(value.version) || typeof value.updated_at !== "string") throw Error("Invalid tool configuration");
  return { ...value, etag: object.etag };
}
__name(readConfiguration, "readConfiguration");
var rawKey = /* @__PURE__ */ __name((value) => Uint8Array.from(value.match(/../g), (part) => parseInt(part, 16)), "rawKey");
var keyId = /* @__PURE__ */ __name(async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rawKey(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""), "keyId");
async function encryptionKeys(env) {
  const active = env.RH_CONFIG_ENCRYPTION_KEY || "";
  if (!keyPattern.test(active)) throw Error("Tool encryption unavailable");
  let previous = [];
  if (env.RH_CONFIG_ENCRYPTION_PREVIOUS_KEYS) {
    try {
      previous = JSON.parse(env.RH_CONFIG_ENCRYPTION_PREVIOUS_KEYS);
    } catch {
      throw Error("Tool encryption keyring unavailable");
    }
    if (!Array.isArray(previous) || previous.length > 4 || previous.some((value) => !keyPattern.test(value))) throw Error("Tool encryption keyring unavailable");
  }
  const values = [.../* @__PURE__ */ new Set([active, ...previous])], keys = /* @__PURE__ */ new Map();
  for (const value of values) {
    const id = await keyId(value);
    keys.set(id, await crypto.subtle.importKey("raw", rawKey(value), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
  }
  const activeId = await keyId(active);
  return { activeId, activeKey: keys.get(activeId), keys, decryptionKeys: [...keys.values()] };
}
__name(encryptionKeys, "encryptionKeys");
async function toolCredential(env, version) {
  const selected = version === void 0 ? (await readConfiguration(env)).version : version;
  if (selected === "legacy") return { version: "legacy", key: env.RUNNINGHUB_API_KEY || "" };
  if (!selected) return { version: "", key: "" };
  if (!versionPattern.test(selected)) throw Error("Invalid tool credential version");
  const object = await env.MEDIA.get("tool-config/versions/" + selected);
  if (!object || object.size > 2048) throw Error("Tool credential unavailable");
  const value = await object.json(), keyring = await encryptionKeys(env);
  if (value.kek_id && !keyPattern.test(value.kek_id)) throw Error("Tool credential unavailable");
  const candidates = value.kek_id ? [keyring.keys.get(value.kek_id)] : keyring.decryptionKeys;
  if (!candidates[0]) throw Error("Tool credential unavailable");
  let raw;
  for (const candidate of candidates) {
    try {
      raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(value.iv), additionalData: encoder.encode(selected) }, candidate, decode(value.ciphertext));
      break;
    } catch {
    }
  }
  if (!raw) throw Error("Tool credential unavailable");
  const apiKey = new TextDecoder().decode(raw);
  if (!/^[A-Za-z0-9_-]{32}$/.test(apiKey)) throw Error("Tool credential unavailable");
  return { version: selected, key: apiKey };
}
__name(toolCredential, "toolCredential");
async function toolConfiguration(request, env, { sameSecret: sameSecret2, boundedBytes: boundedBytes2, fail: fail2, json: json2 }) {
  if (!env.TOOLS_ADMIN_SECRET || env.TOOLS_ADMIN_SECRET.length < 32 || !env.TOOLS_BRIDGE_SECRET || env.TOOLS_BRIDGE_SECRET.length < 32 || await sameSecret2(env.TOOLS_ADMIN_SECRET, env.TOOLS_BRIDGE_SECRET) || !env.RH_CONFIG_ENCRYPTION_KEY) throw fail2(503, "Tool configuration unavailable");
  const auth = request.headers.get("authorization") || "";
  if (auth.length > 512 || !await sameSecret2(auth, "Bearer " + env.TOOLS_ADMIN_SECRET)) throw fail2(401, "Tool configuration authorization required");
  const url = new URL(request.url), check = url.pathname === "/media/v1/tools/config/check";
  if (url.search || !["/media/v1/tools/config", "/media/v1/tools/config/check"].includes(url.pathname)) throw fail2(404, "Tool configuration operation unavailable");
  if (check ? request.method !== "POST" : !["GET", "POST"].includes(request.method)) throw fail2(405, "Tool configuration operation unavailable");
  const current = await readConfiguration(env);
  const view = /* @__PURE__ */ __name((version2) => ({ configured: Boolean(version2), enabled: env.TOOLS_ENABLED === "true", ready: Boolean(version2) && env.TOOLS_ENABLED === "true", version: version2, updated_at: current.updated_at, storage: "cloud-encrypted" }), "view");
  if (request.method === "GET") {
    const credential = await toolCredential(env, current.version);
    return json2({ ...view(current.version), configured: Boolean(credential.key), ready: Boolean(credential.key) && env.TOOLS_ENABLED === "true" });
  }
  let apiKey, expectedVersion;
  if (check) {
    if (request.body && Number(request.headers.get("Content-Length") || 0) > 0) throw fail2(400, "Invalid tool configuration request");
    apiKey = (await toolCredential(env, current.version)).key;
    if (!apiKey) throw fail2(409, "Tool credential not configured");
  } else {
    const bytes = await boundedBytes2(request.body, 1024);
    let input;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw fail2(400, "Invalid tool configuration request");
    }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "api_key,expected_version" || !/^[A-Za-z0-9_-]{32}$/.test(input.api_key || "") || typeof input.expected_version !== "string") throw fail2(400, "Invalid tool configuration request");
    apiKey = input.api_key;
    expectedVersion = input.expected_version;
    if (expectedVersion !== current.version) throw fail2(409, "Tool configuration changed; refresh before saving");
  }
  let response, data;
  try {
    response = await fetch("https://www.runninghub.cn/uc/openapi/accountStatus", { method: "POST", headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ apikey: apiKey }), redirect: "manual", signal: AbortSignal.timeout(1e4) });
    data = JSON.parse(new TextDecoder().decode(await boundedBytes2(response.body, 16384)));
  } catch {
    throw fail2(502, "Tool authorization check unavailable; configuration unchanged");
  }
  if (!response.ok || data.code !== 0 || !data.data || typeof data.data !== "object") throw fail2(422, "Tool credential authorization check failed; configuration unchanged");
  if (check) return json2({ ...view(current.version), authorization_valid: true });
  const version = crypto.randomUUID().replaceAll("-", ""), iv = crypto.getRandomValues(new Uint8Array(12)), keyring = await encryptionKeys(env);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(version) }, keyring.activeKey, encoder.encode(apiKey));
  const versionKey = "tool-config/versions/" + version;
  await env.MEDIA.put(versionKey, JSON.stringify({ kek_id: keyring.activeId, iv: encode(iv), ciphertext: encode(ciphertext) }), { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } });
  const updated_at = (/* @__PURE__ */ new Date()).toISOString();
  const saved = await env.MEDIA.put(ACTIVE, JSON.stringify({ version, updated_at }), { onlyIf: current.etag ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } });
  if (!saved) {
    await env.MEDIA.delete(versionKey);
    throw fail2(409, "Tool configuration changed; refresh before saving");
  }
  return json2({ ...view(version), updated_at, authorization_valid: true });
}
__name(toolConfiguration, "toolConfiguration");

// src/tools.mjs
var RH = "https://www.runninghub.cn/openapi/v2";
var WORKFLOWS = { digital: "2087890031699648513", depth: "2089021172049596418" };
var OUTPUT_HOSTS = /* @__PURE__ */ new Set(["rh-images-1252422369.cos.ap-beijing.myqcloud.com", "rh-comfyui01.tos-cn-beijing.volces.com"]);
var encoder2 = new TextEncoder();
var sameSecret = /* @__PURE__ */ __name(async (a, b) => {
  const hashes = await Promise.all([a, b].map((value) => crypto.subtle.digest("SHA-256", encoder2.encode(value))));
  const x = new Uint8Array(hashes[0]), y = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}, "sameSecret");
var sha = /* @__PURE__ */ __name(async (data) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (byte) => byte.toString(16).padStart(2, "0")).join(""), "sha");
async function tools(request, env, { signClaims: signClaims2, boundedBytes: boundedBytes2, fail: fail2, json: json2 }) {
  if (new URL(request.url).pathname.startsWith("/media/v1/tools/config")) return toolConfiguration(request, env, { sameSecret, boundedBytes: boundedBytes2, fail: fail2, json: json2 });
  if (!env.TOOLS_BRIDGE_SECRET || env.TOOLS_BRIDGE_SECRET.length < 32 || !env.TOOLS_ADMIN_SECRET || env.TOOLS_ADMIN_SECRET.length < 32 || await sameSecret(env.TOOLS_ADMIN_SECRET, env.TOOLS_BRIDGE_SECRET)) throw fail2(503, "Tool service unavailable");
  const auth = request.headers.get("authorization") || "";
  if (auth.length > 512 || !await sameSecret(auth, "Bearer " + env.TOOLS_BRIDGE_SECRET)) throw fail2(401, "Tool execution authorization required");
  const statusUrl = new URL(request.url);
  if (statusUrl.pathname === "/media/v1/tools/status") {
    if (request.method !== "GET" || statusUrl.search) throw fail2(405, "Tool operation unavailable");
    const enabled = env.TOOLS_ENABLED === "true", credential_configured = Boolean((await toolCredential(env)).key);
    const ready = enabled && credential_configured;
    return json2({ enabled, credential_configured, ready, tools: { digital: { available: ready, max_audio_seconds: 30 }, depth: { available: ready } } });
  }
  const url = new URL(request.url), match = /^\/media\/v1\/tools(?:\/([A-Za-z0-9_-]{1,200})(\/content)?)?$/.exec(url.pathname);
  if (!match || url.search) throw fail2(404, "Tool operation unavailable");
  const write = /* @__PURE__ */ __name(async (key2, value) => env.MEDIA.put(key2, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } }), "write");
  const read = /* @__PURE__ */ __name(async (key2) => {
    const object = await env.MEDIA.get(key2);
    return object ? JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) : null;
  }, "read");
  const acquirePoll = /* @__PURE__ */ __name(async (id) => {
    const key2 = "tool-polls/" + id, now = Math.floor(Date.now() / 1e3), current = await env.MEDIA.head(key2);
    if (current && Number(current.customMetadata?.expires) > now) return null;
    const lease = crypto.randomUUID(), saved = await env.MEDIA.put(key2, "polling", { onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" }, customMetadata: { lease, expires: String(now + 600) } });
    return saved ? { key: key2, lease } : null;
  }, "acquirePoll");
  const releasePoll = /* @__PURE__ */ __name(async (lease) => {
    try {
      const current = await env.MEDIA.head(lease.key);
      if (current?.customMetadata?.lease === lease.lease) await env.MEDIA.delete(lease.key);
    } catch {
    }
  }, "releasePoll");
  let credential;
  const rh = /* @__PURE__ */ __name(async (path, options) => {
    if (!credential?.key) throw fail2(503, "Tool credential unavailable");
    const response = await fetch(RH + path, { ...options, headers: { ...options.headers, Authorization: "Bearer " + credential.key }, redirect: "manual", signal: AbortSignal.timeout(18e4) });
    const bytes2 = await boundedBytes2(response.body, 65536);
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes2));
    } catch {
      throw fail2(502, "Tool response uncertain");
    }
    if (!response.ok) {
      const error = fail2(502, "Tool response uncertain");
      error.definitiveRejection = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw error;
    }
    return data;
  }, "rh");
  async function upload(asset) {
    if (asset.filename) return asset.filename;
    const reader = asset.body.getReader(), first = [];
    let received = 0, signatureSize = 0;
    const signature = new Uint8Array(Math.min(16, asset.size));
    try {
      while (signatureSize < signature.length) {
        const part = await reader.read();
        if (part.done) throw fail2(415, "Reference signature mismatch");
        received += part.value.length;
        if (received > asset.size) throw fail2(413, "Reference size mismatch");
        first.push(part.value);
        const count = Math.min(part.value.length, signature.length - signatureSize);
        signature.set(part.value.subarray(0, count), signatureSize);
        signatureSize += count;
      }
      if (!matchesType(signature, asset.mime)) throw fail2(415, "Reference signature mismatch");
    } catch (error) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      throw error;
    }
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/aac": "aac" }[asset.mime];
    const boundary = "pikno-tool-" + crypto.randomUUID().replaceAll("-", "");
    const start = encoder2.encode(`--${boundary}\r
Content-Disposition: form-data; name="file"; filename="reference.${ext}"\r
Content-Type: ${asset.mime}\r
\r
`), end = encoder2.encode(`\r
--${boundary}--\r
`);
    const stream = new FixedLengthStream(start.length + asset.size + end.length), writer = stream.writable.getWriter();
    let uploadFailure;
    const pumping = (async () => {
      try {
        await writer.write(start);
        try {
          for (const part of first) await writer.write(part);
          for (; ; ) {
            const part = await reader.read();
            if (part.done) break;
            received += part.value.length;
            if (received > asset.size) throw fail2(413, "Reference size mismatch");
            await writer.write(part.value);
          }
          if (received !== asset.size) throw fail2(413, "Reference size mismatch");
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        await writer.write(end);
        await writer.close();
      } catch (error) {
        uploadFailure = error;
        await writer.abort(error).catch(() => {});
      }
    })();
    let result;
    try {
      result = await rh("/media/upload/binary", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + boundary }, body: stream.readable, duplex: "half" });
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    }
    await pumping;
    if (uploadFailure) throw uploadFailure;
    const file = result.data?.fileName || result.data?.filename || result.data?.download_url;
    if (![0, 200].includes(result.code) || typeof file !== "string" || !file || file.length > 512 || /[\r\n]/.test(file)) throw fail2(502, "Tool reference upload failed");
    return file;
  }
  __name(upload, "upload");
  if (url.pathname === "/media/v1/tools/uploads") {
    const user = request.headers.get("X-Pikno-User"), mime = request.headers.get("Content-Type"), sizeText = request.headers.get("Content-Length");
    const uid = Number(user), size = Number(sizeText);
    if (request.method !== "POST" || url.search || request.headers.has("Content-Encoding") || !/^[1-9]\d{0,15}$/.test(user || "") || !Number.isSafeInteger(uid) || !Object.hasOwn(MIME, mime) || !/^\d+$/.test(sizeText || "") || !Number.isSafeInteger(size) || size < 12 || size > MIME[mime] || !request.body) throw fail2(400, "Invalid direct tool upload");
    credential = await toolCredential(env);
    if (env.TOOLS_ENABLED !== "true" || !credential.key) throw fail2(503, "Tool service unavailable");
    const filename = await upload({ mime, size, body: request.body });
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,511}$/.test(filename) || filename.split("/").some((part) => !part || part === "." || part === "..")) throw fail2(502, "Tool filename rejected");
    const id = crypto.randomUUID().replaceAll("-", ""), now = Math.floor(Date.now() / 1000), expires_at = now + 7200;
    const signed = await signClaims2({ v: 1, aud: "pikno-tool-input", uid, id, mime, size, iat: now, exp: expires_at, filename, credential_version: credential.version }, env.TICKET_KEY);
    const location = "https://www.piknoai.com/media/v1/tool-inputs/" + id + "?ticket=" + signed;
    return json2({ file: { url: location, expires_at }, url: location, expires_at });
  }
  const outputUrl = /* @__PURE__ */ __name(async (job2) => {
    if (job2.direct_media && job2.output?.url) return job2.output.url;
    const p = job2.output, now = Math.floor(Date.now() / 1e3), meta = await env.MEDIA.head(p.key);
    if (!meta || meta.size !== p.size || meta.customMetadata?.uid !== String(job2.uid) || Number(meta.customMetadata?.expires) <= now) throw fail2(404, "Tool result expired");
    const signed = await signClaims2({ v: 1, aud: "pikno-relay-media", uid: job2.uid, id: p.id, op: "read", iat: now, exp: now + 7200, mime: "video/mp4", size: p.size }, env.TICKET_KEY);
    return "https://www.piknoai.com/media/v1/assets/" + p.id + "?ticket=" + signed;
  }, "outputUrl");
  const present = /* @__PURE__ */ __name(async (job2) => ({ id: job2.id, status: job2.status, outputs: job2.status === "completed" ? [{ type: "video", url: await outputUrl(job2) }] : [] }), "present");
  if (match[2]) {
    if (!["GET", "HEAD"].includes(request.method)) throw fail2(405, "Tool result operation unavailable");
    const job2 = await read("tool-jobs/" + match[1]), p = job2?.output;
    if (job2?.status !== "completed" || !p) throw fail2(404, "Tool result unavailable");
    if (job2.direct_media) {
      const remote = new URL(p.url);
      if (remote.protocol !== "https:" || remote.username || remote.password || remote.port || remote.hash || !OUTPUT_HOSTS.has(remote.hostname)) throw fail2(502, "Tool result URL rejected");
      const requestedRange = request.headers.get("Range"), requested = requestedRange === null ? null : /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
      if (requestedRange !== null && (!requested || !requested[1] && !requested[2] || [requested[1], requested[2]].some((part) => part && !Number.isSafeInteger(Number(part))))) throw fail2(400, "Tool result range rejected");
      const response = await fetch(remote.href, { method: request.method, headers: requestedRange === null ? {} : { Range: requestedRange }, redirect: "manual", signal: AbortSignal.timeout(180000) });
      const maximum = 50 << 20, declared = response.headers.get("Content-Length"), length = declared === null ? null : Number(declared);
      const contentRange = response.headers.get("Content-Range"), partial = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || ""), unsatisfied = /^bytes \*\/(\d+)$/.exec(contentRange || "");
      let expected = length;
      const invalidLength = declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(length) || length < 0 || length > maximum);
      let validRange = response.status === 200 ? contentRange === null : false;
      if (response.status === 206 && requested && partial) {
        const start = Number(partial[1]), end = Number(partial[2]), total = Number(partial[3]);
        const requestedStart = requested[1] ? Number(requested[1]) : Math.max(0, total - Number(requested[2]));
        const requestedEnd = requested[1] && requested[2] ? Math.min(Number(requested[2]), total - 1) : total - 1;
        expected = end - start + 1;
        validRange = [start, end, total, expected].every(Number.isSafeInteger) && total > 0 && total <= maximum && start >= 0 && end < total && expected > 0 && start === requestedStart && end === requestedEnd && (length === null || length === expected);
      }
      if (response.status === 416 && requested && unsatisfied) {
        const total = Number(unsatisfied[1]);
        validRange = Number.isSafeInteger(total) && total >= 0 && total <= maximum;
      }
      if (![200, 206, 416].includes(response.status) || invalidLength || !validRange) { await response.body?.cancel(); throw fail2(502, "Tool result unavailable"); }
      const headers = { "Content-Type": "video/mp4", "Cache-Control": "private, no-store", "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes" };
      if (length !== null) headers["Content-Length"] = String(length);
      if (contentRange !== null) headers["Content-Range"] = contentRange;
      if (response.status === 416) {
        await response.body?.cancel();
        headers["Content-Length"] = "0";
        return new Response(null, { status: 416, headers });
      }
      if (request.method === "HEAD") { await response.body?.cancel(); return new Response(null, { status: response.status, headers }); }
      if (!response.body) throw fail2(502, "Tool result unavailable");
      const reader = response.body.getReader();
      let received = 0;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) {
              if (expected !== null && received !== expected) throw Error("Tool result length mismatch");
              reader.releaseLock();
              controller.close();
              return;
            }
            received += part.value.byteLength;
            if (received > maximum || expected !== null && received > expected) throw Error("Tool result length mismatch");
            controller.enqueue(part.value);
          } catch {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
            controller.error(Error("Tool result transfer interrupted"));
          }
        },
        async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
      });
      return new Response(body, { status: response.status, headers });
    }
    const direct = request.method === "GET" && !request.headers.has("Range");
    let object = direct ? await env.MEDIA.get(p.key) : null;
    const meta = direct ? object : await env.MEDIA.head(p.key);
    if (!meta || meta.size !== p.size || meta.customMetadata?.uid !== String(job2.uid) || meta.httpMetadata?.contentType !== "video/mp4" || Number(meta.customMetadata?.expires) <= Date.now() / 1e3) {
      try {
        await object?.body?.cancel();
      } catch {
      }
      throw fail2(404, "Tool result expired");
    }
    const headers = { "Content-Type": "video/mp4", "Content-Length": String(meta.size), "Cache-Control": "private, no-store", "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes" };
    let range, status = 200;
    if (request.method === "GET" && request.headers.has("Range")) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range"));
      const invalid = /* @__PURE__ */ __name(() => new Response(null, { status: 416, headers: { ...headers, "Content-Length": "0", "Content-Range": `bytes */${meta.size}` } }), "invalid");
      if (!m || !m[1] && !m[2]) return invalid();
      const start = m[1] ? Number(m[1]) : Math.max(0, meta.size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), meta.size - 1) : meta.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= meta.size || end < start || !m[1] && Number(m[2]) === 0) return invalid();
      range = { offset: start, length: end - start + 1 };
      status = 206;
      headers["Content-Length"] = String(range.length);
      headers["Content-Range"] = `bytes ${start}-${end}/${meta.size}`;
    }
    if (request.method === "GET" && !object) object = await env.MEDIA.get(p.key, range ? { range } : void 0);
    if (request.method === "GET" && !object) throw fail2(404, "Tool result missing");
    return new Response(object?.body || null, { status, headers });
  }
  if (request.method === "GET" && match[1]) {
    const key2 = "tool-jobs/" + match[1], job2 = await read(key2);
    if (!job2) return json2({ id: match[1], status: "unknown", outputs: [] });
    if (job2.status === "completed") {
      try {
        return json2(await present(job2));
      } catch {
        return json2({ id: job2.id, status: "unknown", outputs: [] });
      }
    }
    if (job2.status === "failed" || !job2.provider_task_id) return json2(await present(job2));
    const lease = await acquirePoll(job2.id);
    if (!lease) return json2({ id: job2.id, status: "processing", outputs: [] });
    let stage = "credential";
    const diagnostic = {};
    const uncertain = /* @__PURE__ */ __name(async (code) => {
      try {
        job2.poll_diagnostic = { code, stage, ...diagnostic };
        await write(key2, job2);
      } catch {
      }
      return json2({ id: job2.id, status: "unknown", outputs: [] });
    }, "uncertain");
    try {
      credential = await toolCredential(env, job2.credential_version || "legacy");
      stage = "query";
      const result = await rh("/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId: job2.provider_task_id }) });
      const data = result.data && typeof result.data === "object" ? result.data : result, status = String(data.status || "").toUpperCase();
      diagnostic.provider_status = ["SUCCESS", "FAILED", "FAILURE", "CANCEL", "CREATE", "RUNNING", "QUEUED", "PENDING"].includes(status) ? status : "UNRECOGNIZED";
      if (["FAILED", "FAILURE", "CANCEL"].includes(status)) {
        job2.status = "failed";
        await write(key2, job2);
        return json2(await present(job2));
      }
      if (["CREATE", "RUNNING", "QUEUED", "PENDING"].includes(status)) return json2({ id: job2.id, status: "processing", outputs: [] });
      if (status !== "SUCCESS") return await uncertain("PROVIDER_STATUS_UNRECOGNIZED");
      stage = "output";
      const outputs = data.results || result.results, output = Array.isArray(outputs) ? outputs.find((item) => ["video", "mp4", "video/mp4"].includes(String(item.outputType || "").toLowerCase())) : null;
      diagnostic.output_count = Array.isArray(outputs) ? Math.min(outputs.length, 1e4) : 0;
      diagnostic.video_output = Boolean(output);
      diagnostic.output_url = typeof output?.url === "string";
      if (!output || typeof output.url !== "string") return await uncertain("OUTPUT_UNRECOGNIZED");
      stage = "output_url";
      const remote = new URL(output.url), host = remote.hostname.toLowerCase().replace(/\.$/, "");
      diagnostic.output_host_allowed = OUTPUT_HOSTS.has(host);
      if (remote.protocol !== "https:" || remote.username || remote.password || remote.port && remote.port !== "443" || !OUTPUT_HOSTS.has(host)) return await uncertain("OUTPUT_URL_REJECTED");
      if (job2.direct_media) {
        delete job2.poll_diagnostic;
        job2.output = { url: remote.href };
        job2.status = "completed";
        await write(key2, job2);
        return json2(await present(job2));
      }
      stage = "download";
      const response = await fetch(remote.href, { redirect: "manual", signal: AbortSignal.timeout(18e4) });
      diagnostic.download_status = response.status;
      const declaredLength = Number(response.headers.get("Content-Length"));
      if (Number.isSafeInteger(declaredLength) && declaredLength >= 0) diagnostic.declared_bytes = declaredLength;
      if (!response.ok || declaredLength > 50 << 20) return await uncertain(!response.ok ? "DOWNLOAD_HTTP_REJECTED" : "OUTPUT_TOO_LARGE");
      stage = "download_body";
      const bytes2 = await boundedBytes2(response.body, 50 << 20);
      diagnostic.received_bytes = bytes2.length;
      if (bytes2.length < 12 || new TextDecoder().decode(bytes2.slice(4, 8)) !== "ftyp") return await uncertain("OUTPUT_FORMAT_REJECTED");
      stage = "store";
      const id = (await sha(encoder2.encode("tool-output:" + job2.id))).slice(0, 32), objectKey = `input/${job2.uid}/${id}`, created = Math.floor(Date.now() / 1e3);
      const stored = await env.MEDIA.put(objectKey, bytes2, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "video/mp4" }, customMetadata: { uid: String(job2.uid), expires: String(created + 86400) } });
      if (!stored) {
        const existing = await env.MEDIA.head(objectKey);
        if (!existing || existing.size !== bytes2.length || existing.httpMetadata?.contentType !== "video/mp4" || existing.customMetadata?.uid !== String(job2.uid)) return await uncertain("OUTPUT_STORE_CONFLICT");
      }
      delete job2.poll_diagnostic;
      job2.output = { id, key: objectKey, size: bytes2.length };
      job2.status = "completed";
      await write(key2, job2);
      stage = "present";
      return json2(await present(job2));
    } catch {
      return await uncertain("POLL_EXCEPTION");
    } finally {
      await releasePoll(lease);
    }
  }
  if (request.method !== "POST" || match[1]) throw fail2(405, "Tool operation unavailable");
  credential = await toolCredential(env);
  if (env.TOOLS_ENABLED !== "true" || !credential.key) throw fail2(503, "Tool service unavailable");
  const bytes = await boundedBytes2(request.body, 65536);
  let input;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw fail2(400, "Invalid tool request");
  }
  if (!input || Object.keys(input).some((key2) => !["kind", "images", "videos", "audios", "request_id"].includes(key2)) || !Object.hasOwn(WORKFLOWS, input.kind) || !/^task_[A-Za-z0-9_-]{1,190}$/.test(input.request_id || "")) throw fail2(400, "Invalid tool request");
  const images = input.images || [], videos = input.videos || [], audios = input.audios || [];
  if (![images, videos, audios].every(Array.isArray) || (input.kind === "digital" ? images.length !== 1 || videos.length !== 0 || audios.length !== 1 : videos.length !== 1 || images.length !== 0 || audios.length !== 0)) throw fail2(400, "Tool reference count invalid");
  if (input.kind === "digital" && (!Number.isFinite(audios[0]?.durationSeconds) || audios[0].durationSeconds <= 0 || audios[0].durationSeconds > 30)) throw fail2(400, "Tool audio duration invalid");
  const assets = [];
  let uid;
  for (const [kind, refs] of [["image", images], ["video", videos], ["audio", audios]]) for (const ref of refs) {
    if (typeof ref?.url !== "string") throw fail2(400, "Tool reference invalid");
    const remote = new URL(ref.url), directMatch = /^\/media\/v1\/tool-inputs\/([a-f0-9]{32})$/.exec(remote.pathname);
    if (directMatch) {
      const claims = await directToolInput(remote, env, directMatch[1]);
      uid ??= claims.uid;
      if (claims.uid !== uid || !claims.mime.startsWith(kind + "/")) throw fail2(403, "Tool reference scope invalid");
      assets.push({ ...claims, kind });
      continue;
    }
    throw fail2(403, "Upload tool inputs directly before creating a new task");
  }
  const selectedVersion = assets[0].credential_version;
  if (assets.some((asset) => asset.credential_version !== selectedVersion)) throw fail2(409, "Tool reference credentials changed");
  credential = await toolCredential(env, selectedVersion);
  if (!credential.key) throw fail2(503, "Tool credential unavailable");
  const key = "tool-jobs/" + input.request_id, hash = await sha(bytes), job = { id: input.request_id, uid, kind: input.kind, hash, status: "preparing", credential_version: credential.version, direct_media: true, created_at: Math.floor(Date.now() / 1e3) };
  const claimed = await env.MEDIA.put(key, JSON.stringify(job), { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } });
  if (!claimed) {
    const previous = await read(key);
    if (!previous || previous.hash !== hash) throw fail2(409, "Tool request identity conflict");
    try {
      return json2({ ...await present(previous), status: previous.status === "preparing" ? "unknown" : previous.status });
    } catch {
      return json2({ id: previous.id, status: "unknown", outputs: [] });
    }
  }
  let dispatched = false;
  try {
    const nodeInfoList = [];
    for (const asset of assets) {
      const file = await upload(asset);
      nodeInfoList.push({ nodeId: input.kind === "depth" ? "183" : asset.kind === "image" ? "133" : "125", fieldName: asset.kind, fieldValue: file });
    }
    job.status = "unknown";
    await write(key, job);
    dispatched = true;
    const result = await rh("/run/ai-app/" + WORKFLOWS[input.kind], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nodeInfoList, instanceType: "default", usePersonalQueue: false }) });
    const id = result.taskId || result.data?.taskId || result.task_id || result.data?.task_id;
    if (typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id)) job.provider_task_id = id;
    if (["FAILED", "FAILURE", "CANCEL"].includes(String(result.status || result.data?.status || "").toUpperCase())) job.status = "failed";
    else if (job.provider_task_id) job.status = "queued";
    await write(key, job);
  } catch (error) {
    job.status = dispatched && !error.definitiveRejection ? "unknown" : "failed";
    await write(key, job);
  }
  return json2(await present(job));
}
__name(tools, "tools");
async function directToolInput(remote, env, id) {
  if (remote.origin !== "https://www.piknoai.com" || remote.username || remote.password || remote.hash || remote.searchParams.size !== 1 || remote.searchParams.getAll("ticket").length !== 1) throw fail(403, "Tool reference invalid");
  const raw = remote.searchParams.get("ticket");
  if (!raw || raw.length > 2048 || !env.TICKET_KEY || env.TICKET_KEY.length < 32) throw fail(403, "Tool reference invalid");
  const parts = raw.split(".");
  if (parts.length !== 2) throw fail(403, "Tool reference invalid");
  const key = await crypto.subtle.importKey("raw", encoder3.encode(env.TICKET_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, decode2(parts[1]), encoder3.encode(parts[0]))) throw fail(403, "Tool reference invalid");
  let p;
  try { p = JSON.parse(new TextDecoder().decode(decode2(parts[0]))); } catch { throw fail(403, "Tool reference invalid"); }
  const now = Math.floor(Date.now() / 1000);
  if (p.v !== 1 || p.aud !== "pikno-tool-input" || p.id !== id || !Number.isSafeInteger(p.uid) || p.uid < 1 || !Number.isSafeInteger(p.iat) || p.iat > now + 30 || !Number.isSafeInteger(p.exp) || p.exp <= now || p.exp <= p.iat || p.exp - p.iat > 7200 || !Object.hasOwn(MIME, p.mime) || !Number.isSafeInteger(p.size) || p.size < 12 || p.size > MIME[p.mime] || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,511}$/.test(p.filename || "") || p.filename.split("/").some((part) => !part || part === "." || part === "..") || !/^(?:legacy|[a-f0-9]{32})$/.test(p.credential_version || "")) throw fail(403, "Tool reference scope invalid");
  return p;
}

// src/worker.mjs
var MIME = {
  "image/png": 30 << 20,
  "image/jpeg": 30 << 20,
  "image/webp": 30 << 20,
  "video/mp4": 50 << 20,
  "video/webm": 50 << 20,
  "video/quicktime": 50 << 20,
  "audio/mpeg": 50 << 20,
  "audio/wav": 50 << 20,
  "audio/mp4": 50 << 20,
  "audio/aac": 50 << 20
};
var encoder3 = new TextEncoder();
var json = /* @__PURE__ */ __name((body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }), "json");
var fail = /* @__PURE__ */ __name((status, message) => Object.assign(new Error(message), { status }), "fail");
function decode2(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw fail(401, "Invalid ticket");
  try {
    return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  } catch {
    throw fail(401, "Invalid ticket");
  }
}
__name(decode2, "decode");
async function ticket(request, env, id, operation) {
  if (!env.TICKET_KEY || env.TICKET_KEY.length < 32) throw fail(503, "Media service unavailable");
  const raw = operation === "read" ? new URL(request.url).searchParams.get("ticket") : request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!raw || raw.length > 2048) throw fail(401, "Ticket required");
  const parts = raw.split(".");
  if (parts.length !== 2) throw fail(401, "Invalid ticket");
  const key = await crypto.subtle.importKey("raw", encoder3.encode(env.TICKET_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, decode2(parts[1]), encoder3.encode(parts[0]))) throw fail(401, "Invalid ticket");
  let p;
  try {
    p = JSON.parse(new TextDecoder().decode(decode2(parts[0])));
  } catch {
    throw fail(401, "Invalid ticket");
  }
  const now = Math.floor(Date.now() / 1e3);
  if (p.v !== 1 || p.aud !== "pikno-relay-media" || p.op !== operation || p.id !== id || !Number.isSafeInteger(p.uid) || p.uid < 1 || !Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat) || p.iat > now + 30 || p.exp <= now || p.exp <= p.iat || p.exp - p.iat > (operation === "read" ? 7200 : 600) || !Object.hasOwn(MIME, p.mime) || !Number.isSafeInteger(p.size) || p.size < 12 || p.size > MIME[p.mime]) throw fail(403, "Ticket scope rejected");
  return p;
}
__name(ticket, "ticket");
function matchesType(bytes, mime) {
  const hex = [...bytes.slice(0, 12)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const ascii = new TextDecoder().decode(bytes);
  if (mime === "image/png") return hex.startsWith("89504e470d0a1a0a");
  if (mime === "image/jpeg") return hex.startsWith("ffd8ff");
  if (mime === "image/webp") return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
  if (["video/mp4", "video/quicktime", "audio/mp4"].includes(mime)) return ascii.slice(4, 8) === "ftyp";
  if (mime === "video/webm") return hex.startsWith("1a45dfa3");
  if (mime === "audio/aac") return bytes[0] === 255 && (bytes[1] & 246) === 240;
  if (mime === "audio/wav") return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE";
  return ascii.startsWith("ID3") || bytes[0] === 255 && (bytes[1] & 224) === 224;
}
__name(matchesType, "matchesType");
async function inspect(env, key, p) {
  const object = await env.MEDIA.get(key, { range: { offset: 0, length: 16 } });
  if (!object) throw fail(404, "Asset not found");
  if (object.size !== p.size || object.httpMetadata?.contentType !== p.mime || object.customMetadata?.uid !== String(p.uid)) throw fail(409, "Asset metadata mismatch");
  if (!matchesType(new Uint8Array(await object.arrayBuffer()), p.mime)) throw fail(415, "File signature mismatch");
  return object;
}
__name(inspect, "inspect");
var worker_default = {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const allowedOrigin = "https://www.piknoai.com";
    if (origin && origin !== allowedOrigin) return json({ error: "Origin rejected" }, 403);
    const url = new URL(request.url);
    if (url.pathname === "/media/v1/tools" || url.pathname.startsWith("/media/v1/tools/")) {
      try {
        return await tools(request, env, { ticket, inspect, signClaims, boundedBytes, fail, json });
      } catch (error) {
        return json({ error: error.status ? error.message : "Tool response uncertain; inspect task history before retrying" }, error.status || 502);
      }
    }
    if (url.pathname === "/media/v1/packy") {
      try {
        return await packy(request, env);
      } catch (error) {
        return json({ error: { message: error.status ? error.message : "Image edge failed; inspect request history before retrying", type: "image_edge_error" } }, error.status || 502);
      }
    }
    const match = /^\/media\/v1\/assets\/([a-f0-9]{32})(\/inspect)?$/.exec(url.pathname);
    if (!match) return json({ error: "Not found" }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "PUT, GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin"
    } });
    let response;
    try {
      const operation = match[2] && request.method === "POST" ? "inspect" : !match[2] && request.method === "PUT" ? "upload" : !match[2] && ["GET", "HEAD"].includes(request.method) ? "read" : null;
      if (!operation) throw fail(405, "Method not allowed");
      const p = await ticket(request, env, match[1], operation);
      const key = `input/${p.uid}/${p.id}`;
      if (operation === "upload") {
        if (!env.UPLOAD_LIMITER || !(await env.UPLOAD_LIMITER.limit({ key: String(p.uid) })).success) throw fail(429, "Upload rate limit exceeded");
        if (request.headers.get("content-type") !== p.mime || Number(request.headers.get("content-length")) !== p.size || request.headers.has("content-encoding") || !request.body) throw fail(400, "Upload headers mismatch");
        const object = await env.MEDIA.put(key, request.body, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: p.mime },
          customMetadata: { uid: String(p.uid), expires: String(p.iat + 86400) }
        });
        if (!object) throw fail(409, "Asset already uploaded; inspect instead");
        try {
          await inspect(env, key, p);
        } catch (error) {
          await env.MEDIA.delete(key);
          throw error;
        }
        response = json({ id: p.id, size: p.size, content_type: p.mime, status: "uploaded" }, 201);
      } else if (operation === "inspect") {
        await inspect(env, key, p);
        response = json({ id: p.id, owner_id: p.uid, size: p.size, content_type: p.mime, status: "ready" });
      } else {
        const meta = await env.MEDIA.head(key);
        if (!meta || Number(meta.customMetadata?.expires) <= Date.now() / 1e3) throw fail(404, "Asset expired or missing");
        if (meta.size !== p.size || meta.httpMetadata?.contentType !== p.mime || meta.customMetadata?.uid !== String(p.uid)) throw fail(403, "Asset scope mismatch");
        const headers = {
          "Content-Type": p.mime,
          "Content-Length": String(meta.size),
          "Cache-Control": "private, no-store",
          "Content-Disposition": "attachment",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer"
        };
        let range, status = 200;
        headers["Accept-Ranges"] = "bytes";
        if (request.method === "GET" && request.headers.has("range")) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range"));
          if (!m || !m[1] && !m[2]) return new Response(null, { status: 416, headers: { ...headers, "Content-Length": "0", "Content-Range": `bytes */${meta.size}` } });
          const start = m[1] ? Number(m[1]) : Math.max(0, meta.size - Number(m[2]));
          const end = m[1] && m[2] ? Math.min(Number(m[2]), meta.size - 1) : meta.size - 1;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= meta.size || end < start || !m[1] && Number(m[2]) === 0) return new Response(null, { status: 416, headers: { ...headers, "Content-Length": "0", "Content-Range": `bytes */${meta.size}` } });
          range = { offset: start, length: end - start + 1 };
          status = 206;
          headers["Content-Length"] = String(range.length);
          headers["Content-Range"] = `bytes ${start}-${end}/${meta.size}`;
        }
        const object = request.method === "HEAD" ? null : await env.MEDIA.get(key, range ? { range } : void 0);
        if (request.method === "GET" && !object) throw fail(404, "Asset missing");
        response = new Response(object?.body || null, { headers, status });
      }
    } catch (error) {
      response = json({ error: error.status ? error.message : "Media service error" }, error.status || 500);
    }
    if (origin) {
      response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
      response.headers.set("Vary", "Origin");
    }
    return response;
  }
};
async function signClaims(claims, secret) {
  const payload = btoa(String.fromCharCode(...encoder3.encode(JSON.stringify(claims)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const key = await crypto.subtle.importKey("raw", encoder3.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder3.encode(payload))))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return payload + "." + signature;
}
__name(signClaims, "signClaims");
async function boundedBytes(body, max) {
  if (!body) throw fail(400, "Body required");
  const reader = body.getReader(), chunks = [];
  let size = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw fail(413, "Body too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}
__name(boundedBytes, "boundedBytes");
async function packy(request, env) {
  if (request.method !== "POST") throw fail(405, "Method not allowed");
  if (!env.TICKET_KEY || env.TICKET_KEY.length < 32) throw fail(503, "Media service unavailable");
  const raw = request.headers.get("X-Pikno-Edge-Ticket");
  if (!raw || raw.length > 2048) throw fail(401, "Gateway authorization required");
  const parts = raw.split(".");
  if (parts.length !== 2) throw fail(401, "Invalid gateway ticket");
  const key = await crypto.subtle.importKey("raw", encoder3.encode(env.TICKET_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, decode2(parts[1]), encoder3.encode(parts[0]))) throw fail(401, "Invalid gateway ticket");
  const p = JSON.parse(new TextDecoder().decode(decode2(parts[0]))), now = Math.floor(Date.now() / 1e3);
  if (p.v !== 1 || p.aud !== "pikno-packy-edge" || !Number.isSafeInteger(p.uid) || p.uid < 1 || !/^[a-f0-9]{32}$/.test(p.id) || !Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat) || p.iat > now + 30 || p.exp <= now || p.exp <= p.iat || p.exp - p.iat > 60 || !["/v1/images/edits", "/v1/images/generations"].includes(p.path)) throw fail(403, "Gateway ticket scope rejected");
  const bytes = await boundedBytes(request.body, 65536);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
  if (hash !== p.sha256) throw fail(403, "Gateway payload mismatch");
  const auth = request.headers.get("Authorization");
  if (!/^Bearer sk-[A-Za-z0-9_-]+$/.test(auth || "")) throw fail(403, "Upstream authorization missing");
  const input = JSON.parse(new TextDecoder().decode(bytes));
  const gpt2 = input?.model === "gpt-image-2";
  const allowed = ["model", "prompt", "n", "size", "quality", "response_format", "output_format", "images", ...gpt2 ? ["output_compression", "background", "moderation", "input_fidelity", "user"] : []];
  if (!input || Object.keys(input).some((k) => !allowed.includes(k)) || !gpt2 && input.model !== "gpt-image-2.5-flare" || typeof input.prompt !== "string" || !input.prompt.trim() || input.n !== void 0 && input.n !== 1 || input.response_format !== void 0 && input.response_format !== "url") throw fail(400, "Unsupported image request");
  for (const field of ["size", "quality", "output_format"]) if (input[field] !== void 0 && (typeof input[field] !== "string" || input[field].length > 64 || /[\r\n]/.test(input[field]))) throw fail(400, "Invalid image option");
  const editing = p.path.endsWith("/edits"), refs = input.images || [];
  if (!Array.isArray(refs) || (editing ? refs.length < 1 || refs.length > 5 : refs.length !== 0)) throw fail(400, "Invalid reference count");
  if (gpt2) {
    if (input.size !== void 0 && input.size !== "auto") {
      const dimensions = /^([1-9]\d{0,3})x([1-9]\d{0,3})$/.exec(input.size);
      const width = Number(dimensions?.[1]), height = Number(dimensions?.[2]), pixels = width * height;
      if (!dimensions || width > 3840 || height > 3840 || width % 16 !== 0 || height % 16 !== 0 || Math.max(width, height) > Math.min(width, height) * 3 || pixels < 655360 || pixels > 8294400) throw fail(400, "Invalid image size");
    }
    if (input.quality !== void 0 && !["auto", "low", "medium", "high"].includes(input.quality)) throw fail(400, "Invalid image quality");
    if (input.output_format !== void 0 && !["png", "jpeg"].includes(input.output_format)) throw fail(400, "Invalid image format");
    if (input.output_compression !== void 0 && (input.output_format !== "jpeg" || !Number.isInteger(input.output_compression) || input.output_compression < 0 || input.output_compression > 100)) throw fail(400, "Invalid image compression");
    if (input.background !== void 0 && input.background !== "opaque") throw fail(400, "Invalid image background");
    if (input.moderation !== void 0 && !["auto", "low"].includes(input.moderation)) throw fail(400, "Invalid image moderation");
    if (input.input_fidelity !== void 0 && (!editing || input.input_fidelity !== "high")) throw fail(400, "Invalid image input fidelity");
    if (input.user !== void 0 && typeof input.user !== "string") throw fail(400, "Invalid image user");
  }
  const assets = [];
  for (const reference of refs) {
    if (typeof reference !== "string") throw fail(400, "Expected PIKNO media URL");
    const u = new URL(reference), m = /^\/media\/v1\/assets\/([a-f0-9]{32})$/.exec(u.pathname);
    if (u.origin !== "https://www.piknoai.com" || u.username || u.password || u.hash || !m || [...u.searchParams.keys()].length !== 1 || !u.searchParams.has("ticket")) throw fail(403, "Invalid media URL");
    const claims = await ticket(new Request(reference), env, m[1], "read");
    if (claims.uid !== p.uid || !claims.mime.startsWith("image/")) throw fail(403, "Foreign or invalid reference");
    const objectKey = `input/${p.uid}/${claims.id}`;
    const meta = await inspect(env, objectKey, claims);
    if (Number(meta.customMetadata?.expires) <= now) throw fail(404, "Reference expired");
    assets.push({ key: objectKey, ...claims });
  }
  const claimKey = `input/edge-requests/${p.uid}/${p.id}`;
  const claimed = await env.MEDIA.put(claimKey, "submitted", { onlyIf: { etagDoesNotMatch: "*" } });
  if (!claimed) throw fail(409, "Image request already submitted; do not retry");
  const fields = { ...input, n: 1, output_format: input.output_format || "png" };
  delete fields.images;
  delete fields.response_format;
  let body, contentType;
  if (editing) {
    const boundary = "pikno" + p.id;
    const segments = [];
    let length = 0;
    const add = /* @__PURE__ */ __name((text) => {
      const b = encoder3.encode(text);
      segments.push(b);
      length += b.length;
    }, "add");
    for (const [name, value] of Object.entries(fields)) add(`--${boundary}\r
Content-Disposition: form-data; name="${name}"\r
\r
${value}\r
`);
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i], ext = a.mime === "image/png" ? "png" : a.mime === "image/jpeg" ? "jpg" : "webp";
      add(`--${boundary}\r
Content-Disposition: form-data; name="${assets.length === 1 ? "image" : "image[]"}"; filename="reference-${i}.${ext}"\r
Content-Type: ${a.mime}\r
\r
`);
      segments.push(a);
      length += a.size;
      add("\r\n");
    }
    add(`--${boundary}--\r
`);
    const stream = new FixedLengthStream(length), writer = stream.writable.getWriter();
    const pumping = (async () => {
      try {
        for (const s of segments) {
          if (s instanceof Uint8Array) await writer.write(s);
          else {
            const obj = await env.MEDIA.get(s.key);
            if (!obj) throw fail(404, "Reference missing");
            const reader = obj.body.getReader();
            try {
              for (; ; ) {
                const part = await reader.read();
                if (part.done) break;
                await writer.write(part.value);
              }
            } finally {
              reader.releaseLock();
            }
          }
        }
        await writer.close();
      } catch (e) {
        await writer.abort(e);
      }
    })();
    body = stream.readable;
    contentType = "multipart/form-data; boundary=" + boundary;
    void pumping;
  } else {
    body = JSON.stringify(fields);
    contentType = "application/json";
  }
  const upstream = await fetch("https://cf.api.fan" + p.path, { method: "POST", headers: { Authorization: auth, "Content-Type": contentType }, body, redirect: "manual" });
  if (!upstream.ok) {
    let detail = "";
    try {
      const error = JSON.parse(new TextDecoder().decode(await boundedBytes(upstream.body, 16384)));
      detail = String(error.error?.message || error.message || "").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/https?:\/\/\S+/g, "[URL]").slice(0, 250);
    } catch {
    }
    const status = upstream.status >= 400 && upstream.status < 500 && upstream.status !== 408 ? upstream.status : 502;
    throw fail(status, `Upstream image request failed (HTTP ${upstream.status})${detail ? ": " + detail : ""}; inspect history before retrying`);
  }
  const result = JSON.parse(new TextDecoder().decode(await boundedBytes(upstream.body, 24 << 20)));
  if (!Array.isArray(result.data) || result.data.length !== 1) throw fail(502, "Unexpected image output count");
  const image = result.data[0];
  let file;
  if (image.b64_json) {
    file = Uint8Array.from(atob(image.b64_json), (c) => c.charCodeAt(0));
  } else if (gpt2) {
    let outputURL;
    try {
      outputURL = new URL(image.url);
    } catch {
      throw fail(502, "Invalid image output URL; inspect request history before retrying");
    }
    if (outputURL.protocol !== "https:" || outputURL.hostname !== "external-resources.packyapi.ai" || outputURL.port || outputURL.username || outputURL.password || outputURL.hash || !/^\/file_download\/[A-Za-z0-9_-]+$/.test(outputURL.pathname)) throw fail(502, "Invalid image output URL; inspect request history before retrying");
    try {
      const downloaded = await fetch(outputURL.href, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(3e4) });
      if (!downloaded.ok) {
        await downloaded.body?.cancel();
        throw new Error("Download rejected");
      }
      file = await boundedBytes(downloaded.body, 16 << 20);
    } catch {
      throw fail(502, "Image output delivery uncertain; inspect request history before retrying");
    }
  }
  if (file) {
    const mime = (gpt2 ? ["image/png", "image/jpeg"] : ["image/png", "image/jpeg", "image/webp"]).find((type) => matchesType(file, type));
    if (!mime || file.length < 12 || file.length > 16 << 20) throw fail(502, "Invalid image output");
    const id = crypto.randomUUID().replaceAll("-", ""), created = Math.floor(Date.now() / 1e3);
    await env.MEDIA.put(`input/${p.uid}/${id}`, file, { httpMetadata: { contentType: mime }, customMetadata: { uid: String(p.uid), expires: String(created + 86400) } });
    const signed = await signClaims({ v: 1, aud: "pikno-relay-media", uid: p.uid, id, op: "read", iat: created, exp: created + 7200, mime, size: file.length }, env.TICKET_KEY);
    image.url = `https://www.piknoai.com/media/v1/assets/${id}?ticket=${signed}`;
    delete image.b64_json;
  }
  if (typeof image.url !== "string" || !image.url.startsWith("https://")) throw fail(502, "Image URL missing");
  const small = { created: result.created || now, data: [{ url: image.url }], ...result.usage ? { usage: result.usage } : {} };
  if (JSON.stringify(small).length > 32768) throw fail(502, "Unexpected image result metadata");
  return json(small);
}
__name(packy, "packy");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
