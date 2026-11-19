# PIKNO 客户闭环第一阶段

状态日期：2026-10-04。生产入口：`https://www.piknoai.com`。

## 当前结果

- Resend 发送域 `mail.piknoai.com` 已验证，区域为东京 `ap-northeast-1`。
- Cloudflare 已配置 DKIM、两条仅 DNS 的发送 CNAME，以及 `_dmarc.piknoai.com` 的 `p=none` 监控策略；未启用 Resend 入站收件 MX。
- 生产 API Key 为 Sending access，并限制为只能从 `mail.piknoai.com` 发信；密钥仅存在于受限私有配置。
- New API 已使用 `smtp.resend.com:465`、隐式 TLS、证书校验开启，发件人为 `notify@mail.piknoai.com`。
- 已向受控 QQ 邮箱真实发送一封“PIKNO AI邮箱验证邮件”，New API 返回成功，Resend 状态为 Delivered。
- Cloudflare Turnstile 已按 `www.piknoai.com` 单域名、Managed 模式接入；创建时显示过的初始密钥已主动轮换，生产使用轮换后的密钥。
- Turnstile 服务端密钥已通过 Cloudflare `siteverify` 探针验证；生产强制校验已开启，并连续完成两次浏览器登录验证，两次都通过人机校验到达账号鉴权层。
- `piknoadmin` 已绑定独立管理员找回邮箱；真实密码重置邮件经 Resend 投递为 Delivered，十分钟有效的一次性链接已成功消费。
- 重置生成的新密码已写入本机和 ECS 的受限管理员凭证，且与生产数据库 Argon2id 哈希一致；随后重新通过 Turnstile 登录并成功进入管理控制台。
- 验收后再次确认：公开注册关闭、密码注册关闭、邮箱验证开关关闭；新用户、邀请人和受邀人赠送额度均为 0。邮件与人机验证能力已接通，但不会提前开放注册。
- 上游真实验收已进入计费前收口：Packy 图片的文生图、图生图均通过；三宝 `sanbao/sd2_480p_real` 的 4 秒 480p 视频通过；CanSeeDream 已接通鉴权、提交、查询和失败退款，但尚无成功视频，继续保持客户不可用。
- 下一实施板块为 `CUSTOMER-PRICING-GROUPS.md`：确认首期商品、分组和人民币零售价后，再配置测试价格并验收客户计费闭环。价格确认前不启用任何上游渠道。
- 2026-10-04 已确认 Flare 文生图和图生图均为 ¥0.10/张输出，图生图产品上限为 5 张参考图；当前只验收过 1 张参考图，2–5 张在补验收前不开放。默认上游成本映射规则为人民币成本 × 2。
- 三宝 `sd2_480p_real` 实时目录为 30 积分 = ¥3/次，因此 2 倍零售价草案为 ¥6/次；客户商品名已确认为“PIKNO 视频标准 480P”。首期范围已确认为图片加三宝视频；所有价格继续保持未发布，等待计费闭环验收。

## 本阶段范围

1. 使用 `mail.piknoai.com` 作为独立事务邮件发送域，避免与官网和未来营销邮件混用。
2. 通过 Resend SMTP 为 New API 接通注册验证码与密码重置邮件；使用 465 隐式 TLS，禁止跳过证书校验。
3. 发件地址暂定 `PIKNO AI <notify@mail.piknoai.com>`，邮件正文提供客服邮箱 `1060761161@qq.com`。
4. DNS 验证和测试邮件成功前，保持 `RegisterEnabled=false`、`PasswordRegisterEnabled=false`、`EmailVerificationEnabled=false`。
5. Cloudflare Turnstile 已完成；用户协议、隐私政策及充值退款规则仍需运营主体确认。这些上线门禁全部通过后，才进入邀请注册。

## 已确认可复用的 New API 能力

- 邮箱验证码注册、密码登录、密码重置。
- 每个账户的钱包配额、客户令牌、令牌分组、模型白名单、过期与额度限制。
- 消费日志、充值记录、管理员补单以及余额不足通知。

## 需要补充的能力

- New API 注册仍要求用户名，不能原生做到“只填邮箱”；首期可由界面按邮箱生成用户名，服务端仍保留唯一用户名。
- 邮箱验证码只能用于注册/绑定，不能原生作为免密登录。免密登录放到注册闭环稳定后实现。
- New API 没有“充值到账必发邮件”的完整事务型 Outbox。支付接入时需要把入账和通知事件写入同一事务，再由独立发送器重试；邮件失败不能重复入账。
- Resend 的 bounce/complaint Webhook、事件去重和抑制名单需要独立接收端，不能只依赖 SMTP 成功返回。

## 上线门禁

- Resend 域名状态 verified，SPF 与 DKIM 公网解析通过；DMARC 先以监控策略上线。
- 生产 API Key 仅允许 `mail.piknoai.com` 发送，保存在 ECS 私有配置，不进入浏览器、仓库或命令历史。
- 注册验证码和管理员密码重置均已完成真实投递测试，密码重置链接、凭证落盘与新密码登录均已验收。
- Turnstile 在注册、登录、验证码与密码重置入口生效。已验证登录入口的连续两次挑战刷新与服务端校验。
- 新用户额度为 0，所有未定价渠道关闭。
- 用户协议、隐私政策、退款与余额规则可从注册页访问；当前仅有未发布草案，等待运营主体、退款、留存和争议解决信息。
- 邀请内测验收完成后，才允许公开邮箱注册。

## 操作文件

- `resend.example.json`：不含秘密的配置结构示例。
- `private/resend.json`：本机受限私有配置，不得提交或分发。
- `configure-resend-smtp.cjs`：写入 SMTP 设置，但在注册已开放时拒绝执行。
- `test-resend-smtp.cjs`：注册关闭状态下发送一次真实验证码邮件。
- `complete-admin-password-reset.cjs`：从标准输入接收一次性链接，校验域名、路径、邮箱和令牌形状，消费链接并安全更新受限凭证；不会打印密码或令牌。
- `verify-admin-password-hash.cjs`：用生产 Argon2id 哈希验证受限凭证内容，不输出哈希或密码。
- `private/turnstile.json`：轮换后的生产 Turnstile 密钥，本机和 ECS 均受限保存。
- `configure-turnstile.cjs`：验证 Cloudflare 密钥并分阶段写入配置，不会开启强制校验。
- `enable-turnstile.cjs`：在注册仍关闭时开启强制校验并复核公开状态。
- `break-glass-disable-turnstile.sh`：需显式确认参数的 ECS 紧急回退脚本。
- `legal/LEGAL-INPUTS.md`：法律页面发布前必须由运营者完成的输入清单。
- `legal/*.draft.md`：用户协议与隐私政策未发布草案。
- `publish-legal.cjs`：只接受无草案标记的最终文件，并要求显式发布确认；注册开放时拒绝运行。
- `CUSTOMER-PRICING-GROUPS.md`：首期分组、商品参数和人民币零售价的最小确认表；空价组合默认拒绝。
- `pricing.draft.json`：机器可读的未发布价格草案；`customerReleaseApproved=false` 且每个商品 `published=false`，不能直接作为上线授权。
- `stage-first-release-pricing.cjs`：注册关闭、渠道禁用且无自动重试时，分阶段写入 CNY 配额基准、客户分组和首期价格；失败会尝试恢复原选项，成功后渠道仍保持禁用。

脚本默认连接 `http://127.0.0.1:3100`。从运维机通过 SSH 隧道操作 ECS 时，可设置 `NEW_API_BASE=http://127.0.0.1:<本地转发端口>`；无需在 ECS 宿主机安装 Node。
