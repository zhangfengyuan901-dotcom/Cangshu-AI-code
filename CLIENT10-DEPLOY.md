# PIKNO 客户界面精简：brand.10

## 交付范围

- 普通客户：总览、模型与价格、API 令牌、消费日志、任务日志、钱包、资料和安全。
- 总览使用现有金额格式与钱包统计组件，仅额外读取本账户数据；不读取密钥明文、密钥列表、模型列表或大型统计数据。
- 客户钱包隐藏订阅、推广、兑换码，停止对应订阅/推广请求；充值订单仅打开时读取。
- 固定充值 ¥50 / ¥100 / ¥200，微信和支付宝沿用原报价、确认、支付与回调链路。
- 管理员保留高级统计、渠道、模型、用户、审计及系统配置功能。
- 顶栏隐藏排行榜和登录后的重复首页；聊天/游乐场不出现在侧栏；保留原显示配置和服务端权限。
- `/developer` 提供已有 API/R2 接入说明，只在打开时读取静态文档；公开原文 `/developer-guide.md` 不含凭据。

## 验收证据

- Docker/Linux 和 Windows 类型检查通过；变更文件 lint、格式检查通过。
- 8 个相关测试文件、22 项测试通过：客户/管理员导航、隐藏模型目录、人民币固定档位、报价阻断、余额失败/重试、刷新、钱包请求与订单记录、任务访问、登录页及默认路由。
- Go 回归：`TestPiknoMediaControlPlane`、`TestPiknoMediaGuard`、`TestPiknoFixedCNY`、路由编译与 OpenAI 图片适配测试通过。
- 本地浏览器使用合成客户/管理员响应，不代表真实付费生成验收；未创建真实订单或调用上游。
- 390 × 844 手机视口：总览、钱包 document.scrollWidth = clientWidth = 390。
- 截图位于 `output/playwright/client10-*.png`；构建日志 `output/client10-build.log`。
- 客户首页业务组件只查询 `/api/user/self`，还会复用全站的系统信息/认证/公告请求。钱包初始保留账户、充值配置及报价请求；不宣称整个网站只发一个请求。
- 尚未做全站压测，不把隐藏入口等同于吞吐量提升；管理员高级页和历史路由仍保留。

## 重建

`build/brand10-client` 是从 `pikno-wallet7-test:latest` 导出的钱包源码基线；修改清单通过 `package-client10.mjs` 打包到 `client10/`，摘要在 `client10-manifest.json`。

```powershell
node deploy/new-api/package-client10.mjs
docker build -f deploy/new-api/Dockerfile.client10 -t pikno-new-api:v1.0.0-rc.41-brand.10 deploy/new-api
```

构建固定 Bun 1.4.0 与 bun.lock，后端完整叠加 media9 同样的路由、媒体保护和 Packy 边缘适配补丁。不得使用旧 Dockerfile.brand 单独替换生产镜像。

基镜像依赖本机保存的 wallet7 源码镜像及 brand.9 运行时。新前端不会删除后端功能或数据库表。

## 发布与回滚

最终镜像 digest：`sha256:a0fa2a3549e54f9b264defc782376fbe861283d620313ce4b8a84dde9690171a`。
导出文件 SHA256：`c6d9f4fa0d23a99fd6b01262ca4427b1c26a48f50c08e88dd5202627cf189bb1`。

`deploy-client10.sh` 校验包摘要、原镜像、无进行中任务，备份四份 compose、环境配置与 PostgreSQL，再更新 new-api 单一服务。脚本比较渠道状态及 options 全表摘要，健康检查失败恢复原 compose。

备份位置：ECS `/opt/piknoai-relay/current/.deploy-backups/client10-20261008`。已确认数据库 dump 存在，权限 0600。

回滚仅恢复备份 compose.yaml 并以既有四份 compose 对 new-api 执行 `up -d --no-deps --no-build --wait new-api`。禁止因为界面回滚而恢复整个数据库，避免覆盖期间真实交易。

## 线上验收状态

2026-10-08 21:15（Asia/Shanghai）发布成功：

- 公网 `/api/status` 返回 `v1.0.0-rc.41-pikno.10`，金额展示仍为 CNY。
- `/developer` 与 `/developer-guide.md` 均返回 200，文档包含 R2 直传步骤。
- 未登录访问渠道、充值配置、媒体上传和图片生成接口均为 401；Worker 的无凭证 Packy 入口仍为 401。
- new-api、支付桥、PostgreSQL、Redis 均健康，cloudflared 保持运行。
- 发布前后 options 全表摘要及渠道状态比对一致；渠道 1、2、3 仍为状态 2。未改价、未开启渠道、未生成付费订单或上游任务。
- 只读公网验收脚本：`verify-client10.ps1`；结果：`output/client10-production-acceptance-20261008.json`。
- 本轮一度使用 Python 默认客户端进行公网探测，被边缘返回 403；使用 Windows 原生 HTTP 客户端的正式验收通过，未修改防护策略。

本轮只完成客户界面第一阶段精简。复杂统计、历史路由和管理员功能未删除；模型详情字段进一步收敛和全站压测可作为后续独立工作，不能据此声称已完成全面性能优化。
