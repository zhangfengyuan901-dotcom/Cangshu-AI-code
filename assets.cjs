const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const CATEGORIES = { talent: "达人", product: "产品", scene: "场景" };
const TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
const MAX = 50 * 1024 * 1024;
async function body(req, limit = MAX) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("素材最大支持50MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function createAssets(root, resultDir, upstream, keyFor) {
  root = path.resolve(root);
  resultDir = path.resolve(resultDir);
  for (const folder of Object.values(CATEGORIES))
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  const validCategory = (c) => {
    if (!CATEGORIES[c]) throw new Error("请选择达人、产品或场景分类");
    return CATEGORIES[c];
  };
  function entries() {
    return Object.entries(CATEGORIES)
      .flatMap(([category, folder]) =>
        fs
          .readdirSync(path.join(root, folder))
          .filter((n) => /^[a-f0-9]{32}\.json$/.test(n))
          .flatMap((n) => {
            try {
              const item = JSON.parse(
                fs.readFileSync(path.join(root, folder, n), "utf8"),
              );
              return item.id === n.slice(0, -5) ? [{ ...item, category }] : [];
            } catch {
              return [];
            }
          }),
      )
      .sort((a, b) => b.created.localeCompare(a.created));
  }
  function file(item) {
    if (!TYPES[item.ext] || !/^[a-f0-9]{32}$/.test(item.id))
      throw new Error("资产记录无效");
    const target = path.join(
      root,
      validCategory(item.category),
      item.id + "." + item.ext,
    );
    if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink())
      throw new Error("资产文件不存在");
    return target;
  }
  function add(category, name, data, ext) {
    const folder = validCategory(category);
    if (!TYPES[ext] || !data.length || data.length > MAX)
      throw new Error("请选择50MB以内的图片或视频");
    const signature = data.subarray(0, 12);
    const valid =
      ext === "png"
        ? signature
            .subarray(0, 8)
            .equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : ["jpg", "jpeg"].includes(ext)
          ? signature[0] === 255 && signature[1] === 216
          : ext === "webp"
            ? signature.toString("ascii", 0, 4) === "RIFF" &&
              signature.toString("ascii", 8, 12) === "WEBP"
            : ext === "webm"
              ? signature.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))
              : signature.toString("ascii", 4, 8) === "ftyp";
    if (!valid) throw new Error("文件内容与图片或视频格式不匹配");
    if (TYPES[ext].startsWith("image/") && data.length > 30 * 1024 * 1024)
      throw new Error("图片最大支持30MB");
    const id = crypto.randomBytes(16).toString("hex");
    const item = {
      id,
      category,
      name: String(name || "未命名素材").slice(0, 160),
      ext,
      kind: TYPES[ext].split("/")[0],
      size: data.length,
      created: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(root, folder, id + "." + ext), data, {
      flag: "wx",
    });
    const manifest = path.join(root, folder, id + ".json");
    fs.writeFileSync(manifest + ".tmp", JSON.stringify(item), { flag: "wx" });
    fs.renameSync(manifest + ".tmp", manifest);
    return item;
  }
  return async function (req, res, url) {
    const reply = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`)
        return reply(403, { error: "请从本地应用操作资产库" });
      const route = url.pathname.slice("/api/assets".length);
      if (!route && req.method === "GET")
        return reply(200, { root, categories: CATEGORIES, items: entries() });
      if (route === "/import" && req.method === "POST") {
        const name = url.searchParams.get("name") || "素材";
        const ext = path.extname(name).slice(1).toLowerCase();
        return reply(
          201,
          add(url.searchParams.get("category"), name, await body(req), ext),
        );
      }
      if (route === "/import-result" && req.method === "POST") {
        const input = JSON.parse((await body(req, 8192)).toString());
        const source = fs.realpathSync(String(input.local_path || ""));
        const base = fs.realpathSync(resultDir);
        if (
          !source.startsWith(base + path.sep) ||
          !fs.statSync(source).isFile() ||
          fs.statSync(source).size > MAX
        )
          throw new Error(
            "仅可收录已保存到生成结果目录的图片或视频（最大50MB）",
          );
        return reply(
          201,
          add(
            input.category,
            input.name || path.basename(source),
            fs.readFileSync(source),
            path.extname(source).slice(1).toLowerCase(),
          ),
        );
      }
      const match = route.match(/^\/([a-f0-9]{32})\/(file|upload)$/);
      const item = match && entries().find((x) => x.id === match[1]);
      if (!item) return reply(404, { error: "资产不存在" });
      const source = file(item);
      if (match[2] === "file" && req.method === "GET") {
        const size = fs.statSync(source).size;
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0,
          end =
            range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { "Content-Range": `bytes */${size}` });
          return res.end();
        }
        res.writeHead(range ? 206 : 200, {
          "Content-Type": TYPES[item.ext],
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
          "X-Content-Type-Options": "nosniff",
          ...(range
            ? { "Content-Range": `bytes ${start}-${end}/${size}` }
            : {}),
        });
        return fs.createReadStream(source, { start, end }).pipe(res);
      }
      if (match[2] === "upload" && req.method === "POST") {
        const key = keyFor(req);
        if (!key) return reply(400, { error: "请先配置图片 / 视频 API Key" });
        const response = await fetch(
          `${upstream}/openapi/v1/uploads/raw?kind=${item.kind}&fileName=${encodeURIComponent(item.id + "." + item.ext)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "X-API-Key": key,
              "Content-Type": TYPES[item.ext],
            },
            body: fs.readFileSync(source),
            signal: AbortSignal.timeout(120000),
          },
        );
        if (!response.ok) throw new Error("资产上传失败，请检查服务配置后重试");
        const data = await response.json();
        const remote = data.file?.url || data.data?.download_url;
        if (!/^https?:\/\//i.test(remote || ""))
          throw new Error("上传未返回有效素材地址");
        return reply(200, { ...item, url: remote });
      }
      return reply(405, { error: "不支持此操作" });
    } catch (e) {
      if (!res.headersSent)
        reply(400, {
          error: /ENOENT|EACCES/.test(e.message)
            ? "无法访问素材文件，请检查本地目录"
            : e.message,
        });
      else res.destroy();
    }
  };
}
module.exports = { createAssets };
