const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { findResultFile, directoryUnreachable } = require("./electron/work-directory.cjs");
const CATEGORIES = { talent: "达人", product: "产品", scene: "场景" };
const TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
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
function createAssets(root, resultDir, uploadMedia, uploadDirect, { assetReadDirs = [], resultReadDirs = [] } = {}) {
  root = path.resolve(root);
  const assetDirs = [...new Set([root, ...assetReadDirs.map(directory => path.resolve(directory))])];
  const resultDirs = [...new Set([resultDir, ...resultReadDirs].map(directory => path.resolve(directory)))];
  const itemRoots = new WeakMap();
  let catalog = null;
  try {
    fs.mkdirSync(root, { recursive: true });
    if (!directoryUnreachable(root)) {
      for (const folder of Object.values(CATEGORIES))
        fs.mkdirSync(path.join(root, folder), { recursive: true });
    }
  } catch { /* Retained folders remain accessible when the current drive is unavailable. */ }
  const validCategory = (c) => {
    if (!CATEGORIES[c]) throw new Error("请选择达人、产品或场景分类");
    return CATEGORIES[c];
  };
  function entries(refresh = false) {
    if (!refresh && catalog) return catalog;
    const items = new Map();
    for (const directory of assetDirs) {
      for (const [category, folder] of Object.entries(CATEGORIES)) {
        const categoryDir = path.join(directory,folder);
        if (directoryUnreachable(categoryDir)) continue;
        let files;
        try { files = fs.readdirSync(categoryDir); } catch { continue; }
        for (const name of files.filter(file => /^[a-f0-9]{32}\.json$/.test(file))) {
          const id = name.slice(0,-5);
          if (items.has(id)) continue;
          try {
            const manifest = path.join(categoryDir,name);
            if (!fs.lstatSync(manifest).isFile()) continue;
            const item = JSON.parse(fs.readFileSync(manifest,"utf8"));
            if (item.id !== id || typeof item.created !== "string") continue;
            const entry = {...item,category};
            items.set(id,entry);
            itemRoots.set(entry,directory);
          } catch {}
        }
      }
    }
    catalog = [...items.values()].sort((a,b) => b.created.localeCompare(a.created));
    return catalog;
  }
  function file(item) {
    if (!TYPES[item.ext] || !/^[a-f0-9]{32}$/.test(item.id))
      throw new Error("资产记录无效");
    const directory = path.join(itemRoots.get(item) || root,validCategory(item.category));
    const target = path.join(directory,item.id + "." + item.ext);
    if (directoryUnreachable(directory) || !fs.existsSync(target) || !fs.lstatSync(target).isFile())
      throw new Error("资产文件不存在");
    return target;
  }
  function add(category, name, data, ext, metadata = {}) {
    const folder = validCategory(category);
    if (directoryUnreachable(path.join(root,folder))) throw new Error("无法访问作品目录，请检查本地目录");
    if (!TYPES[ext] || !data.length || data.length > MAX)
      throw new Error("请选择50MB以内的图片、视频或音频");
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
            : ext === "wav"
              ? signature.toString('ascii',0,4)==='RIFF' && signature.toString('ascii',8,12)==='WAVE'
            : ext === "mp3"
              ? signature.toString('ascii',0,3)==='ID3' || (signature[0]===255 && (signature[1]&224)===224)
            : ext === "aac"
              ? signature[0]===255 && (signature[1]&240)===240
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
      ...metadata,
    };
    fs.writeFileSync(path.join(root, folder, id + "." + ext), data, {
      flag: "wx",
    });
    const manifest = path.join(root, folder, id + ".json");
    fs.writeFileSync(manifest + ".tmp", JSON.stringify(item), { flag: "wx" });
    fs.renameSync(manifest + ".tmp", manifest);
    itemRoots.set(item,root);
    catalog = null;
    return item;
  }
  const handler = async function (req, res, url) {
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
        return reply(200, { root, categories: CATEGORIES, items: entries(true) });
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
        const source = findResultFile(input.local_path,resultDirs);
        if (
          !source ||
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
      const match = route.match(/^\/([a-f0-9]{32})\/(file|upload|upload-direct)$/);
      const item = match && entries().find((x) => x.id === match[1]);
      if (!item) return reply(404, { error: "资产不存在" });
      const source = file(item);
      if (match[2] === "file" && req.method === "GET") {
        const size = fs.statSync(source).size;
        const etag = `"${item.id}-${size}"`;
        if (!req.headers.range && req.headers["if-none-match"] === etag) {
          res.writeHead(304, {
            ETag: etag,
            "Cache-Control": "private, max-age=31536000, immutable",
          });
          return res.end();
        }
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
          ETag: etag,
          "Cache-Control": "private, max-age=31536000, immutable",
          ...(range
            ? { "Content-Range": `bytes ${start}-${end}/${size}` }
            : {}),
        });
        await pipeline(fs.createReadStream(source, { start, end }), res);
        return;
      }
      if ((match[2] === "upload" || match[2] === "upload-direct") && req.method === "POST") {
        const use = url.searchParams.get("use") || undefined;
        if (use !== undefined && !["image", "video", "tool"].includes(use))
          return reply(400, { error: "素材上传权限类型无效" });
        if (match[2] === "upload")
          return reply(200, await handler.upload(item.id, { kind: use, revision: req.headers['x-hamster-config-revision'] }));
        if (item.kind !== "image" || !uploadDirect)
          return reply(415, { error: "仅图片资产支持直接上传" });
        if (use !== undefined && use !== "image")
          return reply(400, { error: "图片资产直传仅支持图片权限" });
        const size = fs.statSync(source).size;
        const data = await uploadDirect(fs.createReadStream(source), {
          contentType: TYPES[item.ext],
          contentLength: size,
          fileName: item.id + "." + item.ext,
          kind: 'image',
          revision: req.headers['x-hamster-config-revision'],
        }, req);
        const remote = data.file?.url || data.url;
        if (!/^https?:\/\//i.test(remote || ""))
          throw new Error("上传未返回有效素材地址");
        return reply(200, { ...item, url: remote,
          ...(Number.isSafeInteger(data.file?.expires_at??data.expires_at)?{expires_at:data.file?.expires_at??data.expires_at}:{}) });
      }
      return reply(405, { error: "不支持此操作" });
    } catch (e) {
      if (!res.headersSent)
        reply([400,401,403,404,409,413,415,429,502,503].includes(e.statusCode||e.status)?e.statusCode||e.status:400, {
          error: /ENOENT|EACCES/.test(e.message)
            ? "无法访问素材文件，请检查本地目录"
            : e.message,
        });
      else res.destroy();
    }
  };
  handler.summary = () => {
    const items = entries();
    const counts = Object.fromEntries(Object.keys(CATEGORIES).map(category => [category,0]));
    for (const item of items) counts[item.category]++;
    return { total:items.length,counts };
  };
  handler.entries = entries;
  handler.add = add;
  handler.file = file;
  handler.setDuration = (id,seconds) => {
    if(!Number.isFinite(seconds)||seconds<=0||seconds>86400)throw new Error('素材时长无效');
    const item=handler.get(id);if(item.kind==='image')throw new Error('图片不需要时长');
    item.durationSeconds=seconds;
    const directory=path.join(itemRoots.get(item),validCategory(item.category));
    if(directoryUnreachable(directory))throw new Error('无法访问素材文件，请检查本地目录');
    const target=path.join(directory,item.id+'.json');
    fs.writeFileSync(target+'.tmp',JSON.stringify(item));fs.renameSync(target+'.tmp',target);catalog=null;return item;
  };
  handler.importTask = task => {
    const source=findResultFile(task.result.local_path,resultDirs);
    if(!source)throw new Error('生成结果路径无效');
    return add('scene',task.modelName || '生成结果',fs.readFileSync(source),path.extname(source).slice(1).toLowerCase(),{taskKey:task.key});
  };
  handler.get = id => {
    const item = entries(true).find(item=>item.id===id);
    if(!item) throw Object.assign(new Error('素材不存在'),{status:404});
    return item;
  };
  handler.upload = async (id,{kind,revision}={}) => {
    if(kind!==undefined&&!['image','video','tool'].includes(kind))throw new Error('素材上传权限类型无效');
    const item=handler.get(id), source=file(item);
    const result=await uploadMedia(fs.createReadStream(source),{
      contentType:TYPES[item.ext],contentLength:fs.statSync(source).size,
      fileName:item.id+'.'+item.ext,retention:'result',
      ...(kind?{kind}:{}),
      ...(revision!==undefined?{revision}:{}),
    });
    const url=result.file?.url || result.url;
    if(!/^https:\/\//.test(url || ''))throw new Error('对象存储未返回有效 HTTPS 链接');
    const durationSeconds=result.file?.durationSeconds??result.durationSeconds;
    const expires_at=result.file?.expires_at??result.expires_at;
    return {...item,url,
      ...(Number.isFinite(durationSeconds)&&durationSeconds>0?{durationSeconds}:{}),
      ...(Number.isSafeInteger(expires_at)?{expires_at}:{})};
  };
  return handler;
}
module.exports = { createAssets };
