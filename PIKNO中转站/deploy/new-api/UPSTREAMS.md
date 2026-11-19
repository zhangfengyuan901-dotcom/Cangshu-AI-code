# 上游接入状态

2026-10-04：三宝视频插件 v0.2.2 已完成一笔 4 秒 480p 真实任务；CanSeeDream 插件 v0.2.3 已完成鉴权、提交、任务查询和失败退款链路，但当前所测生成池尚未得到成功视频。两个插件及三个渠道均已恢复禁用，临时价格和令牌已清理，尚未分发客户令牌。PackyAPI 图片渠道此前已通过一次真实文生图和一次真实图生图。不要把下方调用示例当成目前已对外开放的接口。

## PackyAPI 图片

- 仅接入 PIKNO 现有模型 `gpt-image-2.5-flare`，上游 `https://cf.api.fan`。
- New API 渠道 ID 1，名称 `PIKNO PackyAPI 图片`，类型 OpenAI，状态禁用；密钥保存在受限的 `private/packy.json`，不写入本文。
- 已通过带认证的 `/v1/models` 预检，确认模型存在；公网中转站真实文生图和 multipart 图生图均通过，均为 HTTP 200、单张 1024×1024、high 质量。
- 预期协议：JSON `POST /v1/images/generations`；multipart 文件 `image` 的 `POST /v1/images/edits`，每次 `n=1`。
- 用户随后明确取消此前人民币 2 元测试上限，授权直接生成。2026-10-01 21:28–21:29（北京时间）完成文生图一次（约 22 秒）、图生图一次（约 60 秒），无重试。图生图将蓝色杯子变为橙色，保留造型与背景，已目视核验。
- 验收脚本 `test-packy-live.cjs` 用持久记录防止重复提交；记录和图片在受限目录 `private/packy-acceptance/`。New API 消费日志 ID 1、2 均归属渠道 1。测试令牌已撤销，临时内部计价已清除，渠道恢复禁用；未设置正式零售价格。日志中的测试额度不是 Packy 实际扣款，实际上游费用未核对。
- 2026-10-01 登录 Packy 控制台的价格接口显示：该模型仅在 `image` 分组，倍率 5；基础 `model_price=0.08`，但还有 `model_price_min=0.00588`、`model_price_max=0.71157`。页面实际展示每次 **0.029～3.558 平台额度**，故不能直接用 `0.08×5` 当作固定成本。
- 已有 PIKNO 售价人民币 0.10 元不是上游成本，不自动迁移该售价。现有 PIKNO 应用、Workers 和客户端密钥均未切换。

## 密钥

`private/upstreams.json` 中的三宝 `apiKey` 和 CanSeeDream `videoApiKey` 已通过真实 Bearer 鉴权。CanSeeDream 的旧 `imageApiKey` 字段不使用，不需要填写。该文件受 Windows ACL 保护且被 Git 忽略。使用有额度上限的密钥；不要上传到聊天、前端或公开仓库。

后续渠道规划：三宝、CanSeeDream 各一个视频任务插件渠道。渠道类型为 61，分别绑定 `pikno-sanbao`、`pikno-canseedream`。两家均不接入图片线路。

## 已实现与验证

- 源码：`plugins/runtime.js`；按公开模型目录打包的单文件插件在 `plugins/generated/`。
- 三宝 25 个视频目录模型；CanSeeDream 按 2026-10-04 实时 `/health` 刷新为 13 个视频线路。名称加供应商前缀，避免相同模型名混淆；生成插件不暴露图片模型。
- 文生视频、JSON 参考素材、异步提交、持久任务查询、结果 URL 白名单输出、未知状态拒绝、模型/数量/部分参数校验。
- 每次请求仅一个产物；`n`、`concurrency`、`number_of_runs` 只允许 1。不支持多任务批量、原始二进制上传、multipart、视频增强、OpenAI 同步图片协议或结果文件代理。
- 当前目录对应 80 项 Node 模拟测试通过；包括 Bearer 认证、拒绝旧图片模型、固定上游 origin 和单产物限制。三宝 `sanbao/sd2_480p_real` 的真实创建、轮询、结算和 MP4 结果已通过；返回文件支持 Range，实测约 1.02 MiB。并未验证供应商所有模型可用性。
- 插件允许的上游 origin 固定，不能从客户端注入 URL/认证头。密钥由 New API 渠道注入，不写在插件源码。CanSeeDream 的旧 `canseedream.com` API 会 301 到 `see.ximeiedu.org`；为避免携带密钥跟随重定向，插件固定使用后者。
- 生产渠道：ID 2 `PIKNO 三宝视频`（25 模型）、ID 3 `PIKNO CanSeeDream 视频`（13 模型），均为类型 61、`default` 分组、状态 2（手动禁用）。Packy 图片仍为渠道 ID 1、禁用。
- 验收任务：三宝本站 taskId `task_GfwKRhsBofs1rzfkh3mPP5bHKpaZM70I` 成功，临时内部结算 20,000 quota（$0.04）；CanSeeDream `donggua_pool` 创建成功后由上游以 `ServiceBusy` 终止并退款，`yuni_pool` 已下线，实时默认 `caomeinewa` 返回 `taskCreated:false`。这些失败均未留存客户扣费。
- 首版只通过插件原生查询返回签名媒体 URL；通用任务查询不会返回这些 URL。链接过期需单独处理，尚未实现过期自动刷新/长期存储。

## 预期调用方式（启用并配置渠道、价格后）

向自己的中转站传 New API 客户令牌，而不是供应商密钥。

视频模型使用 `sanbao/<目录模型>` 或 `canseedream/video/<线路ID>`，显式传入该线路允许的 `duration`、`resolution`，参数格式沿用对应供应商文档。分别 POST 到 `https://www.piknoai.com/pikno-sanbao/tasks` 或 `https://www.piknoai.com/pikno-canseedream/tasks`。这两个插件创建路径均拒绝图片模型。

保存响应的公开 `id`，每 5–10 秒查询对应 `/pikno-sanbao/tasks/{id}` 或 `/pikno-canseedream/tasks/{id}`。终态为 `SUCCESS`/`FAILURE`，成功时读取 `outputs[].url`。HTTP 200 不等于生成成功。

## 上线前必须解决

1. 三宝短视频主链路已验收。CanSeeDream 已验证密钥、创建与失败退款，但仍需等待上游可用生成池后取得至少一个成功视频；不要因 `ServiceBusy` 或 `taskCreated:false` 自动重发。参考视频等另测。
2. 确认零售计价、分组及额度；视频时长/清晰度/线路的成本不同，不自动把供应商积分当美元。当前未设置任何价格，不能据此营业。
3. CanSeeDream 部分审核类失败仍扣上游积分，而 New API 的 FAILURE 默认退款给客户。需要决定由站方承担这类成本还是开发进一步结算支持；首版不能假称供应商会全部退款。
4. New API 当前 RetryTimes=0，保持自动重试关闭。三宝文档未承诺幂等；超时或返回无任务 ID 时先核对供应商任务历史，不盲目重发。
5. CanSeeDream 使用本次 New API 公开任务 ID 作为上游幂等键，仅保护同一次宿主提交尝试；**不提供跨客户端重复请求的去重保证**。客户端失败重试也必须先核对任务日志。
6. New API 连续轮询失败/任务超时可能走退款链，但上游任务可能继续扣费；需要运营对账，不能把查询失败当作供应商退款凭证。
7. 固定版本是 RC，先内部试用。长期运行迁移至持续在线服务器并建立数据库与密钥加密备份。

## 开发检查

```powershell
node test-plugins.cjs
node test-host-plugins.cjs
```

`build-plugins.cjs` 会刷新公开模型目录并重新生成文件，不会自动部署；`--from-snapshot` 使用保存的目录。新版本需复核目录和源码差异、更新版本号、重新测试后再安装；不要在运营中直接替换已有插件。`install-plugins.cjs` 默认拒绝覆盖 hash 不同的已有插件；`--replace-staged` 仅用于禁用且未绑定渠道、无运行中任务的待验收插件。

参考：[三宝文档](https://sanbaobeauty.com/docs.html)、[CanSeeDream 文档](https://see.ximeiedu.org/developer-api)、[New API 任务插件](https://docs.newapi.pro/zh/docs/plugins)。
