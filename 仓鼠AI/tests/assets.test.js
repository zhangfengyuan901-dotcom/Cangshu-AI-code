const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { Readable } = require("node:stream");
const { createAssets } = require("../assets.cjs");
const { createApp } = require("../server");
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  );
test("assets persist locally, preview ranges, upload on demand and collect results safely", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hamster-assets-"));
  const resultDir = path.join(root, "results");
  fs.mkdirSync(resultDir);
  const assetDir = path.join(root, "assets");
  let uploads = 0;
  let directUploads = 0;
  const uploadMetadata = [];
  const mediaUploader = async (data, metadata) => {
    uploads++;
    uploadMetadata.push(metadata);
    assert.equal(Buffer.isBuffer(data), false);
    let size=0;for await(const chunk of data)size+=chunk.length;
    assert.equal(size, metadata.contentLength);
    assert.equal(metadata.contentType, "image/png");
    return { file: { url: "https://example.com/upload-" + uploads + ".png", expires_at:1800000000 } };
  };
  const directMediaUploader = async (data, metadata) => {
    directUploads++;
    assert.equal(Buffer.isBuffer(data), false);
    let size=0;for await(const chunk of data)size+=chunk.length;
    assert.equal(size, metadata.contentLength);
    return { file: { url: "https://sanbaobeauty.com/upload-direct.png" } };
  };
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ apiKey: "test-key" }));
  const app = createApp({
    assetDir,
    resultDir,
    configPath,
    mediaUploader,
    directMediaUploader,
  });
  const base = await listen(app);
  t.after(async () => {
    await new Promise((r) => app.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const api = (suffix = "", options = {}) =>
    fetch(base + "/api/assets" + suffix, options);
  const list = await (await api()).json();
  assert.deepEqual(list.items, []);
  assert.equal(Object.keys(list.categories).length, 3);
  for (const folder of ["达人", "产品", "场景"])
    assert.ok(fs.existsSync(path.join(assetDir, folder)));
  const png = fs.readFileSync(
    path.join(__dirname, "../public/hamster-logo.png"),
  );
  const imported = await (
    await api("/import?category=talent&name=talent.png", {
      method: "POST",
      body: png,
    })
  ).json();
  assert.equal(imported.kind, "image");
  assert.equal(uploads, 0);
  const fullFile = await api("/" + imported.id + "/file");
  assert.equal(fullFile.headers.get("cache-control"), "private, max-age=31536000, immutable");
  const etag = fullFile.headers.get("etag");
  assert.ok(etag);
  assert.deepEqual(Buffer.from(await fullFile.arrayBuffer()), png);
  assert.equal((await api("/" + imported.id + "/file", { headers: { "If-None-Match": etag } })).status, 304);
  const range = await api("/" + imported.id + "/file", {
    headers: { Range: "bytes=0-7" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 0-7/${png.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(0, 8));
  assert.equal((await api("/" + imported.id + "/file", { method: "HEAD" })).status, 405);
  const outsideRange = await api("/" + imported.id + "/file", {
    headers: { Range: `bytes=${png.length}-` },
  });
  assert.equal(outsideRange.status, 416);
  assert.equal(outsideRange.headers.get("content-range"), `bytes */${png.length}`);
  const first = await (
    await api("/" + imported.id + "/upload", { method: "POST" })
  ).json();
  const second = await (
    await api("/" + imported.id + "/upload", { method: "POST" })
  ).json();
  assert.notEqual(first.url, second.url);
  assert.equal(first.expires_at,1800000000);
  assert.equal(second.expires_at,1800000000);
  assert.equal(uploads, 2);
  assert.equal(uploadMetadata[0].kind, undefined, "旧素材上传调用保持默认权限选择");
  assert.equal(uploadMetadata[1].kind, undefined, "旧素材上传调用保持默认权限选择");
  const videoScoped = await (await api("/" + imported.id + "/upload?use=video", { method: "POST" })).json();
  assert.match(videoScoped.url,/upload-3\.png$/);
  assert.equal(uploadMetadata[2].kind,"video");
  assert.equal((await api("/" + imported.id + "/upload?use=invalid", { method: "POST" })).status,400);
  assert.equal(uploads,3,"无效用途必须在上传前拒绝");
  const direct = await (await api("/" + imported.id + "/upload-direct", { method: "POST" })).json();
  assert.equal(direct.url,"https://sanbaobeauty.com/upload-direct.png");
  assert.equal(directUploads,1);
  const invalid = await api("/import?category=talent&name=fake.png", {
    method: "POST",
    body: "not-image",
  });
  assert.equal(invalid.status, 400);
  const traversal = await api("/import?category=../outside&name=x.png", {
    method: "POST",
    body: png,
  });
  assert.equal(traversal.status, 400);
  const cross = await api("/import?category=talent&name=x.png", {
    method: "POST",
    body: png,
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(cross.status, 403);
  fs.writeFileSync(path.join(resultDir, "result.png"), png);
  const collect = await api("/import-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "product",
      local_path: path.join(resultDir, "result.png"),
    }),
  });
  assert.equal(collect.status, 201);
  const outside = await api("/import-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "product", local_path: configPath }),
  });
  assert.equal(outside.status, 400);
  const app2 = createApp({ assetDir, resultDir, configPath });
  const base2 = await listen(app2);
  try {
    const data = await (await fetch(base2 + "/api/assets")).json();
    assert.equal(data.items.length, 2);
    assert.ok(fs.existsSync(path.join(resultDir, "result.png")));
  } finally {
    await new Promise((r) => app2.close(r));
  }
});

async function previewFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hamster-preview-stream-"));
  const assets = createAssets(path.join(root, "assets"), path.join(root, "results"));
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64)]);
  const item = assets.add("scene", "preview.png", png, "png");
  const pending = [];
  const app = http.createServer((req, res) => {
    pending.push(assets(req, res, new URL(req.url, "http://127.0.0.1")));
  });
  t.after(async () => {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "hamster-preview-stream-")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = await listen(app);
  return {
    assets, item, png, base,
    url: `${base}/api/assets/${item.id}/file`,
    settled: () => Promise.all(pending),
  };
}

test("asset preview open failure closes its stream and leaves the service usable", { timeout: 5000 }, async (t) => {
  const fixture = await previewFixture(t);
  const createReadStream = fs.createReadStream;
  let source;
  t.mock.method(fs, "createReadStream", (file, options) => {
    // Reproduce a file disappearing between stat and the asynchronous open.
    fs.unlinkSync(file);
    source = createReadStream(file, options);
    return source;
  });
  await assert.rejects(async () => {
    const response = await fetch(fixture.url);
    await response.arrayBuffer();
  });
  await fixture.settled();
  assert.equal(source.destroyed, true);
  assert.equal(source.closed, true);
  const response = await fetch(fixture.base + "/api/assets");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items.length, 1);
});

test("asset preview read failure interrupts the response without leaking its error", { timeout: 5000 }, async (t) => {
  const fixture = await previewFixture(t);
  let source;
  t.mock.method(fs, "createReadStream", () => {
    let started = false;
    source = new Readable({
      read() {
        if (started) return;
        started = true;
        this.push(fixture.png.subarray(0, 8));
      },
    });
    return source;
  });
  const response = await fetch(fixture.url);
  const reading = response.arrayBuffer();
  const rejected = assert.rejects(reading);
  source.destroy(new Error("synthetic-private-path-and-read-error"));
  await rejected;
  await fixture.settled();
  assert.equal(source.destroyed, true);
  assert.equal(source.closed, true);
  const healthy = await fetch(fixture.base + "/api/assets");
  assert.equal(healthy.status, 200);
  assert.doesNotMatch(await healthy.text(), /synthetic-private-path-and-read-error/);
});

test("asset preview client cancellation destroys a pending source", { timeout: 5000 }, async (t) => {
  const fixture = await previewFixture(t);
  let source;
  t.mock.method(fs, "createReadStream", () => {
    let started = false;
    source = new Readable({
      read() {
        if (started) return;
        started = true;
        this.push(fixture.png.subarray(0, 8));
      },
    });
    return source;
  });
  const controller = new AbortController();
  const response = await fetch(fixture.url, { signal: controller.signal });
  assert.equal(response.status, 200);
  controller.abort();
  await assert.rejects(response.arrayBuffer());
  await fixture.settled();
  assert.equal(source.destroyed, true);
  assert.equal(source.closed, true);
  const healthy = await fetch(fixture.base + "/api/assets");
  assert.equal(healthy.status, 200);
  await healthy.arrayBuffer();
});

test("empty asset preview preserves the range rejection and does not open a stream", async (t) => {
  const fixture = await previewFixture(t);
  fs.truncateSync(fixture.assets.file(fixture.item), 0);
  const open = t.mock.method(fs, "createReadStream", () => { throw new Error("unexpected stream open"); });
  const response = await fetch(fixture.url);
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */0");
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(open.mock.callCount(), 0);
});
