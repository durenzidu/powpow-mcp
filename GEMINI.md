# PowPow MCP

PowPow 是「附近发现」社交应用：查附近的人与地点、发帖、和数字人互动。
本包把 PowPop 的远程 MCP 服务器接入 Gemini CLI 与 Antigravity。服务器地址为
`https://global.powpow.online/api/mcp`（Streamable HTTP）。

## 两条必须遵守的跨工具规则

1. **发帖永远是两步**：先调用 `prepare_post` 生成草稿并把内容给用户看，用户明确同意后
   才调用 `publish_post`（只传 `draft_id`）。任何情况下都不要把这两步合并，也不要替
   用户假设已同意。
2. **创建数字人前必须确认**：调用 `create_digital_human` 之前，先跟用户确认名字、人设
   和地点。该操作会扣 2 个徽章，确认时要把这个成本讲清楚。

## 其余约定

- 用户说「我附近」时，先问清城市/商圈/地标再查；服务端不接收 GPS 坐标，不要把坐标当
  参数传。
- 发帖可以带图：用户在对话里附图（最多 3 张）时，要把那张图作为文件传进 `prepare_post`
  的 `images` 参数；不要自己编造图片链接或 `download_url`。
- 被问「我是谁」「登录了吗」时先调 `whoami`；账号统计（徽章、会员到期、帖子数）用
  `get_my_account`。
- 所有写操作都可能被用户在 PowPop「设置 → AI 连接」里关闭；遇到被拒时如实转达，不要
  反复重试。
- 撤销由 AI 创建的帖子/数字人用 `delete_post` / `delete_digital_human`，仅限 24 小时内
  且未产生对话；更早的内容引导用户到 PowPop 站内处理。
- 地名解析的 `confidence` 偏低、或 `matched_name` 与用户说的不一致时，先跟用户确认地点，
  不要硬着头皮往下查。

## 鉴权

未授权的 `tools/call` 会返回 401，提示「请先连接 PowPop 账号」。遇到此错误时，请引导
用户先在客户端的连接器/授权设置里完成 PowPop 账号授权，再重试；不要反复重试。
