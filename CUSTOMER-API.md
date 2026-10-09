# PIKNO API 接入说明

状态：统一视频接口已部署，正在内部验收；收费渠道尚未正式开放。本文示例不是模型已对客户开放的承诺。

## 1. 开通与鉴权

在 https://www.piknoai.com 注册、验证邮箱并登录，充值后创建 API 令牌。令牌选择有权限的分组和模型，设置余额限额与到期时间。图片使用 image-standard，视频使用 video-standard；组内实际可用模型以后台开放情况为准。

统一域名：`https://www.piknoai.com`。兼容客户端要求 Base URL 时，图片填写 `https://www.piknoai.com/v1`，不要重复拼接 `/v1`。

所有 API 请求携带 `Authorization: Bearer <PIKNO_API_KEY>`。只使用本站客户令牌，不使用上游密钥、管理员登录令牌或密码。请在自己的服务器环境变量中保存令牌，切勿放到网页前端或公开仓库。

`GET /v1/models` 查询令牌当前可用模型；关闭渠道、权限不足或未定价模型不可调用。接口列表不承诺模型底层身份。

## 2. 图片

文生图：`POST /v1/images/generations`，JSON：

```json
{"model":"gpt-image-2.5-flare","prompt":"白色背景中的蓝色陶瓷杯","n":1,"size":"1024x1024","quality":"high","response_format":"url"}
```

图生图：先按下节上传到 R2，再以 JSON 调用 `POST /v1/images/edits`。`images` 是完成上传后得到的本站签名 URL 数组，支持1至5张；2026-10-08已通过5张引用的真实Packy验收。直接multipart文件上传返回415。每次仅允许 `n=1`，`response_format` 仅支持 `url`，不返回Base64图片。

```json
{"model":"gpt-image-2.5-flare","prompt":"将杯子改为蓝色","n":1,"size":"1024x1024","quality":"high","response_format":"url","images":["<完成上传后返回的url>"]}
```

可执行Node示例见同目录 `examples/media-edit.mjs`，支持1至5个本地参考图片文件。图片内容由客户端直接经Cloudflare上传R2，ECS仅接收JSON并负责鉴权、额度预占及结算；上游若返回Base64，由边缘服务存入R2后返回链接。

图片按既定配置成功单张售价人民币0.10元；每次只请求1张。图片仍使用独立PackyAPI渠道。

## 2.1 参考素材直传

1. 携带本站令牌，`POST /v1/media/uploads`，JSON为 `{"content_type":"image/png","size":12345}`；size必须为实际字节数。
2. 向返回的 `upload_url` 发起PUT，使用返回的 `headers`，请求体是文件原始字节。此步骤只使用上传凭证，不携带客户API令牌。
3. 携带本站令牌，`POST /v1/media/complete`，JSON为 `{"upload_ticket":"<步骤1返回值>"}`。
4. 使用完成响应的 `url` 调用图片或视频生成。链接绑定账户和素材类型；普通外链、Base64、跨账户、过期和伪造引用被拒绝。

支持PNG/JPEG/WebP单文件30MiB，MP4/MP3/WAV单文件50MiB。上传票据10分钟有效，读取链接最多2小时有效，素材配置1天过期清理。支持单段Range读取。过期后重新上传；不得把签名链接当永久素材地址，也不要把签名链接写入公开日志。

生成请求仅接收不超过64KiB的JSON。边缘上传限流目前为每账户每分钟20次；遇到429稍后重试上传，不要自动重试付费生成请求。

## 3. 统一视频接口

创建：`POST /v1/videos`。首版仅支持JSON，不支持multipart、SDK文件上传、批量、remix、取消或webhook通知。这是PIKNO的统一视频协议子集，不承诺完全兼容任何SDK。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| model | string | 本站模型ID，例如 sanbao/sd2_480p_real |
| prompt | string | 非空提示词，长度受模型限制 |
| seconds | integer/string | 显式视频秒数；允许整数字符串，如 "4"；必须符合模型时长范围 |
| resolution | string | 显式清晰度，如 480p；必须为模型支持值 |
| aspect_ratio | string | 画面比例，如 16:9 |
| image_urls | array | 可选参考图片；必须使用本站同账户完成上传的R2签名URL，数量受模型限制 |
| video_urls/audio_urls | array | 仅对应模型支持时可用，必须为本站同账户对应类型的R2签名URL；CanSeeDream需 {url,durationSeconds} 对象 |
| generate_audio | boolean | 仅CanSeeDream支持；三宝拒绝此参数 |

未知字段会被拒绝，包括 `duration`、`metadata`、`size`、`cost`、`provider_route`、`callback_url`、`n`。每个请求只生成一个视频。参考素材路径存在不代表所有模型参考功能已验收。

Shell示例（将令牌设置到环境变量PIKNO_API_KEY）：

```sh
curl https://www.piknoai.com/v1/videos \
  -H "Authorization: Bearer $PIKNO_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"sanbao/sd2_480p_real","prompt":"日出时的平静海面，固定镜头，无文字","seconds":4,"resolution":"480p","aspect_ratio":"16:9"}'
```

受理响应示例（字段由真实统一入口确认，ID仅为占位符）：

```json
{"id":"task_EXAMPLE","object":"video","model":"sanbao/sd2_480p_real","status":"queued","progress":0,"created_at":1791438204}
```

保存本站 `id`，不要使用供应商任务ID。每5–10秒调用 `GET /v1/videos/{id}`，携带同账户有效令牌。HTTP 200或返回ID只表示受理/查询成功，不代表生成完成。

状态：`queued` 等待、`in_progress` 生成中、`completed` 成功、`failed` 失败。完成时读取 `outputs` 中 `type=video` 的 `url`，在自己的服务端下载并保存。下载该签名链接时不要携带 PIKNO 令牌或上游密钥。结果URL可能过期，不保证永久有效或自动刷新。

验收限制：本站 `GET/HEAD /v1/videos/{id}/content` 下载代理目前出现超时，尚未通过验收，暂不作为可用能力对外承诺。创建、查询和扣费已在三宝4秒480p组合上通过真实任务测试。

```sh
curl https://www.piknoai.com/v1/videos/task_EXAMPLE \
  -H "Authorization: Bearer $PIKNO_API_KEY"
```

## 4. 价格与异常

已确认三宝标准视频4秒480p售价为人民币6元/次；其他视频模型价格及开放组合需另行验收。CanSeeDream单条上游测试成功不代表本站扣费验收已完成。

创建时预占额度，任务终态由本站结算；消费记录在账户使用日志中查看。查询/下载不创建新生成任务。请求超时后先检查任务记录，不能盲目重发创建请求；首版没有承诺客户端 Idempotency-Key 的跨请求去重。

常见HTTP错误：400参数/配置错误、401无效令牌、403权限不足、404任务不存在或不可见、429限流、5xx网关或上游异常。以实际JSON `error` 字段与请求ID诊断，不仅凭HTTP状态推断是否扣费或退款。网络中断不代表上游没有受理。

密钥泄露立即撤销并重建；分享诊断资料时去掉Authorization头、完整令牌及带签名的媒体链接。
