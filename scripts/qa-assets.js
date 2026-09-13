async (page) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Real local asset API and proxy; only paid upload/model endpoints are mocked.
  await page.route("**/api/public-models", (r) =>
    r.fulfill({ json: { data: [] } }),
  );
  await page.goto("http://127.0.0.1:8788/");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "达人资产", exact: true }).click();
  await page
    .locator("#assetLibrary .asset-status")
    .filter({ hasText: "本地保存" })
    .waitFor();
  const image = await page.request.get(
    "http://127.0.0.1:8788/hamster-logo.png",
  );
  const buffer = await image.body();
  const name = "QA达人-" + Date.now() + ".png";
  await page
    .locator("#assetLibrary input[type=file]")
    .setInputFiles({ name, mimeType: "image/png", buffer });
  await page.locator(".asset-card strong").filter({ hasText: name }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "达人资产", exact: true }).click();
  await page.locator(".asset-card strong").filter({ hasText: name }).waitFor();
  await page
    .locator('#assetLibrary input[aria-label="搜索资产名称"]')
    .fill("不存在的资产");
  await page
    .getByText("暂无素材，点击导入或拖入图片、视频。", { exact: true })
    .waitFor();
  await page.locator('#assetLibrary input[aria-label="搜索资产名称"]').fill("");
  await page.screenshot({
    path: "output/playwright/assets-library.png",
    fullPage: true,
  });
  const listing = await (
    await page.request.get("http://127.0.0.1:8788/api/assets")
  ).json();
  const selected = listing.items.find((x) => x.name === name);
  const resultPath =
    listing.root.replace(/library$/, "results") + "\\sample.png";
  await page.evaluate(
    (data) =>
      localStorage.setItem(
        "hamster_history",
        JSON.stringify([
          {
            id: "asset-qa-result",
            type: "image",
            status: "succeeded",
            modelName: "仓鼠线路一",
            prompt: "QA图片结果",
            result: { local_path: data, image_url: "/hamster-logo.png" },
          },
        ]),
      ),
    resultPath,
  );
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page.getByRole("button", { name: "收入资产库", exact: true }).click();
  await page.getByRole("button", { name: "产品资产库", exact: true }).click();
  await page
    .locator("#toast")
    .filter({ hasText: "已收入本地资产库" })
    .waitFor();
  let submitted = null,
    job = null,
    uploads = 0;
  await page.route("**/studio-api/config", (r) =>
    r.fulfill({
      json: {
        mediaReady: true,
        llmReady: true,
        active: null,
        output: "本地QA目录",
      },
    }),
  );
  await page.route("**/studio-api/assets/*/upload", (r) => {
    uploads++;
    return r.fulfill({
      json: { ...selected, url: "https://example.com/talent.png" },
    });
  });
  await page.route("**/studio-api/upload?*", (r) => {
    uploads++;
    return r.fulfill({ json: { url: "https://example.com/temp-scene.mp4" } });
  });
  await page.route("**/studio-api/jobs**", (r) => {
    const url = r.request().url();
    if (r.request().method() === "POST") {
      submitted = r.request().postDataJSON();
      job = {
        id: "qa",
        brief: submitted,
        status: "failed",
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        stages: [],
        result: null,
        error: "离线验证完成",
      };
      return r.fulfill({ json: job });
    }
    return r.fulfill({ json: url.endsWith("/jobs") ? [] : job });
  });
  await page.goto("http://127.0.0.1:8003/");
  await page.getByRole("button", { name: "选择达人资产", exact: true }).click();
  await page
    .locator(".asset-card")
    .filter({ hasText: name })
    .getByRole("button", { name: "使用此资产", exact: true })
    .click();
  await page
    .locator("[data-asset-role=talent]")
    .filter({ hasText: name })
    .waitFor();
  if (uploads !== 0) throw new Error("Asset was uploaded before starting");
  await page.getByRole("button", { name: "女装穿搭", exact: true }).click();
  const video = await page.request.get(
    "http://127.0.0.1:8788/api/assets/" + selected.id + "/file",
  );
  // Mock bytes suffice here: real upload format checks are separate backend tests.
  await page
    .locator(".asset-reference")
    .nth(2)
    .locator("input[type=file]")
    .setInputFiles({
      name: "scene.mp4",
      mimeType: "video/mp4",
      buffer: await video.body(),
    });
  await page.locator("[name=video_model]").selectOption("sd25_30img_special");
  await page.getByRole("button", { name: "开始制作", exact: true }).click();
  await page.locator("#toast").filter({ hasText: "仅支持图片参考" }).waitFor();
  if (uploads !== 0) throw new Error("Invalid reference uploaded");
  await page.locator("[name=video_model]").selectOption("sd2_limited_line3");
  await page.screenshot({
    path: "output/playwright/assets-workbench.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "开始制作", exact: true }).click();
  await page.locator("#jobError").filter({ hasText: "离线验证完成" }).waitFor();
  if (
    submitted.references.length !== 2 ||
    submitted.references[0].role !== "talent" ||
    submitted.references[1].kind !== "video" ||
    uploads !== 2
  )
    throw new Error("References were not delivered correctly");
  if (errors.length) throw new Error(errors.join("\n"));
  await page.evaluate(() => localStorage.clear());
  await page.unrouteAll({ behavior: "wait" });
  console.log(
    "PASS: local import/reload/search, result collection, shared studio picker, temporary video, deferred upload, route guard and reference payload. No paid calls.",
  );
};
