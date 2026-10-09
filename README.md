# PIKNO AI 中转站

2026-10-01 创建。独立 Docker Compose 项目 `piknoai-relay`，不替换已有 PIKNO Workers 或客户端配置。

## 组成

- New API `v1.0.0-rc.41`，固定镜像 digest。当前官方最新版仍带 RC 名称，正式销售前需完成渠道、价格和任务结算验收。
- PostgreSQL 16、Redis 7，独立 Docker volumes，数据库不映射宿主机端口。
- Cloudflare Tunnel `piknoai-relay`：仅将 `www.piknoai.com` 路由到 ECS 内的 `http://new-api:3000`，其他主机名返回 404。
- ECS 回环入口 `http://127.0.0.1:3100`；唯一公网入口 `https://www.piknoai.com`。

香港 ECS `8.217.68.247` 是当前生产源站。本机 Windows Compose 已停止，仅保留加密凭证、冻结快照和恢复工具，不再接收生产流量。

## 启停

在 ECS 的 `/opt/piknoai-relay/current` 运行：

```bash
docker compose -f compose.yaml -f compose.tunnel.yaml -f compose.ecs.yaml up -d --wait
docker compose -f compose.yaml -f compose.tunnel.yaml -f compose.ecs.yaml ps
docker compose -f compose.yaml -f compose.tunnel.yaml -f compose.ecs.yaml stop
```

公网配置启用 Secure Cookie；请从 HTTPS 域名登录。基础 `compose.yaml` 的 HTTP 模式只用于隔离本地调试。

## 凭证

- 管理员用户名、密码：`private/administrator.json`。
- 数据库、Redis、会话及渠道加密密钥：`.env`。
- Tunnel Token：`private/tunnel-token.txt`。
- Tunnel ID 与账号：`private/tunnel.json`。

以上文件均已忽略，不能分发给客户或提交代码仓库。已限制本机访问权限；ECS 部署目录仅 root 可访问，Tunnel Token 仅 cloudflared 运行用户可读。保留这些密钥的加密备份，尤其不能在有数据后重新生成 `CRYPTO_SECRET`。

`init-secrets.cjs` 仅用于首次部署，发现已有凭证就拒绝覆盖。`setup.cjs` 初始化管理员；`configure.cjs` 设置站点名、关闭公开注册和新用户/邀请赠额。不要对已运营实例盲目重新运行配置脚本。

## 当前配置边界

用户注册暂时关闭。已创建 PackyAPI 图片渠道并通过两次真实调用验收，测试后恢复禁用，尚未设置正式售价或对外开放。临时测试令牌已撤销；未分发客户 API Key、配置支付渠道或充值。New API 安装时分配的管理员内部测试额度不代表实际充值或上游余额。

客户闭环第一阶段已开始，范围、邮件安全边界和上线门禁见 `CUSTOMER-PHASE-1.md`。2026-10-04 已完成 `mail.piknoai.com` 的 Resend 验证、Cloudflare DKIM/SPF/DMARC 记录、域名限定发送密钥和 New API SMTP 接入；真实邮箱验证邮件已 Delivered。Cloudflare Turnstile 已按 `www.piknoai.com` 单域名启用，生产密钥已轮换，服务端探针和连续浏览器挑战均通过。管理员找回邮箱、真实密码重置邮件、一次性链接消费、凭证同步、Argon2id 哈希核对和新密码登录也已完成。公开注册、密码注册和邮箱验证开关仍关闭，新用户及邀请赠额均为 0；法律页面确认完成前不开放邀请注册。

三宝与 CanSeeDream 的异步视频插件及类型 61 渠道已经落地，客户侧仍全部禁用。三宝 v0.2.2 已通过一笔 4 秒 480p 真实视频的创建、轮询、结算和 MP4 结果验收；CanSeeDream v0.2.3 已验证视频 Key、真实提交、失败查询和退款，但所测线路分别出现 `ServiceBusy`、已下线或任务创建前拒绝，尚无成功视频。CanSeeDream 目录已按实时 `/health` 刷新为 13 条线路，固定源站改为 `https://see.ximeiedu.org`。零售价格尚未设置，临时令牌和价格均已清理，三个渠道及两个插件保持禁用。详情见 `UPSTREAMS.md`。

## 域名

Cloudflare 账户：`d9203440125f1b112668d39a5efd64c9`。

Zone：`d4a1f8cdf4b9be64d85c24436ce5725d`。

Nameserver：`fish.ns.cloudflare.com` 和 `trace.ns.cloudflare.com`。

www 的橙云 CNAME 目标：`253ffdd8-e7b9-4a24-b6b2-d7e4d562a65b.cfargotunnel.com`。

Spaceship 名称服务器已切换，Cloudflare 域名已激活，www 橙云记录已创建。旧 DNSSEC 已替换为下列 Cloudflare DS；2026-10-01 已在 Spaceship 保存成功，公共解析器 DS 查询返回 AD=true，DNSSEC 验证通过。不要重新启用旧 Spaceship DNSSEC。

```text
piknoai.com. 3600 IN DS 2371 13 2 572B312D6E6F79E089D1FA7004434E90D0E44206D4238838B64EEB59A490A870
```

已开启 Cloudflare“始终使用 HTTPS”，不启用 HSTS 预加载。根域已有的两条 A 记录保留未改动；`api.piknoai.com` 记录已删除，当前仅以 www 作为中转站入口。

## 验收

```powershell
Invoke-RestMethod http://127.0.0.1:3100/api/status
Invoke-RestMethod https://www.piknoai.com/api/status
```

2026-10-01 已通过：公网有效 TLS、`/api/status` 返回 200 且 setup=true、管理员 HTTPS 登录和携带凭证访问 `/api/user/self` 成功、登录 Cookie 带 Secure、未带身份访问 `/v1/models` 和 `/api/option/` 均返回 401、HTTP 登录页 301 跳转 HTTPS、cloudflared 容器重启后公网健康检查恢复 200。另通过公网入口完成 Packy Flare 文生图和图生图各一次，均 HTTP 200，约 22 秒和 60 秒；临时令牌和内部测试价格均已清理。未做整机或整个 Docker Desktop 重启测试，未进行视频收费调用。

2026-10-03 已完成 ECS 冻结迁移与最终切换：New API、PostgreSQL、Redis、cloudflared 均健康；用户 1、渠道 1、配置 25、消费日志 2、任务 0 与冻结源库一致；www 的公网 TLS 和 `/api/status` 返回 200；旧 api DNS 已删除。公开注册、Packy 渠道及两个视频插件仍保持关闭。

2026-10-04 已完成客户邮件链路：`mail.piknoai.com` 在 Resend 验证通过，生产发送密钥仅授权该域，New API 通过 465 隐式 TLS 发信；真实邮箱验证邮件投递状态为 Delivered。验收后 `/api/status` 仍显示 `register_enabled=false`、`password_register_enabled=false`、`email_verification=false`。

同日完成首轮视频上游验收：建立渠道 2（三宝）和渠道 3（CanSeeDream）；修复 CanSeeDream API 源站重定向和任务插件 Bearer Header 两处问题。三宝任务成功且结果为可读取的 MP4；CanSeeDream 链路可到达上游但生成池未成功出片。生产最终状态为渠道禁用、插件禁用、`RetryTimes=0`、任务插件价格 `{}`、一次性测试令牌 0；正式零售价格和客户分组确认前不开放。

同日完成 Cloudflare Turnstile 生产门禁：Managed 模式仅允许 `www.piknoai.com`，初始密钥已主动轮换；无效令牌探针被 Cloudflare 正确拒绝，浏览器连续两次完成挑战后均进入账号鉴权而非 Turnstile 错误。公开状态显示 `turnstile_check=true`。紧急回退脚本已部署但未触发。用户协议和隐私政策仅保存为草案，待运营主体、退款、数据留存和争议解决信息确认后再发布。

管理员密码重置闭环同日验收：`piknoadmin` 绑定独立找回邮箱后，站点通过 Turnstile 接受重置请求；Resend 显示邮件 Delivered；一次性链接成功消费并更换密码；本机与 ECS 受限凭证同步完成，生产 Argon2id 哈希校验匹配；使用新密码再次通过 Turnstile 后成功进入 `/dashboard/overview`。重置链接、令牌、密码和密码哈希均未写入普通日志或文档。

备份至少包含 PostgreSQL 数据、New API 的 `/data` 卷以及加密保存的私有凭证。不要使用 `docker compose down -v`，该命令会删除持久化数据。
