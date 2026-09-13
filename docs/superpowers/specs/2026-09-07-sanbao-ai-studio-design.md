# 仓鼠AI（Hamster AI）设计文档 — 图片/视频生成本地客户端

- 日期：2026-09-07
- 状态：已评审待实现

## 1. 目标与范围

复刻 [sanbaobeauty.com](https://sanbaobeauty.com/) 的**图片生成**与**视频生成**能力，做成一个本地运行的应用，产品定名**「仓鼠AI」（Hamster AI）**：用户填入自己的 API Key 后即可直接调用三宝影像工坊 OpenAPI 生成图片/视频。

**品牌：** 应用名「仓鼠AI」，logo 使用「仓」字标记，主色调暖橙（仓鼠主题）；后端服务仍对接 sanbaobeauty 三宝影像工坊 OpenAPI。

**范围内：**
- 图片生成 + 视频生成（提示词、参考素材上传、模型/规格选择、并发、积分预估、任务进度、结果预览与下载）
- 模型库浏览（拉取在线模型列表）
- 账户余额查询
- 本地任务历史持久化

**范围外（v1 不做）：**
- 原站账户系统（登录/注册、验证码、充值、订单、邀请返佣）
- 故事工作台 / 资产库 / 画布 / Agent / 音频生成 / 编辑 / 分析 / 分镜
- `@图片1` 对象引用标签、多账号切换、PC 端安装包

## 2. 关键约束

实测结论：sanbaobeauty OpenAPI **不支持浏览器 CORS**（`OPTIONS` 预检返回 404「接口不存在」，响应无 `Access-Control-Allow-Origin`）。因此**纯前端单文件直连不可行**，必须由本地服务转发或桌面壳落地。本项目采用**本地服务转发**。

## 3. 架构

**零依赖 Node.js 本地服务 + 浏览器单页应用（SPA）。**

```
浏览器 SPA (public/)
   │  fetch('/api/...', {Authorization: Bearer <key>, body})
   ▼
server.js  (Node 内置 http/fs/fetch，零依赖)
   │  原样转发 header + body
   ▼
https://sanbaobeauty.com/openapi/v1/...
```

- `server.js` 只做两件事：托管 `public/` 静态文件；把 `/api/<rest>` 的请求原样代理到 `https://sanbaobeauty.com/openapi/v1/<rest>`（透传 `Authorization` / `Content-Type` / 请求体，回传状态码与响应体）。
- 启动即监听本地端口并自动打开浏览器。
- API Key 只存在浏览器 `localStorage`，仅发往 sanbaobeauty 本家，服务端不落盘、不记录。

## 4. OpenAPI 摘要（照搬自 docs.html）

基地址 `https://sanbaobeauty.com`，鉴权 `Authorization: Bearer sk_sanbao_xxx`（或 `X-API-Key`）。

| 端点 | 说明 |
|---|---|
| `GET /openapi/v1/me` | 查询账号（余额/积分） |
| `GET /openapi/v1/models` | 查询当前可用模型（需鉴权，`data` 数组） |
| `POST /openapi/v1/uploads/raw?kind=&fileName=` | 上传素材，请求体为**原始二进制**，按文件类型设 `Content-Type`；返回 `{file:{url,kind,contentType,size}}` |
| `POST /openapi/v1/videos` | 创建视频任务（异步，带 `Idempotency-Key` 幂等键） |
| `POST /openapi/v1/images` | 创建图片任务（异步） |
| `GET /openapi/v1/videos/{taskId}` | 查询视频任务 |
| `GET /openapi/v1/images/{taskId}` | 查询图片任务 |

### 视频创建请求体
```json
{"model":"sd2_9img_full_fast_line","prompt":"...","ratio":"9:16","resolution":"720p",
 "duration":5,"concurrency":1,"reference":"all","images":[],"videos":[],"audios":[]}
```
- `reference`：`all` 全能参考 / `startEnd` 首尾帧 / `face` 人物一致
- `images/videos/audios`：字符串 URL 数组（或 `{tag,url}` 对象数组）
- `concurrency`：1 / 2 / 4
- 成功返回 `201`；同幂等键重复请求返回 `200` 且 `deduplicated:true`。`id`=`task_id`=`taskId`。`data` 为首个任务，`tasks` 为全部任务（`concurrency>1` 时逐条跟踪 `tasks[].task_id`）。

### 图片创建请求体
```json
{"model":"gpt-image2","prompt":"...","aspect_ratio":"16:9","images":["https://..."],
 "quality":"high","concurrency":1}
```
- `aspect_ratio`：比例名（如 `16:9`）或模型支持的具体尺寸值
- `quality`：`high` / `medium` / `low`

### 查询响应关键字段
`data.status` ∈ `queued|processing|succeeded|failed`；`progress`(0–100)；成功后 `video_url` / `download_url` / `image_url`；`cost`；`link_expires_in`（约 24h 签名直链）；失败时 `error` 字段。

### 错误码
400 参数错误 · 401 Key 缺失/无效 · 402 余额不足 · 403 账号受限 · 413 文件过大 · 429 频繁 · 502 模型服务异常。

## 5. 模型数据结构（照搬 GET /models 返回）

**视频模型关键字段：** `id` `name` `description` `type=video` `billing`(`per_second`|`per_generation`) `resolutions[]` `ratios[]` `durations[]`(秒) `default_resolution` `default_ratio` `default_duration_seconds` `max_images/min_images` `max_videos` `max_audios` `max_media_files` `max_image_size_mb` `max_video_size_mb` `max_audio_size_mb` `price_credits` `price_by_resolution_credits{}` `price_per_second_by_resolution_credits{}` `concurrency_options[1,2,4]` `supports_real_person` `media_inputs[]`。

**图片模型关键字段：** `id` `name` `description` `type=image` `aspect_ratios[]`(比例名) `aspect_ratio_values{}`(比例→尺寸) `quality_options[high,medium,low]` `max_images` `max_media_files` `max_image_size_mb` `price_credits` `billing=per_generation` `concurrency_options`。

（当前在线 18 个模型：14 视频 + 4 图片 gpt-image2 系列。）

## 6. 前端视图与交互

左侧竖排导航，4 个视图：

1. **生成（主界面）** —— 1:1 复刻原站 composer：
   - 提示词 `<textarea>`（maxlength 6000，占位「今天我们要创作什么」）+ 展开全屏编辑
   - 素材托盘：图片/视频/音频三个上传格（`accept` 分别限定），上传后缩略图列表、可删除
   - 工具条：类型切换（视频生成/图片生成）、模型选择、参考方式（仅视频：全能参考/首尾帧/人物一致）、规格（视频=比例·画质·时长；图片=比例·质量）、并发（1x/2x/4x）、⚡积分预估
   - 发送按钮 → 生成任务流
   - 任务流：每任务显示状态、进度条，成功后展示视频/图片预览 + 下载按钮
2. **模型库** —— 卡片网格 + 表格展示全部模型（名称/id/类型/说明/画质/比例/时长/计费/素材限制）
3. **历史** —— localStorage 持久化任务记录，回看与重新下载
4. **账户** —— API Key 输入（存 localStorage）、⚡余额、连接测试

**规格控件随类型自适应：** 视频显示 `ratio/resolution/duration/reference`；图片显示 `aspect_ratio/quality`，参考素材仅图片。切换模型时规格选项按该模型可用值重置。

**积分预估公式**（照搬 docs 页 `estimateExampleCost` 逻辑）：
- 视频按次计费：`price_by_resolution_credits[resolution] ?? price_credits`
- 视频按秒计费：`price_per_second_by_resolution_credits[resolution] ?? price_per_second_credits ?? price_credits`，再 × `duration`
- 图片按次计费：`price_credits`
- `concurrency>1` 时按任务数累乘。

## 7. 数据流

1. 用户输入 Key → 存 `localStorage` → 调 `GET /me`（余额）+ `GET /models`（模型列表，失败提示 Key 无效）
2. 上传素材 → `POST /uploads/raw?kind=&fileName=`（原始二进制，`Content-Type` 按扩展名）→ 存 `file.url`
3. 创建任务 → `POST /videos`（`Idempotency-Key` 用 `crypto.randomUUID()`）/ `POST /images`；`concurrency>1` 解析 `tasks[]` 逐条登记
4. 轮询 `GET /{videos|images}/{taskId}`（每 2–3s，退避）→ 更新进度 → `succeeded` 展示结果 / `failed` 展示 `error`
5. 每任务写入历史（含 status/结果/时间/扣费）

## 8. 错误处理

- 401 → 提示 Key 无效，跳转账户页重填
- 402 → 「积分余额不足」
- 429 → 提示稍后重试（轮询退避）
- 400/413 → 展示服务端错误信息
- 502 → 「模型服务异常，请稍后重试」
- 任务 `failed` → 读取 `error` 字段展示

## 9. 文件结构

```
苏雨的AI/
  server.js        # 零依赖 Node 服务 + 透明代理（/api/* → /openapi/v1/*）
  package.json     # npm start 启动脚本（无依赖）
  README.md        # 使用说明
  public/
    index.html     # SPA 骨架
    styles.css     # 复刻原站视觉风格
    app.js         # 前端逻辑（状态/请求/轮询/历史）
```

## 10. 成功标准

- `node server.js`（或 `npm start`）一条命令启动并自动开浏览器
- 填入真实 API Key 后：能拉取模型列表、查询余额、上传图片/视频/音频素材
- 能成功创建并跑完一个视频任务、一个图片任务，展示结果并可下载
- 无 Key / 错误 Key 时给出清晰提示；余额不足、服务异常均有对应提示
- 任务历史刷新页面后仍保留
