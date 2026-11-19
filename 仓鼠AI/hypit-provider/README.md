# 仓鼠内部 Hypit 视频适配包

这是独立的项目 Provider／Model 包，不修改 Hypit 本体，也不声称复刻其他模型语义。
仅用于已确认的本人／公司内部用途，不纳入公开仓鼠安装包。Hypit 原许可证、名称及版权保持不变。

支持一期：当前 PIKNO 客户目录中的视频线路、文本提示词，以及仓鼠已有素材库 ID。
`operation-id` 必须是 Source 中稳定的镜头身份，同一镜头跨 Build 继续使用同一值。
操作一旦提交，即使响应未知或本地进程重启，也只查询原任务；新的 Build 不创建第二个收费任务。
已知失败后若用户明确要重做，应由用户另建操作身份并重新确认报价，不允许自动换 ID 重试。

此包不支持任意 Hypit Resource 自动导入、首尾帧角色、人物参考分类、独立音频生成、字幕对齐、图片生成或全模板适配。
不接受未声明端口。不能把这些功能的参数静默删除、映射成普通参考图或替换成其他线路。
后续 Hypit Resource 支持需要独立设计本地素材导入、角色语义、文件类型和目录边界。

## 在未修改的 Hypit 0.3.1 中使用

宿主将本目录原样复制到已安装 Hypit Host 的 `node_modules/@hamster/hypit-video/`，在项目
`node_modules/@hamster/hypit-video/` 注册指向该位置的本地链接，并声明项目依赖。
也可以按正常 Node 规则提供 package.json 声明的固定 peer 包。不能只把自家 JS 复制到没有
peer 包的孤立目录：已发布 Hypit 0.3.1 的 generation／runtime-local 是独立依赖。
原版 Host 已安装的 `@hypit/hypit`、`@hypit/generation` 与 `@hypit/runtime-local` 必须保持不改。
导入包会加载真实 author／admission／producer／markup／runtime facets。

将 `hypit.runtime.example.json` 合并到项目所选 Profile，保留其他明确选择的服务，替换 projectId。
宿主在子进程环境设置 `HAMSTER_HYPIT_BRIDGE_URL` 与 `HAMSTER_HYPIT_BRIDGE_TOKEN`。
URL 是专用随机 loopback Provider 服务；短效能力令牌不写项目文件、Profile、Source 或运行 receipt。
PIKNO Key 只由仓鼠原账户后端管理，不给 Hypit。

Source 导入 `@hamster/hypit-video@1` 后使用 `Video` surface，例如：

```xml
<?svml using="@hypit/markup@1"?>
<svml>
  <import as="hamster" from="@hamster/hypit-video@1"/>
  <hamster:Video id="shot-1" operation-id="shot-1-v1"
    line="从仓鼠当前目录选取的线路ID" prompt="一个固定机位的镜头"
    duration="4" resolution="720p" ratio="16:9"/>
</svml>
```

通过原版 `hypit check`／`hypit compile` 验证 Source；这些操作不提交生成。
真实 Build 的 start 只创建只读报价并 checkpoint 宿主操作 ID；在仓鼠界面确认费用后，poll 才能继续原任务提交。
collect 读取仓鼠已保存的账户所属任务文件，再交给 Hypit `context.resources.put`，不接触上游签名结果地址。
本地取消没有声明成上游取消或退款。
