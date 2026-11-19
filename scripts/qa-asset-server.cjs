// Isolated local QA server: no user keys, data or paid upstream calls.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve("output/playwright/asset-qa");
fs.mkdirSync(path.join(root, "results"), { recursive: true });
fs.copyFileSync(
  "public/hamster-logo.png",
  path.join(root, "results", "sample.png"),
);
require("../server")
  .createApp({
    assetDir: path.join(root, "library"),
    resultDir: path.join(root, "results"),
    configPath: path.join(root, "no-config.json"),
  })
  .listen(8788, "127.0.0.1", () => console.log("Asset QA ready :8788"));
