# 仓鼠AI中转站

当前生产版本和验证证据读取工作区 `.agents/project-state.json`，不从历史文件名推断线上状态。

- 完整后端源码与测试：`backend/`；修改前读其AGENTS及适用规则。
- 构建入口：`Dockerfile`。构建阶段使用固定摘要的 Go 工具链，从 `backend/` 源码编译，不读取历史发行目录或历史业务镜像。本机构建不会部署生产。
- 前端源码位于中转站根目录的 `build/hamster-trim44-web/`。Docker 构建按锁文件安装依赖，生成静态资源后嵌入 Go 二进制。滚动发布需要兼容旧静态资源时，用 `RETAINED_WEB_IMAGE` 指定包含上一版 `/retained/static/` 的静态资源镜像。
- 当前部署入口读取 state 的 `relay.deployment` 和 `relay.deployment_runner`；部署守卫独立核验运行状态，不依赖历史发布 helper。`operations/` 仅保留仍适用的凭据配置工具及测试。
- 账户/API/SSE经香港ECS直连；素材继续通过独立素材服务。工具控制为ECS单执行者，不能同时启用CF旧执行版。
- 生产保留五层Compose、独立图形挑战Redis DB1；全局Redis账务缓存不擅自启用。部署只应用已验证必要差异，核验环境、schema、账务、渠道、价格、unknown与其他容器。
- 私有凭据、数据库及恢复点按原受限位置保存。禁止重置运营密钥、恢复旧财务或使用 `down -v`。回退只按既定镜像策略执行，不自动回滚财务。

真实生成、付款、登录或邮件验证与离线测试分别记录。旧Tunnel、旧注册开关和旧渠道状态不作为当前配置依据。

从中转站根目录运行 `docker build --target build -f deploy/new-api/Dockerfile -t hamster-current-backend-check:local .` 检查前端生成和后端编译。完整运行镜像默认使用固定摘要的基础镜像。生产补丁构建可通过 `--build-arg RUNTIME_IMAGE=...` 指定已核验的运行底座。
