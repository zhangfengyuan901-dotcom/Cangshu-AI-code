import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const example = fileURLToPath(new URL("../public/examples/media-edit.mjs", import.meta.url));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S9sAAAAASUVORK5CYII=",
  "base64",
);

function runExample(t, scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pikno-media-example-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(directory).startsWith("pikno-media-example-"), true);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const image = path.join(directory, "reference.png"),
    preload = path.join(directory, "fetch-fixture.mjs"),
    record = path.join(directory, "observed.json");
  fs.writeFileSync(image, png);
  fs.writeFileSync(
    preload,
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
let calls=0;
process.on('exit',()=>fs.writeFileSync(process.env.PIKNO_TEST_RECORD,JSON.stringify({calls})));
globalThis.fetch=async (target,options)=>{
 calls++;
 assert.equal(target,'https://www.piknoai.com/v1/images/edits');
 assert.equal(options.method,'POST');
 const headers=new Headers(options.headers);
 assert.equal(headers.get('authorization'),'Bearer '+process.env.PIKNO_API_KEY);
 assert.equal(headers.get('x-pikno-media-transport'),'direct-v1');
 assert.equal(headers.has('content-type'),false,'FormData supplies its own boundary');
 assert.equal(options.body instanceof FormData,true);
 assert.equal(options.body.get('model'),'pikno-image-synthetic');
 assert.equal(options.body.get('n'),'1');
 assert.equal(options.body.get('output_format'),'png');
 assert.equal(options.body.has('images'),false);
 const image=options.body.get('image');
 assert.equal(image.type,'image/png');
 assert.equal(image.name,'reference.png');
 assert.equal(image.size,${png.length});
 assert.equal(Buffer.from(await image.arrayBuffer()).equals(Buffer.from('${png.toString("base64")}','base64')),true);
 if(process.env.PIKNO_TEST_SCENARIO==='unknown')throw Error('synthetic-private-upstream-error');
 return Response.json({data:[{url:'https://synthetic.invalid/result?ticket=private-synthetic-reference',b64_json:'private-image-body'}]});
};
`,
  );
  const child = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, example, image],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PIKNO_API_KEY: "synthetic-example-key",
        PIKNO_IMAGE_MODEL: "pikno-image-synthetic",
        PIKNO_PROMPT: "synthetic reference edit",
        PIKNO_IMAGE_SIZE: "1024x1024",
        PIKNO_IMAGE_QUALITY: "high",
        PIKNO_TEST_SCENARIO: scenario,
        PIKNO_TEST_RECORD: record,
      },
    },
  );
  return { child, observed: JSON.parse(fs.readFileSync(record, "utf8")) };
}

test("published image-edit example posts original PNG once as direct multipart without storage upload", (t) => {
  const { child, observed } = runExample(t, "success");
  assert.equal(child.status, 0, "synthetic multipart request must complete");
  assert.equal(
    observed.calls,
    1,
    "the example must not upload to storage or create another request",
  );
  assert.deepEqual(JSON.parse(child.stdout), {
    response_received: true,
    images_received: 1,
    task_reference_received: false,
  });
  for (const value of [
    "private-synthetic-reference",
    "private-image-body",
    "synthetic-example-key",
  ]) {
    assert.equal(child.stdout.includes(value), false, "public output contains only fixed metadata");
  }
});

test("published image-edit example never retries an unknown submission or leaks its raw exception", (t) => {
  const { child, observed } = runExample(t, "unknown");
  assert.equal(child.status, 1);
  assert.equal(observed.calls, 1);
  assert.equal(child.stderr.includes("Submission response unconfirmed"), true);
  assert.equal(child.stderr.includes("synthetic-private-upstream-error"), false);
  assert.equal(child.stderr.includes("synthetic-example-key"), false);
  assert.equal(child.stdout, "");
});
