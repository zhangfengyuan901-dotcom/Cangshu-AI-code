# PIKNO API 接入说明

本文说明 仓鼠AI 客户接口。可用线路、参数组合和价格以当前已发布目录及账户权限为准；文档示例不表示该线路一定向当前账户开放。

## 1. 开通与鉴权

在 https://www.piknoai.com 注册、验证邮箱并登录，充值后创建 API Key。分别创建下列三个分组的 Key，并填写到应用对应位置：

| 用途 | Key 分组 |
| --- | --- |
| 图片生成与编辑 | `image-standard` |
| 视频生成 | `video-standard` |
| 数字人与黑白深度视频 | `tool-standard` |

每个 Key 只能调用其分组内已开放且有权限的线路。创建工具 Key 不会自动开放工具线路。可为 Key 设置额度限额、到期时间和模型限制。

统一域名：`https://www.piknoai.com`。兼容客户端要求 Base URL 时填写 `https://www.piknoai.com/v1`，不要重复拼接 `/v1`。

所有 API 请求携带 `Authorization: Bearer <PIKNO_API_KEY>`。只使用本站客户 Key，不使用管理员登录令牌或密码。请在自己的服务器环境变量中保存 Key，切勿放到网页前端或公开仓库。

`GET /v1/models` 查询 Key 当前可用模型；`GET /api/pikno/catalog` 查询已发布线路的能力及客户价格。`GET /v1/client/context` 仅返回当前 Key 的账户标识和分组，可用于核对三个 Key 是否属于同一账户。没有开放线路时应提示不可用，不应自动改用其他线路。使用返回的 仓鼠AI 模型 ID，不要根据展示名称猜测 ID。

## 2. 图片

文生图：`POST /v1/images/generations`，JSON 示例：

```json
{"model":"pikno-image-flare","prompt":"白色背景中的蓝色陶瓷杯","n":1,"size":"1024x1024","quality":"high","response_format":"url"}
```

图生图：使用 `POST /v1/images/edits`，以 `multipart/form-data` 发送原始图片文件，并携带 `X-Pikno-Media-Transport: direct-v1`。单张文件字段为 `image`，多张为重复的 `image[]`；数量受当前线路限制，最多20张。单文件支持 PNG/JPEG/WebP，最大30 MiB。不要把生图参考图片先传入视频素材存储，也不要将签名 URL 放进 JSON `images` 字段。

以下为接入代码示例，网页不会执行。运行会提交收费生成请求；先查询当前模型规格与有效报价。

```sh
curl https://www.piknoai.com/v1/images/edits \
  -H "Authorization: Bearer $PIKNO_API_KEY" \
  -H 'X-Pikno-Media-Transport: direct-v1' \
  -F 'model=<当前图片Key可用的模型ID>' \
  -F 'prompt=将杯子改为蓝色' \
  -F 'n=1' -F 'size=1024x1024' -F 'quality=high' \
  -F 'output_format=png' \
  -F 'image=@reference.png;type=image/png'
```

图片生成与编辑均建议携带 `X-Pikno-Media-Transport: direct-v1`。每个请求仅允许 `n=1`；尺寸、质量和输出格式仍须符合当前线路。结果可能通过 `data[].url` 或 `data[].b64_json` 返回，应按实际字段读取并在自己的服务端保存，不保证可从任务历史重新取回即时图片内容。

`size` 和 `quality` 必须来自当前线路支持的选项；不同尺寸、质量和参考素材可能影响报价。每个请求仅生成一张图片。

可执行 Node.js 示例见同目录 `examples/media-edit.mjs`。该示例使用一张本地参考图片，并采用不带报价头的兼容调用；它不是报价确认示例。运行会提交收费任务，运行前必须核对当前已发布目录的价格、尺寸、质量和参考图片限制。需要固定本次已确认报价时，请按第 4 节先获取报价并携带报价头。

## 2.1 视频参考素材与工具素材

**视频生成的参考素材**使用三步上传：

1. 携带视频 Key，`POST /v1/media/uploads`，JSON为 `{"content_type":"image/png","size":12345}`；大小必须为真实字节数。
2. 向返回的 `upload_url` 发起PUT，使用返回的上传凭证和请求头，正文为文件原始字节。此步骤不携带客户 API Key。
3. 携带原视频 Key，`POST /v1/media/complete`，提交 `{"upload_ticket":"<步骤1返回值>"}`，再将完成响应的签名 `url` 用于视频请求。

**数字人和黑白深度工具的素材**使用 `POST /v1/media/direct-uploads`：携带工具 Key，以真实 `Content-Type`、`Content-Length` 和原始二进制正文上传。读取返回的 `file.url` 或 `url`，并保留 `expires_at`。工具素材不经过上述视频上传流程，也不能用于视频生成。

图片参考文件上限30 MiB；视频或音频文件上限50 MiB。可用格式、数量和时长还受具体线路限制。素材授权绑定账户、类型和期限，过期后重新选择并上传；不要将签名地址作为永久素材地址或写入公开日志。图片编辑采用上一节的原文件multipart流程。

普通JSON生成请求受64 KiB正文限制；图片编辑multipart另按原始文件数量与大小限制处理。上传遇到429时等待后再处理；生成提交响应未知时先核对原任务，不自动重发。

## 3. 统一视频与工具接口

### 视频

创建：`POST /v1/videos`。仅支持 JSON，不支持 multipart、SDK 文件上传、单请求批量、remix、取消或 webhook 通知。这是 仓鼠AI 的统一视频协议子集，不承诺完全兼容任何 SDK。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| model | string | 当前 Key 可用的本站模型 ID，例如 pikno-video-cs-aggc |
| prompt | string | 非空提示词，长度受所选线路限制 |
| seconds | integer/string | 显式视频秒数；允许整数字符串，如 "4"；必须符合线路时长范围 |
| resolution | string | 显式清晰度，如 720p；必须为线路支持值 |
| aspect_ratio | string | 画面比例，如 16:9；必须为线路支持值 |
| image_urls | array | 可选参考图片；使用本站同账户完成上传的签名 URL，数量受线路限制 |
| video_urls/audio_urls | array | 仅所选线路支持时可用，必须使用本站同账户对应类型的签名 URL；要求素材时长信息的线路使用 `{url,durationSeconds}` 对象 |
| generate_audio | boolean | 仅所选线路明确支持时可用；不支持的线路会拒绝此参数 |

未知字段会被拒绝，包括 `duration`、`metadata`、`size`、`callback_url`、`n`。每个请求只生成一个视频。请先核对线路支持的清晰度、比例、时长及参考素材类型。

Shell 示例（令牌保存在环境变量 PIKNO_API_KEY；本调用会提交收费任务）：

```sh
curl https://www.piknoai.com/v1/videos \
  -H "Authorization: Bearer $PIKNO_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"pikno-video-cs-aggc","prompt":"日出时的平静海面，固定镜头，无文字","seconds":4,"resolution":"720p","aspect_ratio":"16:9"}'
```

受理响应示例（任务 ID 和时间仅为占位值）：

```json
{"id":"task_EXAMPLE","object":"video","model":"pikno-video-cs-aggc","status":"queued","progress":0,"created_at":1791438204}
```

### 数字人与黑白深度视频

工具请求使用 `tool-standard` Key：

| 功能 | 创建接口 | 本站模型 ID |
| --- | --- | --- |
| 数字人 | `POST /v1/tools/digital` | `pikno-tool-digital` |
| 黑白深度视频 | `POST /v1/tools/depth` | `pikno-tool-depth` |

工具接口使用 JSON 和本站工具直传接口返回的素材链接。数字人需要一张图片和一段音频；黑白深度视频需要一段视频。素材限制和可用状态以当前线路能力为准。工具 Key、线路权限和可用素材缺一不可。

数字人请求体示例（`durationSeconds` 为音频实际秒数；示例会提交收费任务）：

```json
{"model":"pikno-tool-digital","images":[{"url":"<工具直传返回的图片url>"}],"audios":[{"url":"<工具直传返回的音频url>","durationSeconds":5}]}
```

黑白深度视频请求体示例：

```json
{"model":"pikno-tool-depth","videos":[{"url":"<工具直传返回的视频url>"}]}
```

### 查询与结果

保存创建响应的本站 `id`。每 5–10 秒调用 `GET /v1/videos/{id}`，携带同账户有效 Key。视频及上述工具使用此接口查询。HTTP 200 或返回 ID 只表示受理/查询成功，不代表生成完成。

状态：`queued` 等待、`in_progress` 生成中、`completed` 成功、`failed` 失败。若返回 `unknown`，表示结果待核实，不是明确失败，不能据此重发或认定退款。完成时读取 `outputs` 中 `type=video` 的 `url`，在自己的服务端下载并保存。下载结果签名链接时不要携带 仓鼠AI Key。结果 URL 可能过期，不保证永久有效或自动刷新；请使用 `outputs` 链接下载，不要依赖 `GET/HEAD /v1/videos/{id}/content` 下载代理。

```sh
curl https://www.piknoai.com/v1/videos/task_EXAMPLE \
  -H "Authorization: Bearer $PIKNO_API_KEY"
```

## 4. 价格与异常

客户价格以当前已发布目录及本次有效报价为准。请核对计价单位、所选参数、参考素材附加项和总金额；本文不固定任何线路的售价。

### 报价确认

`POST /v1/client/quote` 使用与目标功能匹配的客户 Key，提交 JSON。例如，获取一次文生图报价：

```json
{"model":"pikno-image-flare","operation":"image","resolution":"1024x1024","quality":"high","ratio":"","seconds":0,"reference_images":0,"reference_videos":0,"reference_audio":0,"quantity":1}
```

报价不创建生成任务，也不扣费。响应的 `data` 包含 `quote_id`、`line_revision`、`currency`、`unit`、`unit_price_cny`、`reference_surcharge_cny`、`per_item_cny`、`quantity`、`total_cny` 和 `expires_at`。向用户展示本次总价，确认后，在对应的生成请求中同时携带：

```text
X-PIKNO-Quote: <quote_id>
X-PIKNO-Quote-Index: 0
```

报价的 `operation` 分别为 `image`、`image_edit`、`video`、`digital`、`depth`；其他参数必须与实际生成请求一致。图片报价的 `resolution` 对应生成请求的 `size`；视频报价的 `ratio` 对应生成请求的 `aspect_ratio`。使用报价头的视频请求必须将 `seconds` 写为 JSON 整数，不使用字符串。单次任务使用 `quantity=1` 和索引 `0`。

报价过期、线路版本变更或参数变更时，可能返回 `quote_expired`、`quote_changed`、`quote_parameters_changed`。必须重新获取报价并让用户再次确认，不能静默按新价格提交。收到 `quote_already_submitted` 时，应查询返回的原任务 `task_id`；不得换报价或索引自动重发。

`error.submission_state` 表示提交状态线索：`not_submitted` 表示该报价检查未提交任务；`pending` 表示原提交仍需核实；`accepted` 表示原任务已受理。状态未知时先核对任务和账单，不能把它视为可安全重发的失败。

未携带报价头的兼容客户端仍按当前已发布配置计费。不能将报价标识视为通用 `Idempotency-Key`，也不承诺无报价调用的跨请求去重。

### 预占、结算与失败处理

创建任务时预占额度，任务终态由本站结算；明确失败后按账单状态释放预占，状态不确定时需继续核对，不会仅凭网络超时判定退款。消费记录在账户使用日志中查看。查询和下载不会创建新生成任务。

请求超时或网络中断后，先检查任务记录和账单，不能盲目重发创建请求。HTTP 错误不代表已退款，网络中断也不表示任务未受理。

常见 HTTP 错误：400 参数错误、401 无效 Key、403 权限不足、404 任务不存在或不可见、409 状态或报价冲突、413 请求过大、415 请求格式不支持、429 限流、5xx 服务暂时异常。使用实际 JSON `error` 字段、本站任务 ID 和请求 ID 诊断，不仅凭 HTTP 状态推断是否扣费或退款。

Key 泄露后立即撤销并重建。分享诊断资料时去掉 Authorization 头、完整 Key、报价标识及带签名的媒体链接。
