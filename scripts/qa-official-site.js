async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:8788/");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#download").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.locator("h1").scrollIntoViewIfNeeded();
  if ((await page.locator(".reveal.visible").count()) < 2)
    throw new Error("Reveal animation did not activate");
  if (
    !(await page.locator("h1").textContent()).includes("先看作品")
  )
    throw new Error("Case-first heading mismatch");
  if ((await page.locator("main > section").count()) !== 2)
    throw new Error("Homepage should contain only cases and download");
  if ((await page.locator("main > section").first().getAttribute("id")) !== "cases")
    throw new Error("Cases are not first");
  if (
    (await page.locator("#portableDownload").getAttribute("href")) !==
    "/download/HamsterAI-Portable-1.7.49.exe"
  )
    throw new Error("Portable link mismatch");
  if (await page.locator('a[href*="Setup-"]').count())
    throw new Error("Installer link must not be shown");
  if ((await page.request.get("http://127.0.0.1:8788/tutorials/")).status() !== 200)
    throw new Error("Tutorial category page unavailable");
  if ((await page.locator(".case-card").count()) !== 10)
    throw new Error("Case gallery mismatch");
  await page.locator("#cases").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  if (
    await page
      .locator('img[src]:not([src=""])')
      .evaluateAll((images) =>
        images.some(
          (image) =>
            image.getAttribute("src") &&
            (!image.complete || !image.naturalWidth),
        ),
      )
  )
    throw new Error("Image failed");
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Desktop overflow");
  await page.locator(".case-card").first().click();
  if (!(await page.locator(".case-dialog").evaluate((dialog) => dialog.open)))
    throw new Error("Case dialog did not open");
  await page.locator(".case-dialog .dialog-close").click();
  await page.screenshot({
    path: "output/playwright/official-site-desktop-viewport.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator("#download").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Mobile overflow");
  await page.locator("h1").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "output/playwright/official-site-mobile.png" });
  await page.locator("#download").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "output/playwright/official-site-mobile-download.png",
  });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: case-first homepage, download, tutorial categories, desktop/mobile layout and case dialog.",
  );
}
