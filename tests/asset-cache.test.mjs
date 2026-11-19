import { test } from "node:test";
import assert from "node:assert/strict";
import { assetsRequest } from "../public/asset-library.mjs";

test("asset reads share in-flight work, use the short cache, and invalidate after writes", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options = {}) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ items: [], method: options.method || "GET" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const base = `/api/assets-cache-${Date.now()}`;
  const first = await Promise.all([assetsRequest(base), assetsRequest(base), assetsRequest(base)]);
  assert.equal(calls, 1);
  assert.deepEqual(first[0], first[2]);
  await assetsRequest(base);
  assert.equal(calls, 1);
  await assetsRequest(base, "/import", { method: "POST", body: "fixture" });
  assert.equal(calls, 2);
  await assetsRequest(base);
  assert.equal(calls, 3);
});
