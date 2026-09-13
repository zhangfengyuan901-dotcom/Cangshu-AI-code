const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
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
  const upstream = http.createServer(async (req, res) => {
    uploads++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.ok(Buffer.concat(chunks).length);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        file: { url: "https://example.com/upload-" + uploads + ".png" },
      }),
    );
  });
  const upstreamUrl = await listen(upstream);
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ apiKey: "test-key" }));
  const app = createApp({
    assetDir,
    resultDir,
    configPath,
    upstream: upstreamUrl,
  });
  const base = await listen(app);
  t.after(async () => {
    await Promise.all([
      new Promise((r) => app.close(r)),
      new Promise((r) => upstream.close(r)),
    ]);
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
  assert.deepEqual(
    Buffer.from(await (await api("/" + imported.id + "/file")).arrayBuffer()),
    png,
  );
  const range = await api("/" + imported.id + "/file", {
    headers: { Range: "bytes=0-7" },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 8);
  const first = await (
    await api("/" + imported.id + "/upload", { method: "POST" })
  ).json();
  const second = await (
    await api("/" + imported.id + "/upload", { method: "POST" })
  ).json();
  assert.notEqual(first.url, second.url);
  assert.equal(uploads, 2);
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
