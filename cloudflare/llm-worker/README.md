# 仓鼠智能推理网关

该 Worker 保存共享推理密钥、验证主线路 Key，并在三个固定接入点之间执行限流切换。桌面应用只连接 `https://inference.hamsterai.cc`，不会获得真实推理密钥或接入点。

生产敏感配置必须使用 Worker Secret，不得写入源码、Wrangler 配置、R2 或 D1：

```powershell
npx wrangler secret put ARK_API_KEY --config cloudflare/llm-worker/wrangler.jsonc
npx wrangler secret put LLM_ENDPOINTS --config cloudflare/llm-worker/wrangler.jsonc
npx wrangler secret put TOKEN_SIGNING_KEY --config cloudflare/llm-worker/wrangler.jsonc
npx wrangler deploy --config cloudflare/llm-worker/wrangler.jsonc
```

`LLM_ENDPOINTS` 使用英文逗号分隔。`TOKEN_SIGNING_KEY` 使用至少 32 字节的随机值。

PIKNO 入口另需与 PIKNO 代理配对的 `PIKNO_ASSISTANT_BRIDGE_SECRET`（Worker Secret）。生产服务开关由 PIKNO 管理，本轮候选不自动开启、部署或发起真实推理。

新文件与回答引用使用按认证账户加密的对象句柄；文件读删、素材引用和上下文续接都在转发前验证归属。同 PIKNO 账户更换 Key 继续按账户 uid 授权；旧裸 ID 与跨账户对象不能转发。对象句柄的加密密钥从现有 `TOKEN_SIGNING_KEY` 分离派生，不新增公开对象索引。更换该 Secret 将使旧句柄失效，本地资料仍由客户端保留。

客户端与 PIKNO 代理须配套，文件路径支持最长 2048 字符的句柄。升级边界、离线测试和人工验收项见 [内部隔离说明](../../docs/assistant-account-isolation-20261018.md)。
