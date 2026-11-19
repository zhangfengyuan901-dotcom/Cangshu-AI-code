# 仓鼠AI素材中转

独立的 Cloudflare Worker + 私有 R2 桶。客户端只通过带密钥的 `/v1/upload` 写入；三宝收到的是带 HMAC 签名和过期时间的 `/tmp/...` HTTPS 地址。临时素材在同批任务全部结束后通过 `/v1/objects` 主动删除，遗漏对象和最终结果都由 R2 生命周期在 1 天后删除。

生产入口为 `https://media.hamsterai.cc`；`workers.dev` 仅保留为 Cloudflare 默认入口，不供桌面客户端使用。

部署与密钥：

```powershell
npx wrangler deploy --config cloudflare/media-worker/wrangler.jsonc
npx wrangler secret put UPLOAD_TOKEN --name hamster-ai-media
npx wrangler secret put URL_SIGNING_KEY --name hamster-ai-media
```

`UPLOAD_TOKEN` 和 `URL_SIGNING_KEY` 只保存在 Cloudflare Secret 和本机用户配置中，不写入仓库。图片访问权默认 1 小时，视频和音频默认 2 小时；反推联系表使用 15 分钟访问权。签名 URL 在有效期内允许 `HEAD`、`GET` 和多次 Range 请求。

2026-09-20 修复素材读取响应：普通 `GET` 返回 `200` 和完整内容，仅显式携带 `Range` 的 `GET` 返回 `206`。这只修正 HTTP 兼容性，不改变上传、签名或素材清理规则。
