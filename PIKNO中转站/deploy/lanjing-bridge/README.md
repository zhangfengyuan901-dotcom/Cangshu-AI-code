# PIKNO 蓝鲸支付桥接服务

该服务把 New API 的标准易支付请求转换为蓝鲸支付请求，并把蓝鲸异步通知转换回 New API 原生回调。它不直接修改数据库。

## 固定公网地址

- 易支付入口：`https://www.piknoai.com/pay/lanjing/epay`
- 蓝鲸异步回调：`https://www.piknoai.com/pay/lanjing/notify`
- 蓝鲸同步返回：`https://www.piknoai.com/pay/lanjing/return`
- 健康检查：`https://www.piknoai.com/pay/lanjing/health`

Cloudflare Tunnel 必须把 `/pay/lanjing/*` 放在默认 `www.piknoai.com` 规则之前，并转发到 `http://lanjing-bridge:8080`。

## 安全边界

- 双向 MD5 签名按两套协议分别验证；比较采用常量时间。
- 支付跳转页在同源浏览器刷新登录会话，再用短期访问令牌向 New API 反查用户，订单中的用户编号必须匹配。刷新 Cookie 保持原来的路径和浏览器管理方式。
- 订单金额、支付方式、邮箱和返回地址封装在 AES-256-GCM 状态令牌中。
- 回调核验蓝鲸签名，并绑定订单号、应付金额和支付方式；实付金额可能因蓝鲸分单策略产生分级差额，本站按原充值订单入账。
- 充值交给 New API 原生事务处理，重复通知不会重复加款。
- 充值邮件使用固定幂等键；只有余额处理与邮件均成功才向蓝鲸返回 `success`。

## 本地验证

```sh
npm test
```

## 部署状态（2026-10-05）

- ECS 容器、Cloudflare 路由、New API 的 PayAddress/EpayId/EpayKey/PayMethods 已配置。
- 蓝鲸两个收款码与回调地址已从服务端复核；现有通讯密钥与服务器密钥一致。
- New API 支付合规声明已由运营者确认，支付宝/微信充值入口已解锁。
- 安卓监控端已绑定；最新查询在线，蓝鲸最近收款时间已更新。
- 两笔 ¥1 诊断订单已收到通过签名及订单状态核验的真实异步回调，ECS 持久化回执及容器日志均已核实：支付宝 `PIKNOTEST17912035224736d588a` 于北京时间 2026-10-05 20:36:46 收到，微信 `PIKNOTEST1791204430773a2932b` 于 20:47:47 收到。两笔应付与实收均为 ¥1.00，蓝鲸订单状态均为成功。微信同步返回页也已由用户确认。
- 诊断专用回调为 `/pay/lanjing/diagnostic/notify`；回执位于容器 `/data/diagnostics/<订单号>.json`，通过命名卷持久化。诊断订单不增加账户余额、不发送充值成功邮件，不等同于正式充值全链路验收。上述证据不单独证明安卓自动监听成功，仍可能涉及平台补单操作。
- 再次支付宝 ¥1 诊断订单 `PIKNOTEST179120567184996a5a6`：用户报告支付时间为北京时间 2026-10-05 21:10:48，并确认成功返回本站；ECS 持久化回执核实于 21:10:54.787 收到有效异步通知，应付与实收均为 ¥1.00，类型为 alipay，仍为诊断专用、不入账。
- 两笔正式支付宝 ¥7.30 订单 `USR1NO2h6loN1791200263`、`USR1NOdw3Kdp1791202539`，用户反馈已支付；最新蓝鲸订单仍为过期，本站最近一次核验仍 pending、余额增量为 0。需先核对这两笔实际到账及订单匹配，不重复收款、不凭用户支付反馈手工标记成功。
- 正式支付宝订单 `USR1NOW8Z1FA1791206218` 已通过实际入账验收：蓝鲸实收 ¥7.30、状态成功（北京时间 2026-10-05 21:17:55）；New API 订单 success，完成时间 21:17:54；quota 从 92880000 增至 100180000，差额 7300000，对应 ¥7.30。桥接日志记录 `recharge_completed`，表示原生入账及 Resend 发信请求均成功。邮箱最终投递尚未核验：现有 API key 仅有发送权限，Resend 控制台需要重新登录；不得把发送请求成功等同于已送达收件箱。该次基线保存在 `deploy/new-api/private/payment-live-order-retry-20261005-3.json`。
- 前两笔未入账测试单仍保留，尚未删除；其基线保存在 `deploy/new-api/private/payment-live-order.json` 与 `deploy/new-api/private/payment-live-order-retry-20261005-2.json`。
- 运营者随后确认上述正式支付宝充值成功邮件已送达。
- 正式微信订单 `USR1NOoTD39s1791207055` 已完成真实入账测试：蓝鲸状态成功、金额 ¥7.30、类型微信；New API 订单 success，complete_time 为 1791207079；quota 从下单前 100180000 增至 107480000，差额 7300000，对应 ¥7.30。服务器日志存在该订单的 `recharge_completed`，表示 Resend 发信请求成功；微信这笔邮件最终送达仍待收件人确认。
- 用户随后确认上述微信邮件送达。
- 关闭付款页场景尝试：微信订单 `USR1NO67x63K1791207645` 已实际入账 ¥7.30，quota 107480000 → 114780000，订单 success。服务器 `recharge_completed` 时间为北京时间 2026-10-05 21:41:05.128；工具关闭付款页并核实其消失约为 21:41:25，晚于回调完成，故本次不能证明关闭页面期间的异步入账场景通过。本次邮件请求成功，收件人确认待补；没有为重试自动再创建收费订单。

## 运维

关闭付款页测试已通过：微信订单 `USR1NOZ5sYi31791208168` 的付款页于北京时间 2026-10-05 21:49:51 关闭，21:49:53 查询蓝鲸仍为未支付（state 0）；21:51:03.361 服务器记录 `recharge_completed`。付款页未重开，New API 订单 success，quota 从 114780000 增至 122080000，准确入账 ¥7.30。邮件发送请求成功，收件箱送达待用户确认。证据见 `deploy/new-api/private/payment-close-page-test-2-evidence.json`。本次验证不依赖付款页轮询或同步跳转，不能替代超时订单及回调失败重试测试。

本地 `deploy/new-api/configure-payments.cjs tunnel` 保留现有 Tunnel 配置并插入路径规则；`new-api` 模式写入支付参数，不代替运营者确认声明。
服务器桥接目录为 `/opt/piknoai-relay/lanjing-bridge`，Compose 在 `/opt/piknoai-relay/current`，增加 `-f compose.payments.yaml`。四个 secret 使用 UID 1000、权限 0400，外层 private 目录仍为 root 0700。
支付入账成功但邮件失败时向蓝鲸返回失败，由其重试；New API 的数据库幂等事务防止重复入账，Resend 使用订单号幂等键。该机制依赖蓝鲸的重试期限，需要关注失败日志，不能把它视为独立邮件队列。
