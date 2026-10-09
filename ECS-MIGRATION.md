# 香港 ECS 迁移进度

更新日期：2026-10-03。目标：8.217.68.247；最终对外域名：www.piknoai.com。

## 最终状态（2026-10-03）

- 旧 `_PIKNO.pem` 密钥可用；本机网络需通过 `127.0.0.1:10808` SOCKS5 代理建立 SSH，并严格校验已记录的 ECS 主机公钥。
- 已冻结源站并生成最终归档 `cutover-20261003-032749.tar.gz`，SHA256 为 `d3a5f28e34e02aea0ed0c773c297ea7a309dc26bb49ab42d26940790b6711fef`；清单及归档哈希均验证通过。
- 已在 `/opt/piknoai-relay/current` 完成恢复。New API、PostgreSQL、Redis、cloudflared 均健康且 cloudflared 重启次数为 0；用户 1、渠道 1、配置 25、消费日志 2、任务 0，与冻结源库一致。
- New API 的站点地址和 Passkey Origin 已切换为 `https://www.piknoai.com`。公网首页及 `/api/status` 均为 HTTP 200，版本为 `v1.0.0-rc.41`。
- Cloudflare Tunnel 仅保留 `www.piknoai.com -> http://new-api:3000` 和 404 兜底；www 橙云记录已建立，旧 `api.piknoai.com` DNS 记录已删除，根域两条 A 记录未改动。
- 本机旧应用与 Tunnel 已停止，最终停机快照保留。公开注册、Packy 图片渠道、三宝与 CanSeeDream 视频插件继续保持关闭，未开放充值或客户销售。
- cloudflared 镜像以 UID/GID 65532 运行；恢复脚本已将文件型 Tunnel Token 设置为该用户所有、权限 0400，防止 Linux 上因权限不足反复重启。
- 实例仍为 2 vCPU / 4 GiB / 5 Mbps。当前闭门测试可用，但“每账户图片 100、视频 10 并发”尚未做容量与上游限额验收，不能视为已承载该目标。

以下内容保留为迁移过程的历史记录；其中“阻碍”和“待执行步骤”均已解决或完成。

## 已完成

- 已读取用户填写的《PIKNO 客户版产品与计费设计》。保持原有 PIKNO 应用、账户、余额和密钥不迁移。
- 用户明确每账户并发目标：图片 100、视频 10。已更新设计稿；尚未配置或通过容量验收。
- 本机 Docker 启动恢复，现有 New API、PostgreSQL、Redis、Tunnel 服务恢复运行。
- 编写并执行 `backup-migration.cjs`，备份受 Windows ACL 限制，仅当前用户与 SYSTEM 可访问。
- 备份包含 PostgreSQL custom dump、New API `/data`、原 Compose 文件及必要私有配置，不复制 Redis 缓存。
- 备份路径：`private/migration/2026-10-02T06-54-41-287Z/`。这是在线准备快照，正式切换前仍需停止写入并再次备份。
- PostgreSQL dump 在隔离、无网络、临时内存盘的 PostgreSQL 16 容器中完整恢复成功；用户 1、渠道 1、配置 25、消费日志 2，与源库计数一致。临时容器已删除，源库和备份未删除。
- 新增目标机专用 `compose.ecs.yaml`，设置 www 的 Secure Cookie 和容器日志轮转；尚未应用到目标机。
- 浏览器连接已恢复，已通过阿里云云助手以 root 执行只读检查。实际实例 `i-j6c80i2hwzboz7js1e3l`：香港 D 区、Ubuntu 26.04、2 vCPU / 4 GiB、40 GB 系统盘、5 Mbps 公网带宽。不是最初讨论的 4 核 8 GB / 10 Mbps，未擅自升级规格。
- 已核对公网 IP、绑定的 PIKNO 密钥对及安全组；sshd 监听 `0.0.0.0:22`，公钥登录开启、密码登录关闭。UFW 未启用，iptables 默认 ACCEPT，未改动 SSH 或防火墙。
- 2026-10-02 15:30 抓包确认：本机 TCP SYN 到达 ECS，ECS 发出 SYN-ACK，但连接未完成握手。不能将问题归因为私钥、用户名或未放行入站 22；返回路径/本机接收端仍待排查。
- 已新增不含秘密的 `bootstrap-ecs.sh`，通过已登录的云助手使用 Docker 官方软件源安装。2026-10-02 15:37:46 执行成功：Docker 服务 active、hello-world 容器通过、返回 `PIKNO_DOCKER_BOOTSTRAP_OK`。脚本另通过本地 `bash -n` 语法检查。
- 已建立 root 专属 `/opt/piknoai-relay`（0700）；2026-10-02 15:43:55，与源站相同 digest 的 New API、PostgreSQL、Redis、cloudflared 四个镜像全部拉取成功，返回 `PIKNO_IMAGES_READY`。尚未恢复业务库或启动对外隧道。
- 后续只读验证确认 Docker Engine `29.8.2`、Compose `v5.5.1`、部署目录权限为 `700 root`。通过已认证控制台读取主机 ED25519 公钥并保存为专用 `ecs_known_hosts`，指纹 `SHA256:IqtjIIHOc9kQfDvEbrTBgzzoYUTp9K40sP583XRr44c`；后续 SSH 使用严格校验，不跳过主机身份检查。

## 历史阻碍（已解决）

1. `8.217.68.247:22` 多次 TCP 连接超时，包括独立 Node socket 检查；尚未到达 SSH 握手，不能据此判断私钥或用户名是否有效。
2. 入站安全组及实例内 SSH 已检查，握手回程问题尚未解决；已请用户方便时切换手机热点复测。
3. 本机系统 HTTP 代理为 `127.0.0.1:10090`，代理 CONNECT 虽返回 200，但没有取得 SSH banner，不视为连接成功。

截至本记录：已通过云助手操作 ECS 并发起运行环境安装；没有 SSH 登录，没有复制私钥或业务密钥到服务器，没有切换 DNS，没有开放注册或收款。

本轮最后复查：本机四个容器正常，公网 `api.piknoai.com/api/status` 为 HTTP 200，注册关闭、Packy 渠道禁用。使用固定主机公钥严格校验重试 SSH 仍在 TCP 阶段超时。迁移停在安全传输步骤，待网络切换后复测；不在云助手命令历史中粘贴明文业务凭证。

## Workbench 迁移尝试与回滚（2026-10-02）

- 用户打开 SSH 类型 Workbench root 会话。第一次文件管理提示会话过期；重新连接后目录可展开。
- 无密钥的 `compose.ecs.yaml` 上传至 `/opt/piknoai-relay`，Workbench 显示 630 B 上传成功。上传控件是临时 detached file input，需使用 `Page.fileChooserOpened` 实际返回的 backendNodeId，不能使用页面上另一个 `name=upload` input。
- `backup-migration.cjs --freeze` 检查注册关闭、渠道禁用、tasks 表为 0，停止本机 cloudflared/new-api 后生成冻结快照 `private/migration/2026-10-02T08-46-14-963Z/`，9 个文件、213293 字节，归档结构校验通过。
- 打包为受限目录内 `private/migration/cutover-20261002-084614.tar.gz`，SHA256 `3c0221da097f5b64217b68859698d43cd8d31742ac9f80e06be82e0037493068`。使用 Workbench 文件上传，不把业务凭证写入终端或云助手命令历史。
- 续接后的 Workbench 终端显示另一会话，但文件上传返回 OSS `NoSuchKey`，刷新目标目录再次显示 `Session has expired, please login again`。备份未确认落盘；未执行解压或恢复，不能宣称已迁移。
- 遵循浏览器技能在认证失效时停止文件操作，恢复本机全部四个容器且健康检查通过。该冻结快照现已不再是下一次切换的最终快照；重新迁移前必须再次冻结并备份，更新恢复脚本中的归档名称与哈希。
- 已创建未执行的 `restore-ecs.sh`，包含归档/清单校验、拒绝覆盖既有部署或卷、私有文件权限、数据库恢复和服务验证；本地 `bash -n` 通过。该脚本不连接公网 Tunnel。
- 本机 SSH 复测仍在 TCP 阶段超时，尚未验证密钥登录。DNS、客户注册、价格和支付保持未更改。

## 执行顺序（已完成）

1. 只读盘点目标主机 OS、CPU、内存、磁盘、现有容器/监听端口、时间与更新状态；保留未知既有服务。
2. 记录 SSH 主机身份；安装/核对 Docker 与 Compose，创建独立部署目录。
3. 迁移所需私有配置与备份，限制目标权限；保留现有 CRYPTO_SECRET，不能重新生成已有渠道的加密密钥。
4. 先启动独立数据库并恢复，然后启动应用和空 Redis 缓存，检查管理员、渠道与插件。
5. 在本机通过 SSH 转发进行验收；目标检查通过前不连接生产 Tunnel，不允许两个拥有独立数据库的源站同时接收同一业务流量。
6. 核对正确 Cloudflare 账户，以 www 为最终入口配置隧道/DNS、站点地址、Cookie 与相关回调。切换计划须有回滚路径。
7. 保持注册和未定价渠道关闭；完成邮件、支付与已批准售价配置后，再做客户闭环验收。

## 业务配置未决项

- 分组是否采用、图片/视频售价、允许参数组合仍未填写，不自动套用旧应用价格。
- 支付宝商户服务尚未开通；最低自定义充值金额未定。固定档位已选 50/100/200/500。
- 发信服务尚未开通；要实现验证码登录与通知，需真实可用的事务邮件配置。
- 内容审核拒绝且上游扣费时由客户承担，是用户指定规则；与插件失败自动退款行为存在差异，需验证/适配，不能声称已实现。
- 每账户并发数不是每分钟请求数；不得用 RPM 参数冒充并发控制。全站上限与上游限额仍需制定。
- 请求元数据 7 天与财务账本留存是不同范围；不直接用删除消费日志替代元数据清理。
- 无长期媒体保存需求，但异步视频仍需要最小任务状态与计费事实，不等于可以删除在途任务。
