# 仓鼠智能推理网关

## PIKNO 收费执行通道（源码，默认关闭）

用户最新确认按真实usage后付费，不设客户单次金额封顶；单笔可扣至欠费，后续收费请求在余额恢复前拒绝。输入预估不作为开放前提，不把经验计数冒充可靠上界。只使用两条260915顺序执行；第三条260628保留在Secret配置中，但本策略始终跳过，避免未经证明的旧版上下文兼容。仅明确未执行的接入点限流拒绝才换下一条；未知停查账，不裁历史强行降级。当前为本地源码候选，上游Key尚未配置，不等于生产已接入。

Worker只有显式 `LLM_BILLING_MODE=actual_usage_v1` 才能执行新收费请求，且仍须 `PIKNO_LLM_MODEL_VERIFIED=true`。PIKNO对应的启用变量为 `PIKNO_LLM_BILLING_MODE=actual_usage_v1`。缺失、旧 `paid` 或错误值都关闭执行，不会回落免费旁路；仓库配置默认verified=false。`/v1/activate`、`/internal/pikno/activate` 和全部直接 `/api/v3/*` 路径被关闭；客户端必须经PIKNO账户权限、余额检查和持久操作账本进入唯一 `POST /internal/pikno/responses`。显式 `legacy` 仅保留历史兼容测试，不是收费部署选项。

该入口以 Worker Secret `PIKNO_ASSISTANT_BRIDGE_SECRET` 校验PIKNO的短效HMAC票据。票据v=2，绑定 `billing_mode=actual_usage_v1`、uid、32位request_id、相同jti、原始正文摘要、固定公开模型别名、最大输出、`pikno-text-three-actual-usage-v2`策略及最长60秒有效期。旧v1／预占策略票据失败关闭，新票据不得包含 `input_token_bound`。只支持纯文字Responses和SSE；Files、远程素材、工具、任意URL和上下文ID不开放。保留2MiB请求字节、最多200条消息及65536最大输出tokens的技术限制；这些不是客户金额封顶或完整输入token计数保证。

真实密钥和接入点只能使用Worker Secrets。收费路径使用 `PIKNO_LLM_ROUTES`：恰好三个对象的JSON数组，每项只含 `endpoint`、`version`；版本顺序必须为260915、260915、260628，接入点必须互不相同。不要在源码或本文填入真实值。旧单点Secret或历史 `LLM_ENDPOINTS` 不会自动变成收费线路。存在Secrets也不能绕过显式新计费mode、verified和发布验收关卡；本轮不配置Secrets或自动开放。

不再签发、读取或比较未经证明的输入token上界。两条同版本路线收到相同完整input、instructions和输出cap，只替换服务端endpoint；不裁历史，不添加未经官方合同支持的truncation参数。输入超出上游窗口时不假定零费用；非白名单拒绝停止并查原账。

`LLM_EXECUTIONS` Durable Object保留原v1对象名和永久 `dispatched` 标记；旧v1标记与旧预占policy的v2 journal都不能被重置、重领owner或恢复。v2记录只保存策略摘要、随机owner capability的单向摘要、顺序slot和状态，不保存正文、Key、uid或接入点。唯一在途owner每次必须先持久写入intent；只有已持久确认零执行拒绝，才可进入下一slot。并发、重启、丢失ack或结果不明均不能恢复重发。同一客户operation最多串行两次上游POST，第三slot仅持久记skipped；不竞速、不换jti。持久对象资源仍需受控批准，未创建云资源。

上游固定 `store:false` 和 `service_tier:default`。安全换线仅接受完整JSON、原生429、`TooManyRequests`与两个精确接入点RPM／TPM限流码；拒绝转义／重复字段、额外usage、输出或受理证据。已核实的模型／账户共享RPM、TPM或API RPM拒绝直接终止，不轮三条。任意其他4xx、5xx、网络错误、超时、畸形响应及2xx／SSE后异常均unknown，不重发。取消或票据截止后不开始下一条。

从未发出上游POST时仍使用旧`not_submitted`证据；已发送但所有尝试明确未执行时，使用新头 `X-PIKNO-Execution-State:rejected_before_execution` 加匹配code/state，不能冒充“未发送”。Go只认完整可信证明并幂等释放，账单终态仍为released。客户端展示“未执行，未扣费”，仅允许客户重新确认价格后的手动新请求。

成功响应仍按白名单重建，固定公开模型别名，usage不重估不逐块累加；reasoning只是output明细。缺终态或usage不能证明零费用，保留原操作待核，不自动按零或估算结算。新模式PIKNO一次持久操作、一次Worker请求、一次真实usage结算，不先预占金额；明确未执行的线路尝试不另建客户账单。客户价格仍为输入9／输出45元每百万tokens，上游成本单独核对，不以售价证明成本。

本轮仅本地源码、模拟上游及隔离运行时测试；没有读取Secret明文、部署、创建云资源或调用真实推理。既有对象句柄规则保留，Files不开放；聊天使用本地文字回放，不使用托管previous_response_id。运行时检查使用既有billing-worker开发依赖：`node --test cloudflare/llm-worker/test/paid-runtime.test.mjs`，临时SQLite与上游均为合成数据，结束后清理。

## 历史网关维护说明

以下说明仅用于历史非收费兼容模式，不能用来绕过上面的收费合同。旧 Worker 曾验证主线路 Key 并在固定接入点之间执行限流切换；真实密钥或接入点从不返回桌面应用。

生产敏感配置必须使用 Worker Secret，不得写入源码、Wrangler 配置、R2 或 D1：

安全提示：以下为历史维护命令，不是现在执行的配置步骤。Cloudflare的 `wrangler secret put` 会立即部署新版本；当前候选尚未通过发布验收，不执行该命令、不让用户在聊天提交Key。准备时可在用户自己的交互式终端使用 `wrangler versions secret put` 创建未部署版本，核对旧入口关闭和服务门禁后才单独批准部署。详见 [官方Secrets说明](https://developers.cloudflare.com/workers/configuration/secrets/)。不旋转现有签名Secret，也不改写其他服务。

```powershell
npx wrangler secret put ARK_API_KEY --config cloudflare/llm-worker/wrangler.jsonc
npx wrangler secret put LLM_ENDPOINTS --config cloudflare/llm-worker/wrangler.jsonc
npx wrangler secret put TOKEN_SIGNING_KEY --config cloudflare/llm-worker/wrangler.jsonc
npx wrangler deploy --config cloudflare/llm-worker/wrangler.jsonc
```

`LLM_ENDPOINTS` 使用英文逗号分隔。`TOKEN_SIGNING_KEY` 使用至少 32 字节的随机值。

历史 PIKNO 激活入口另需与 PIKNO 代理配对的 `PIKNO_ASSISTANT_BRIDGE_SECRET`（Worker Secret），新版收费模式关闭该入口。生产服务开关由 PIKNO 管理，本轮候选不自动开启、部署或发起真实推理。

新文件与回答引用使用按认证账户加密的对象句柄；文件读删、素材引用和上下文续接都在转发前验证归属。同 PIKNO 账户更换 Key 继续按账户 uid 授权；旧裸 ID 与跨账户对象不能转发。对象句柄的加密密钥从现有 `TOKEN_SIGNING_KEY` 分离派生，不新增公开对象索引。更换该 Secret 将使旧句柄失效，本地资料仍由客户端保留。

客户端与 PIKNO 代理须配套，文件路径支持最长 2048 字符的句柄。升级边界、离线测试和人工验收项见 [内部隔离说明](../../docs/assistant-account-isolation-20261018.md)。
