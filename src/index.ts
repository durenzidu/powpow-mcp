// ============================================================
// Supabase Edge Function: mcp-server  (PowPow 的 MCP 服务端)
//
// v0.23.3 —— 帖子/评论 id 容错（10-31）：
//   起因：模型逐字符复制 36 位 UUID 会出错。实测同一批 5 次 reply_to_post
//   错 1 次——把 35e0…efc9d278a850 抄成 …efc9c…，该 id 在库里根本不存在，
//   于是 detail / replies / reply_to_post 全回「未找到公开帖子」。模型据此
//   判断「后端权限判断不一致」，实际是入参错了（审计表能直接看到
//   post_not_found + 那个不存在的 target）。
//   改动：
//   ① RPC 0012：resolve_public_post_id / resolve_public_comment_id。
//      接受完整 id、帖子链接（带 query / 尾斜杠都行）、8 位短 id；
//      后段被抄错时按前 8 位唯一匹配救回；撞多条返回 ambiguous + 候选，
//      绝不替模型猜。评论 id 额外限定在该帖下，防止跨帖误发。
//   ② 摘要里所有 id 改显示 8 位短 id（shortId），并显式告诉模型「原样传即可」。
//   ③ 五个接 post_id 的工具（get_post_detail / get_post_replies / like_post /
//      unlike_post / reply_to_post）统一先过 resolvePostRef；reply_to_post 的
//      reply_to_comment_id 再过 resolveCommentRef。
//      解析器自身故障时退回原值，不让辅助功能拖死主流程。
//
// v0.23.2 —— search_posts 支持时间范围（10-31）：
//   起因：ChatGPT 里 agent 想找「过去 24 小时的新帖」，但全站没有任何按时间
//   倒序的工具，它只能拿宽泛关键词去搜。而 search_public_posts 的排序是
//   `score desc, created_at desc`——相关度优先，与新旧无关。实测搜「的」命中
//   500 条，前 20 条里最新的正是 2026-07-05，于是它（正确地）拒绝把这批帖子
//   冒充成今天的新内容，并反过来要求我们补接口。
//   改动：
//   ① RPC 0011：签名加 p_since / p_until / p_limit，keyword 变可选。排序不变，
//      无关键词时 score 恒 0，`score desc` 自然退化为纯时间倒序——无需分支。
//      返回值数组 → { total_matched, count, posts }：加了 limit 后数组长度不再
//      等于命中总数，若仍以长度当 total 就会重现 v0.13.5 修过的「静默错数」。
//      ⚠️ 旧单参签名已 drop——留着会与新签名形成重载，报 "function is not unique"。
//   ② 时间边界：自带 since_hours（相对现在），或 since/until（YYYY-MM-DD 按
//      北京时间自然日，until 含当天）。纯日期必须补 +08:00，否则 '2026-10-25'
//      按 UTC 解析 = 北京时间当天 08:00，整段偏 8 小时。
//   ③ 摘要：改用 fmtCnTime 显示北京时间（此前各处 slice ISO 串，恒早 8 小时）；
//      空结果时明确要求模型「如实说该时段无帖，不要拿别的时间凑数」。
//      摘要改走原始结果而非 structuredContent，后者按组件上限截 20 条，
//      agent 传 limit=50 会静默少看 30 条。
//
// v0.23.0 —— 评论互动（10-31）：新增 reply_to_post / get_post_replies /
//   get_my_post_replies 三个工具。
//   ① reply_to_post → 网关 action「comment_create」。入参只收 reply_to_comment_id，
//      不收 parent_id / reply_to_user_id——库表是「一级评论 + 二级回复」两层结构，
//      且站内硬性要求「只能回复一级评论」（parent 不能再有 parent）。把原始字段
//      暴露给模型，它必然把 parent_id 填成用户所指的那条二级回复 id 然后吃 400。
//      网关做一次「向上找一级祖先」归一：指 A → parent=A；指 A1 → parent=A，
//      reply_to_user_id=A1 作者。模型只需丢掉评论 id。
//   ② get_post_replies → 新 RPC get_public_post_replies（migration 0009）。
//      为什么必须 RPC：post_comments 开了 RLS 但无任何 policy（全拒），posts 上
//      另有 deny_all_posts_anon，anon 直查只会拿到空数组且不报错。
//      与 get_post_detail 的分工：detail 一次平铺全部评论（无作者名、无分页），
//      replies 分页、带作者昵称、带每条评论 id（回复锚点）。
//   ③ get_my_post_replies → 网关 action「my_post_replies」。站内 notifications
//      页只聚合 followers、从不产生评论通知，所以这是纯新增能力。
//      「新」的口径：默认走 user_settings 里的已读游标（key mcp_replies_cursor，
//      零 migration），mark_read=true 推进；传 since_hours 则走时间窗不动游标。
//      首次调用无游标按最近 7 天算。
//   写侧沿用既有三关：会员准入 → 写开关 → 限流(20/60s) → 审计。评论正文上限
//   500 字，与站内一致；评论数 +1 与过期泡泡延长 24h 只在一级评论时发生。
//   ⚠️ 站内 POST /api/posts/[id]/comments 已改为共用 src/lib/comment-create.ts，
//      规则单点化——以后改评论规则只改那一处。
//
// v0.14.5 —— unsplash/picsum 帖图头图放行（10-17）。
//   posts.image_url 域名分布实测（生产库 833 条有效）：supabase.co 730 /
//   images.unsplash.com 94 / picsum.photos 5 / volces 1 / bing 1 / 相对路径 2。
//   v0.14.4 起 mediaHostAllowed 域名白名单把非自有域全部挡掉 → 回退「帖」
//   圆块，unsplash 94 条 + picsum 5 条（合计占非自有域有效图的 98%）没头图。
//   本版单变量增量：白名单与 _meta.ui.csp.resourceDomains 同步放行这两域。
//   依据：resourceDomains「具体域名」形态即 v0.13.4 实证的通过创建校验的
//   最小形态，加同形态域名属同类扩展（v0.13.5 连坐事故的嫌疑是 connectDomains
//   与 redirect_domains 两键齐加，非具体域名本身）。volces/bing 各 1 条量级
//   不值得扩面；相对路径脏数据继续挡。
//   ⚠️ 若 ChatGPT 侧创建/更新校验报「部分应用设置未通过验证」⇒ 回退本版两处
//      域名增量即恢复 0.14.4 形态。
//
// v0.13.12 —— widget 运行时对齐官方标准（10-15，**仅提交未部署**）。
//   单变量实验纪律：v0.13.11 创建复测结果未回之前不部署，避免污染
//   redirect_domains 归因。本版服务端逻辑零变化（仅版本号），全部
//   改动在 widget-html.ts 运行时：
//   ① openExternal / requestDisplayMode 优先级倒置——标准桥 RPC 优先
//      （ui/open-link、ui/request-display-mode，ext-apps 2.0.3 官方标准
//      方法），window.openai 降级为 ChatGPT 宿主兜底。依据 Intelligent
//      UI 开发指南「渐进式增强：优先 MCP Apps 标准桥接方法」；官方示例
//      widget（mcp_app_basics_node）亦纯标准桥、不碰 window.openai。
//   ② 新增 ui/notifications/host-context-changed 监听：宿主-initiated
//      的全屏切换同步按钮态（此前只认自己发的请求，宿主替用户切全屏时
//      按钮态与实际相反）；主题切换仅记录（视觉主题由宿主注入的
//      --color-* CSS 变量自动完成，widget :root 全套消费）。
//
// v0.13.11 —— 创建成功后第一轮加回（单变量实验，10-14）。
//   v0.13.10 已实证「13.4 UI 形态可过创建校验」⇒ 卡点是 13.4 之后新增的
//   _meta 字段（mimeType/securitySchemes/CSP 三批，见 v0.13.10 头注）。
//   本版只加回一项（其余保持 13.4 成功形态不动）：
//   🔴 openai/widgetCSP.redirect_domains（v0.13.5 曾加、13.10 回退）——
//      widget 内 8 处「打开完整版」openExternal 的白名单；缺它则宿主拒绝
//      跳转（链接悬空）。官方 reference.md:422 明文要求此键。
//   同步（widget-html.ts，不影响创建校验）：补 ui/notifications/size-changed
//   自动高度（对齐 ext-apps 2.0.3 官方 autoResize）；注释勘误（ui/open-link、
//   ui/request-display-mode 在 ext-apps 2.0.3 中已是官方标准方法，非「非文档化」）。
//   ⚠️ 若本版创建复败 ⇒ redirect_domains 即为三嫌疑字段之一，立即再回退；
//      若通过 ⇒ 按序试下一项（mimeType→mcp-app / securitySchemes:noauth）。
//
// v0.13.10 —— 回退 v0.13.4 已验证形态，修 ChatGPT 插件创建失败（隔离实验定位）。
//   实验链（10-14，全部有审计日志/公网重放实证）：
//   ① 最小复现服务器（mcp-minimal，1 个纯工具无任何 _meta）→ 创建成功
//   ② 主服 + MCP_HIDE_WIDGET=true（8 个纯工具、无 UI 资源）→ 创建成功
//      ⇒ widget/UI 特性是卡点；mimeType（v0.13.9 的判断）被证伪——
//      skybridge 时代（v0.13.1-13.4）创建成功过，官方 examples 仓库
//      pizzaz 也用 skybridge（与 reference.md 文档站矛盾，以历史成功形态为准）
//   ③ 本版回退项（全部是 v0.13.4 之后新增的字段）：
//      - mimeType → text/html+skybridge
//      - widgetMeta 去掉 securitySchemes（v0.13.6 加）
//      - 4 个非 UI 工具去掉 _meta.securitySchemes（v0.13.6 加）
//      - resourceMeta 的 csp 回退：仅 resourceDomains 具体域名；
//        去掉 connectDomains / openai/widgetCSP.redirect_domains（v0.13.5 加）
//      保留：v0.13.7/13.9 的 modern 头 shim、v0.13.8 的 .well-known 404
//   遗留嫌疑（若仍失败按序试）：outputSchema（4 工具，官方示例无）、
//   超长 description、discover 的 ttlMs/cacheScope/_meta 字段。
//
// v0.13.9 —— 修 ChatGPT 插件创建失败（「服务器未能完成 MCP 设置」）。
//   排查方法：数据库审计表 mcp_request_logs 抓到 ChatGPT 真实请求序列
//   （UA openai-mcp/1.0.0，协议 2026-07-28，modern 形态：无 initialize 握手，
//   每请求带 _meta 信封）。两个真凶：
//   ① UI 资源 mimeType 不匹配（根因）：v0.13.1 曾把
//      text/html;profile=mcp-app 换成 text/html+skybridge（当时判断
//      「ChatGPT 侧以 skybridge 为主」——错了）。10-14 日志实锤：ChatGPT
//      clientCapabilities 明确只广告
//      extensions.io.modelcontextprotocol.ui.mimeTypes =
//      ["text/html;profile=mcp-app"]；reference.md:436 与
//      deploy-troubleshooting.md 也都要求 mcp-app → 改回标准形态。
//      注：_meta["openai/outputTemplate"] 兼容别名保留（双保险）。
//   ② modern 请求头 shim 泛化：v0.13.7 只给 resources/read 补
//      Mcp-Method/MCP-Protocol-Version/Mcp-Name 缺失头；实测任何 modern
//      请求（server/discover、tools/list、tools/call…）缺头都会被 SDK 2.x
//      现代路径以 -32020 拒（HTTP 400）。现泛化为「凡带 _meta 信封的请求
//      都补缺失头」，legacy initialize 不碰（无 _meta）。
//   另确认：server/discover 由 SDK v2 原生支持（此前误判未实现——
//   那是因为探测请求漏了 _meta 信封才吃 -32601）。
//
// v0.13.5 —— 质量修复批 + 交互升级。动手前通读了本地 OpenAI Apps 官方文档镜像
//   （reference.md / plugin-guidelines.md / build-mcp-server.md / build-auth.md）。
//   🔴 修 redirect_domains：官方 reference.md:422 明文「_meta.ui.csp does not
//   support redirect_domains ... you must still set
//   _meta["openai/widgetCSP"].redirect_domains」。此前只声明了 ui.csp，
//   widget 里 8 处 openExternal 全部悬空（且注释还声称「已声明」）。
//   🔴 修 FAB 遮挡：v0.13.3 修白块时把两件事混在一处（absolute + padding 收到 8px），
//   导致 80px 的 + 按钮永久压住滚动区末尾卡片。正解是留白加在**滚动容器内部**
//   （.cards.is-scrollable），列表不滚动时零多余空白。
//   🔴 修摘要削长文本：通用兜底只取前 8 字段且每值 160 字，把
//   get_post_detail（承诺「完整内容」，实测最长 48646 字符）与
//   get_digital_human（persona 排第 9 位）的核心价值削没了 → 两者改走专用摘要。
//   🔴 修 geocode 静默给错坐标：高德 place/text 是模糊匹配，实测「不存在的地方xyz」
//   命中「不存驿站」并返回坐标，而代码只取 pois[0]、从不比对相关性，于是
//   「无法解析」分支永远走不到；geocodePlace 又被 find_nearby/nearby_attractions
//   内部复用 →「火星广场附近的数字人」会静默返回某个健身俱乐部的结果。
//   现按 POI 名相关性排序取候选，低置信度显式报错/提示，并透传 matched_name。
//   交互：数字人卡点击 → /map?type=digital_human|openclaw_robot&id=&lat=&lng=
//   （地图页分享深链机制，打开即定位+弹出聊天窗；openclaw 机器人自动分派
//   OpenClaw 聊天组件）；帖子卡点击 → /posts/{id} 详情页（公开路由）。
//   新增 deep-link 字段：digital_humans[].chat_url/detail_url、posts[].post_url。
//
// v0.14.7 —— 修「查看资料」死链（用户 2026-10-20 实测复现）。
//   detail_url 原值 `${SITE_URL}/digital-humans/{id}` 指向的路由**不存在**：
//   src/app/(app)/digital-humans/[id]/ 下只有 edit/、没有 page.tsx，
//   线上实测 307 → /register?next=/digital-humans/{id} → 登录后 404。
//   改为复用地图页分享 effect 的 view=panel 分支：
//   /map?type=&id=&lat=&lng=&view=panel → 定位 + 弹 DigitalHumanDetailPanel
//   （头像/简介/收藏/开始聊天/现场打卡）。前端零改动，仅 Edge 重新部署。
//   同步：get_digital_human 摘要的「详情：」行同口径。
//
// v0.13.4 —— 让更多工具也出 UI：search_posts / nearby_attractions / list_campaigns
//   三个工具与 find_nearby **共用同一个 v2.html 模板**（官方 kitchen_sink 示例即多
//   工具共用同一 TEMPLATE_URI），组件按 structuredContent.view 分派渲染形态，
//   不认识的形状回退到原数字人列表 → 现有链路零回归。
//   geocode_place 不绑：只返回 place/lat/lng，没有任何可画内容。
//   顺带修一个现存缺陷：find_nearby.posts 原样透传完整正文（实测最长 48646 字符，
//   20 条可撑爆模型上下文），现统一截断到 120 字摘要。
//   实测数据问题（已在清洗层处理）：商圈 name 混着坐标串（9 条里 5 条）；活动多为
//   草稿（4 条里 3 条 draft 且无封面）。
//
// v0.13.3 —— 修widget 底部一大块白块。对齐站点 LeftBottomMenu 的形态。
//   成因：`.menu` 用了 position:fixed（相对 iframe 视口），不参与文档流，
//   于是 `.app` 用 padding-bottom:132px 给它「预留」空间 → 底部全是空白。
//   改为 position:absolute 锚在 .app 左下角，padding-bottom 收到 8px，
//   .foot 同步 absolute/bottom:38px 与 + 按钮垂直居中。按钮尺寸 80px 不变。
//
// v0.13.2 —— 🔴 修复 widget 整块白屏的真凶：模板字符串里混入 TypeScript 语法。
//   widget-html.ts 的 WIDGET_HTML 是 TS 模板字符串，而**模板字符串内容不做类型
//   检查**，此前其中写着 `var oa = (window as any).openai;`（两处）。Deno 编译、
//   部署、线上校验全部通过，但浏览器把它当纯 JS 解析 →
//   `SyntaxError: Unexpected identifier 'as'` → 整个组件脚本一行都不执行，
//   页面永远停在「正在加载…」。改为 `window.openai`（纯 JS 合法）。
//   ⚠️ 这类 bug 编译期无法发现，故 verify-deploy.mjs 新增 T4b：把 widget 内联
//   script 抽出来跑 `node --check` 做语法自检，纳入日常校验。
//
// v0.13.1 —— 对齐 OpenAI Apps 官方 reference.md + 官方 pizzaz 示例，补三处缺口。
//   ① find_nearby 补 outputSchema（官方：凡返回 structuredContent 必声明，且必须匹配；
//      SDK validateToolOutput 严格校验，不匹配整个工具报错 → 故逐字段显式清洗类型）。
//      方案二：structuredContent 装三类全量，模型与 widget 读同一份数据。
//   ② 组件 mimeType 换成官方 ChatGPT 实际认的 text/html+skybridge
//      （原 text/html;profile=mcp-app 是 MCP Apps 标准形态，但 ChatGPT 侧以 skybridge 为主）。
//   ③ 补 registerResourceTemplate（ui://powpow/nearby-discovery/{version}），
//      官方 pizzaz 同时注册 resources + resourceTemplates，宿主靠后者发现可挂载组件。
//   次要项：openai/widgetAccessible、openai/toolInvocation/invoking|invoked、
//   openai/ui.availableDisplayModes、openai/widgetDescription。
//
// v0.13.0 —— widget 模板从独立的 render_nearby_widget 工具改绑到 find_nearby。
//   根因：模型处理「附近有什么」只会调 find_nearby（数据工具），不会主动调
//   名字里带「render」的工具 → 连接成功但 widget 从不渲染（审计日志实锤：
//   resources/read 有、render_nearby_widget 调用 0 次）。按 OpenAI Apps 标准
//   模式修正：出 UI 的工具 = 模型真正会调的那个数据工具。工具数 9 → 8；
//   find_nearby 结果新增 structuredContent（widget 渲染载荷）。
//
// v0.12.0 —— 按 Supabase 官方 byo-mcp 模式重构（根因修复）
//
// 背景（v0.3.1~v0.11.0 手写 JSON-RPC 全部失败后重构）：
// 官方文档 supabase.com/docs/guides/ai-tools/byo-mcp 给定的标准形态是
// createMcpHandler + McpServer（@modelcontextprotocol/server v2 SDK），
// Streamable HTTP 传输、协议版本协商、SSE 帧格式、initialize/capabilities
// 全部由官方 SDK 处理。官方明确该模式支持 ChatGPT 连接器
// （"MCP clients such as Claude, ChatGPT, Cursor, or VS Code"）。
// 手写实现与官方 SDK 的逐字节差异（官方示例响应为
// `event: message\ndata: {...}\n\n`；stateless 模式下 GET/DELETE 直接
// 405 而非保持长连接）即此前「服务器未能完成 MCP 设置」的根因。
//
// 关键行为（v2 SDK 默认选项，勿随意改）：
// - legacy:'stateless' —— 2025 时代流量每请求全新实例；GET/DELETE 回 405
// - responseMode:'auto' —— 现代协议单请求默认 JSON 体；legacy 走 SSE 流
// - keepAliveMs:15000 —— SSE 注释帧保活
//
// 工具与 widget HTML 内容与 v0.11.0 完全一致（仅传输/协议层换成官方 SDK）。
// 历史排查过程见 .workbuddy/memory/2026-10-13.md。
// ============================================================

// 类型定义：Supabase Edge Runtime API（官方示例同款 import）
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// 官方 MCP TypeScript SDK v2（Supabase 官方文档指定用法）。
// createMcpHandler 跑 Streamable HTTP 传输，且每个请求构建全新 McpServer
// 实例——适配 Edge Function 无状态运行时。
// ResourceTemplate：registerResource 第二参数传它即注册为 resourceTemplate
// （官方 pizzaz 示例同时注册 resources + resourceTemplates；宿主靠后者发现组件）。
// 版本锁死 2.3.1：这是线上验证过的版本。用 ^2.0.0 会在每次部署时被解析到最新
// minor（当前 latest 已是 2.4.0），换句话说「只想改一句描述」会顺手换掉整个 MCP
// 传输层，出问题也说不清是描述改坏了还是 SDK 换坏了。要升级单独一次提交。
import { createMcpHandler, McpServer, ResourceTemplate } from 'npm:@modelcontextprotocol/server@2.3.1';
import { z } from 'npm:zod@^4.3.6';

// v0.4.1 注意：supabase-js 必须用 npm: 导入而非 esm.sh URL——esm.sh 是
// 第三方 CDN，启动期解析失败会直接 BOOT_ERROR（503）。npm: 由 Supabase
// 平台预打包，稳定。
import { createClient } from 'npm:@supabase/supabase-js@2';

import { WIDGET_HTML, SITE_URL } from './widget-html.ts';
// v0.14.2：OAuth 2.1 资源服务器侧（MCP_OAUTH 开关隔离，默认关——灰度/回滚
// 只改 secret，代码零变动）。详见 auth.ts 头注与 buildMcpHandler 注释。
import {
  MCP_OAUTH_ENABLED,
  adminClient,
  authenticate,
  fetchPowpowProfile,
  handleOAuthRoutes,
  parseBearer,
  unauthorizedHttp,
} from './auth.ts';
import type { AuthenticatedUser } from './auth.ts';

// ---- 环境与常量 ----
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const SERVER_NAME = 'powpow-mcp';
// v0.14.2：恢复 v0.14.1 OAuth 全栈（影子账号 + consent 页 + 401 门禁）并适配
// v0.13.12；JWKS 真验签 + 动态 resource + per-request 身份闭包。
// MCP_OAUTH secret 默认不设 → 行为与 v0.13.12 完全一致（灰度开关）。
// v0.14.11：常量此前停在 0.14.5，而代码已到 0.14.10（0.14.10 因部署早于提交而从未上线），
// 线上无法从版本号判断跑的是哪版，排障困难。本节起改为「每次部署必 bump」并补回差额。
const SERVER_VERSION = '0.23.5';

// v0.23.4：诊断工具开关。
// prepare_post_probe 只用于排查「对话里上传的图为什么进不了工具参数」（同手机同图对比
// prepare_post 与它）。对普通用户是纯噪音，且公开目录提交时审核方会追问「为什么公开
// 一个诊断工具、它和 prepare_post 有什么区别」——收益远小于解释成本。
// 因此改为默认不注册，需要排查时在 Edge 侧设 MCP_ENABLE_PROBE=true。
const PROBE_ENABLED = (Deno.env.get('MCP_ENABLE_PROBE') ?? '').toLowerCase() === 'true';

/**
 * v0.21.1：服务级 instructions。
 *
 * 官方 build/mcp-server 明确建议用它承载「跨工具」的统一指导（必需的工具调用顺序、
 * 共享限制），并强调「把最重要的内容放在前 512 字符」。此前这些约束只散落在单个
 * 工具描述里——模型读到 publish_post 时已经忘记 prepare_post 的约定，两步确认被
 * 跳过的概率明显更高。
 *
 * 刻意不逐条复述工具描述（官方要求：不要重复单个工具的描述，也不要试图改写模型人格）。
 */
const SERVER_INSTRUCTIONS = `PowPow 是「附近发现」社交应用：查附近的人与地点、发帖、和数字人互动。

两条必须遵守的跨工具规则：
1) 发帖永远是两步：先 prepare_post 生成草稿并把内容给人看，用户明确同意后才调用 publish_post（只传 draft_id）。任何情况下都不要把这两步合并，也不要替用户假设已同意。
2) 创建数字人（create_digital_human）前必须先跟用户确认名字、人设和地点；它会扣 2 个徽章，确认时要把这个成本讲清楚。

其余约定：
- 用户说「我附近」时，先问清城市/商圈/地标再查；服务端不接收 GPS 坐标，不要把坐标当参数传。
- 发帖可以带图：用户在对话里附图（最多 3 张）时，要把那张图作为文件传进 prepare_post 的 images 参数；不要自己编造图片链接或 download_url。
- 被问「我是谁」「登录了吗」时先调 whoami；账号统计（徽章、会员到期、帖子数）用 get_my_account。
- 所有写操作都可能被用户在 PowPow「设置 → AI 连接」里关闭；遇到被拒时如实转达，不要反复重试。
- 撤销由 AI 创建的帖子/数字人用 delete_post / delete_digital_human，仅限 24 小时内且未产生对话；更早的内容引导用户到 PowPow 站内处理。
- 地名解析的 confidence 偏低、或 matched_name 与用户说的不一致时，先跟用户确认地点，不要硬着头皮往下查。`;

// 站点对外域名 SITE_URL 定义在 widget-html.ts（widget HTML 模板插值引用），
// 从那里导入；widget 外链目标（redirect_domains）/ 相对头像路径前缀用它。

// MCP Apps UI 资源 URI（2026-01-26 UI 扩展）：ChatGPT 内渲染的交互组件。
// URI 带版本号——官方「Treat the resource URI as a cache key：breaking
// change 时 publish a new URI」（官方示例 ui://…/v1.html 同款格式）。
// v0.14.12：URI 升到 v3.html。官方「Treat the resource URI as a cache key：
// breaking change 时 publish a new URI」——本版同时改了 mimeType（skybridge →
// profile=mcp-app）与 inline 布局（新增地图预览条），属 breaking change；
// 沿用 v2.html 有可能命中宿主缓存，导致线上仍是旧组件。
const RESOURCE_URI = 'ui://powpow/nearby-discovery/v3.html';
// v0.13.9：mimeType 改回标准形态 text/html;profile=mcp-app。
// v0.13.1 曾改成 text/html+skybridge（判断「ChatGPT 以 skybridge 为主」），
// 10-14 被日志证伪：ChatGPT 的 clientCapabilities 只广告
// extensions.io.modelcontextprotocol.ui.mimeTypes=["text/html;profile=mcp-app"]，
// 资源 mimeType 不在客户端支持列表 → 插件创建校验失败
// （「服务器未能完成 MCP 设置」）。reference.md:436 与
// deploy-troubleshooting.md 均要求 mcp-app；openai/outputTemplate
// 兼容别名在工具 _meta 上继续保留作双保险。
// v0.14.12：mimeType 改回 text/html;profile=mcp-app —— 线上「只有文字回答、
// 没有 widget」的根因（2026-10-21 实证）。
//   证据①：ChatGPT 每次 tools/call 的 _meta 里
//     io.modelcontextprotocol/clientCapabilities.extensions
//       ["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]
//     ——宿主只广告这一个类型，skybridge 不在支持列表。
//   证据②：官方 deploy-troubleshooting.md:16 条目「Structured content only,
//     no component」明确要求 resource 的 mimeType 必须是
//     "text/html;profile=mcp-app"，并注明 openai/outputTemplate 只是兼容别名。
//   证据③：reference.md:436 的 resource 示例同样是 profile=mcp-app。
//   审计日志实证：13:14 那次对话 find_nearby / nearby_attractions 均 200、
//   resources/read 也 200（宿主愿意读资源），但页面无组件 → 读到不支持的
//   mimeType 后静默丢弃，模型只好用文字复述 structuredContent。
//   v0.13.9→13.10 那次回退的原因是「创建校验失败」，但后续定位卡点是
//   v0.13.5/13.6 的 _meta 字段（securitySchemes 等），不是 mimeType；
//   且连接器已存在、无需重新创建，改动只影响渲染分支。
const UI_MIME_TYPE = 'text/html;profile=mcp-app';
// 资源模板（同一 widget 的模板化入口，供 resources/templates/list 发现）。
const RESOURCE_URI_TEMPLATE = 'ui://powpow/nearby-discovery/{version}';

// 隔离开关（保留，便于将来二分排查）：MCP_HIDE_WIDGET=true 时不给 find_nearby
// 挂 widget _meta、也不注册 ui:// 资源，回到 v0.4.2 纯工具形态。
const HIDE_WIDGET = (Deno.env.get('MCP_HIDE_WIDGET') ?? '').toLowerCase() === 'true';

// 跨域：网页版 ChatGPT 等前端跨域访问。
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

// ---- 公开客户端：仅 anon key，无用户 JWT。可见性由 RLS + 代码过滤决定 ----
function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---- 请求审计日志（诊断 ChatGPT 校验用）----
// 写入 mcp_request_logs 表（RLS：仅允许 anon 插入，不可读），
// 便于通过 SQL 直接确认「ChatGPT 的校验请求是否到达过本函数」。
type McpLogEntry = {
  method?: string | null;
  path?: string | null;
  host?: string | null;
  user_agent?: string | null;
  accept?: string | null;
  origin?: string | null;
  session_id?: string | null;
  client_ip?: string | null;
  protocol_version?: string | null;
  mcp_method_header?: string | null;
  rpc_methods?: string | null;
  sse?: boolean | null;
  status?: number | null;
  mcp_name?: string | null;
  request_body?: string | null;
};

function dbLog(entry: McpLogEntry) {
  const write = anonClient()
    .from('mcp_request_logs')
    .insert(entry)
    .then(
      () => {},
      () => {},
    );
  try {
    // Supabase Edge Runtime：响应返回后继续完成日志写入
    (globalThis as any).EdgeRuntime?.waitUntil?.(write);
  } catch {
    // 环境不支持 waitUntil 时，promise 已触发、不阻塞响应
  }
}

// ---- 地理工具 ----
const EARTH_R = 6371000; // 米
function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// 兼容 numeric(lat/lng) 与 text(latitude/longitude) 两种命名
function getCoords(row: any): { lat: number; lng: number } | null {
  let lat = row?.lat ?? row?.latitude;
  let lng = row?.lng ?? row?.longitude;
  lat = lat == null ? null : Number(lat);
  lng = lng == null ? null : Number(lng);
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

// 位置精度：对方开启 precise_enabled 才给精确坐标；否则模糊到约百米（3 位小数）。
// 这是「曝什么由我们代码决定」的硬防线——Agent 拿不到我们没写进去的字段。
function locationFor(row: any): any {
  const c = getCoords(row);
  if (!c) return null;
  if (row?.precise_enabled === true) {
    return { lat: c.lat, lng: c.lng, precise: true };
  }
  return {
    lat: Math.round(c.lat * 1000) / 1000,
    lng: Math.round(c.lng * 1000) / 1000,
    precise: false,
  };
}

// 地名 -> 坐标：高德 Web 服务。先用 POI 文本搜索（地标/商圈名命中更好，
// 如"王府井""天安门"），失败再退到结构化地址 geocode（"xx路xx号"类）。
// 坐标系说明：PowPow 全栈走高德（GCJ-02），库内坐标也是 GCJ-02（实测：
// 库中天安门数字人坐标与高德 place/text 结果完全一致），因此**不做** WGS-84
// 转换，直接透传保持内部一致。外部传入 GPS(WGS-84) 坐标会有约 300-600 米偏差。
// key 读 env AMAP_WEB_SERVICE_KEY（公开仓库不内置密钥，请自行申请高德 Web 服务 key）。
const AMAP_KEY = Deno.env.get('AMAP_WEB_SERVICE_KEY') ?? '';

// ---- v0.21.1：外部调用超时 + 读侧限流 ----
// 目录审核要求「对昂贵或外部可见的工具施加超时与限流」。本服务的 openWorld 工具
// （find_nearby / nearby_attractions / geocode_place）会打高德 Web 服务 API，有
// 配额成本；此前既无超时也无读侧限流，单个客户端就能把日配额刷光，高德慢时还会
// 把 Edge 实例拖到平台超时（用户看到的是笼统的 5xx，而不是「稍后重试」）。
const EXTERNAL_TIMEOUT_MS = Number(Deno.env.get('MCP_EXTERNAL_TIMEOUT_MS') ?? 8000);
const GATEWAY_TIMEOUT_MS = Number(Deno.env.get('MCP_GATEWAY_TIMEOUT_MS') ?? 20000);
const OPEN_WORLD_RATE_LIMIT = 12; // 每 60 秒
const OPEN_WORLD_RATE_WINDOW_MS = 60_000;

/** 带超时的 fetch。超时抛 AbortError，由各调用点既有的 catch 兜成「稍后重试」。 */
function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

// openWorld 限流计数走 mcp_request_logs（网关本来就在写这张表，Edge 用 service_role
// 读写不需要新表、也不需要额外 GRANT），path 用固定标记行区分。
//
// 为什么不用进程内存：Supabase Edge 不做粘性路由。首版用模块级 Map 实现，实测同一
// token 连续 40 次调用全部放行——请求被分散到不同实例，Map 从不累积。持久化计数是
// 这个运行时上唯一可靠的方案。
const RATE_PATH = '/mcp-server:openworld';

/** token → 短 key。不拿原始 token 当库里的 key，避免日志里出现可用凭据。 */
function rateSeed(accessToken: string | null): string {
  if (!accessToken) return 'anon';
  let h = 0;
  for (let i = 0; i < accessToken.length; i++) h = (h * 31 + accessToken.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 占一个 openWorld 名额。返回 0 表示放行，>0 表示建议等待的秒数。
 *
 * 失败一律放行（fail-open）：限流本身是保护措施，不该因为一次 DB 抖动把主功能打死。
 */
async function takeOpenWorldSlot(
  accessToken: string | null,
  tool: string,
): Promise<number> {
  const seed = rateSeed(accessToken);
  try {
    const sb = adminClient();
    const since = new Date(Date.now() - OPEN_WORLD_RATE_WINDOW_MS).toISOString();
    const { count } = await sb
      .from('mcp_request_logs')
      .select('id', { count: 'exact', head: true })
      .eq('path', RATE_PATH)
      .eq('session_id', seed)
      .gte('created_at', since);

    if ((count ?? 0) >= OPEN_WORLD_RATE_LIMIT) return 30;

    await sb.from('mcp_request_logs').insert({
      method: 'POST',
      path: RATE_PATH,
      session_id: seed,
      mcp_name: tool,
      status: 200,
    });
    return 0;
  } catch {
    return 0;
  }
}

/** 统一的限流话术；命中时不执行任何外部调用。 */
function rateLimitedResult(waitSec: number) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `请求太频繁：这个工具每分钟最多 ${OPEN_WORLD_RATE_LIMIT} 次，请 ${waitSec} 秒后再试。`,
      },
    ],
    isError: true,
  };
}

async function amapFirstLocation(
  url: string,
  pick: (j: any) => unknown,
): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await fetchWithTimeout(url, {}, EXTERNAL_TIMEOUT_MS);
    const j = await r.json();
    const loc = pick(j); // "lng,lat"，GCJ-02
    if (j?.status === '1' && typeof loc === 'string') {
      const [lng, lat] = loc.split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  } catch {
    /* 忽略，返回 null */
  }
  return null;
}

/**
 * 🔴 v0.13.5：高德 place/text 是**模糊匹配**，对任意中文串都能"猜"出一个 POI 并
 * 返回 status=1。实测「不存在的地方xyz」命中真实 POI「不存驿站」（东四环中路辅路，
 * 住宿服务）并返回坐标 —— 原实现只取 pois[0].location、从不比对 POI 名与关键词是否
 * 相关，于是「无法解析」分支永远走不到。
 *
 * 危害不止于工具本身：geocodePlace 被 findNearby / nearbyAttractions 内部复用，
 * 所以「火星广场附近的数字人」会拿到某个健身俱乐部的坐标并认真返回那附近的数字人，
 * 用户无从察觉。**静默给错答案比明确报错危险得多。**
 *
 * 修法：取多个候选，按「POI 名与关键词的相关性」排序，只接受真正相关的；
 * 并把matched_name / confidence 透传给调用方，让模型有机会说
 *「我找到的是『不存驿站』，你要找的是这个吗？」
 */

/** 归一化：去空白、标点、大小写，用于相关性比较。 */
function normalizeForMatch(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '') : '';
}

/** 剥掉括号补充说明：「北京故宫博物院北院区(建设中)」→「北京故宫博物院北院区」。
 *  括号里通常是状态/分店/别名，不该影响主体匹配。 */
function stripParens(s: string): string {
  return s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '');
}

/** 关键词去掉 POI 所在城市前缀：「北京故宫」+「北京市」→「故宫」。
 *  v0.14.13：没有这一步，「北京故宫」的“北京”两字永远匹配不上「故宫博物院」，
 *  只能拿到 0.2 分而落选（见 poiRelevance 头注）。 */
function stripCityPrefix(keyword: string, cityname: unknown): string {
  const city = normalizeForMatch(stripParens(String(cityname ?? ''))).replace(/市$/, '');
  const kw = normalizeForMatch(keyword);
  if (city.length >= 2 && kw.length > city.length && kw.startsWith(city)) {
    return kw.slice(city.length);
  }
  return kw;
}

/**
 * 相关性判定：POI 名与关键词必须有实质重合。
 *
 * 🔴 v0.14.13：修「北京故宫 → 北京故宫博物院北院区(建设中)」错配（用户 2026-10-21 报）。
 *   旧实现对「字符重合率」用 `hit / min(|A|,|B|)` 归一，关键词越短越容易被长名字
 *   吃满分：实测高德 place/text 对「北京故宫」的第 0 位是「故宫博物院」
 *   （116.397029,39.917839，正确），第 4 位才是「北京故宫博物院北院区(建设中)」
 *   （116.2278,40.0973，海淀区，距故宫 ~20km）。但旧算法给前者 0.55
 *   （只覆盖「故」「宫」2/4 字），给后者 0.75（4/4 全被覆盖，且分母取 4）
 *   → 北院区胜出。**名字越长越占便宜，是分母选错的必然结果。**
 *
 * 新规则：
 *  - 完全相等 → 1.0
 *  - 互为子串 → 0.8~1.0，按「多出来的字数」衰减
 *    （「故宫」⊂「故宫博物院」得 0.88；「故宫」⊂「北京故宫博物院北院区」得 0.85
 *     → 长的仍然吃亏，主体 POI 胜出）
 *  - 否则 → 覆盖率 × 精确率（两个方向都要高，长尾不再白拿分）
 *  - 低于 0.3 视为未命中（「不存驿站」vs「不存在的地方xyz」只有 0.11 → 拒绝，
 *    v0.13.5 修的误命中不会回归）
 */
function poiRelevance(poiName: unknown, keyword: string, cityname?: unknown): number {
  const a = normalizeForMatch(stripParens(String(poiName ?? '')));
  const b = stripCityPrefix(keyword, cityname);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // 互为子串：强命中，但长度差越大扣分越多，避免「XX 的北院区/建设中」类长尾抢主体
  if (a.includes(b)) return 0.8 + 0.2 * (b.length / a.length);
  if (b.includes(a)) return 0.8 + 0.2 * (a.length / b.length);
  // 字符重合：覆盖率（关键词被覆盖多少）× 精确率（POI 名有多少是关键词的字符）
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  let hit = 0;
  for (const ch of setB) if (setA.has(ch)) hit++;
  return (hit / setB.size) * (hit / setA.size);
}

/** 低于此分视为「没匹配上」，交给 geocode 分支或直接报错。 */
const POI_MIN_RELEVANCE = 0.3;


async function geocodePlace(
  place: string,
): Promise<{ lat: number; lng: number; matched_name?: string; confidence?: number } | null> {
  const q = encodeURIComponent(place);
  // 1) POI 搜索：取前 10 个候选，按相关性挑最好的那个
  try {
    const r = await fetchWithTimeout(
      `https://restapi.amap.com/v3/place/text?keywords=${q}&offset=10&page=1&extensions=base&key=${AMAP_KEY}`,
      {},
      EXTERNAL_TIMEOUT_MS,
    );
    const j = await r.json();
    if (j?.status === '1' && Array.isArray(j.pois) && j.pois.length) {
      const ranked = j.pois
        .map((poi: any) => {
          const loc = String(poi?.location ?? '');
          const [lng, lat] = loc.split(',').map(Number);
          return {
            name: String(poi?.name ?? ''),
            lat,
            lng,
            score: poiRelevance(poi?.name, place, poi?.cityname),
          };
        })
        .filter(
          (x: any) =>
            Number.isFinite(x.lat) && Number.isFinite(x.lng) && x.score >= POI_MIN_RELEVANCE,
        )
        .sort((a: any, b: any) => b.score - a.score);
      if (ranked.length) {
        return {
          lat: ranked[0].lat,
          lng: ranked[0].lng,
          matched_name: ranked[0].name,
          confidence: ranked[0].score,
        };
      }
    }
  } catch {
    /* 落到下面的 geocode 分支 */
  }

  // 2) 结构化地址 geocode（「xx路xx号」类输入更准）。地址串与关键词高度重合，
  //    故阈值放宽到 0.4（geocode 返回的 formatted_address 天然更长）。
  const geo = await amapFirstLocation(
    `https://restapi.amap.com/v3/geocode/geo?address=${q}&key=${AMAP_KEY}`,
    (j) => j?.geocodes?.[0]?.location,
  );
  if (!geo) return null;
  return { lat: geo.lat, lng: geo.lng, matched_name: place, confidence: 0.5 };
}

function shapeUser(r: any) {
  return {
    kind: 'user',
    id: r.id,
    display_name: r.display_name ?? r.username ?? r.name ?? null,
    avatar_url: r.avatar_url ?? null,
    location: locationFor(r),
  };
}

// ---- 工具实现（与 v0.11.0 逐字节一致，仅去掉 JSON-RPC 包装）----

// v0.21.0（R8）：原 coordOrNull 已移除——坐标不再作为工具入参（插件规范
// 不得索取精确位置），位置唯一来源是地名 + geocodePlace。

async function findNearby(args: any, sb: any) {
  const radius = Math.min(Math.max(Number(args?.radius_meters ?? 1000), 50), 50000);
  const types: string[] = args?.types ?? ['digital_humans', 'users', 'posts'];

  // 解析中心点：v0.21.0（R8）起只接受地名。原先是 lat/lng 优先、place 兜底，
  // 等于默许模型索取精确坐标；现在位置唯一来源是用户口述的地名。
  let lat: number | null = null;
  let lng: number | null = null;
  // v0.13.5：地名解析的实际情况（匹配到哪个 POI），透传给摘要让模型能转告用户
  let geocodeNote: string | null = null;
  if (lat == null || lng == null) {
    if (args?.place) {
      const g = await geocodePlace(String(args.place));
      if (!g) return { error: `地名「${args.place}」无法解析为坐标` };
      lat = g.lat;
      lng = g.lng;
      // v0.13.5：高德模糊匹配可能命中完全无关的 POI，把实际匹配名带给调用方
      // 与模型，避免「火星广场」被悄悄解析成某个健身房俱乐部。
      if ((g.confidence ?? 1) < 0.8) {
        return {
          error:
            `地名「${args.place}」未能精确匹配（高德匹配到「${g.matched_name ?? '未知地点'}」，` +
            `匹配度 ${(g.confidence ?? 0).toFixed(2)}）。请改用更明确的地名` +
            `（如「XX广场」而非「XX广场附近的奶茶店」）。`,
        };
      }
      geocodeNote = `按地名「${args.place}」定位到「${g.matched_name ?? args.place}」`;
    } else {
      return {
        error:
          '请提供一个地点名（place），例如「国贸」「中关村」「北京故宫」。' +
          '用户说「我附近」时，先问清是哪个城市或商圈，不要索取或猜测经纬度。',
      };
    }
  }

  const result: any = {
    center: { lat, lng, radius_meters: radius },
    ...(geocodeNote ? { geocode_note: geocodeNote } : {}),
    digital_humans: [],
    users: [],
    posts: [],
  };

  // 数字人（地图泡泡，公开实体）：走方案 B —— SECURITY DEFINER RPC
  // nearby_public_digital_humans（owner 身份只读 is_public 行 + 半径过滤），
  // 已 grant execute to anon。不直接查表，避免触碰现有 RLS 与泄露敏感列。
  if (types.includes('digital_humans')) {
    const { data, error } = await sb.rpc('nearby_public_digital_humans', {
      p_lat: lat,
      p_lng: lng,
      p_radius: radius,
    });
    if (error) return { error: `查询数字人失败: ${error.message}` };
    // v0.13.0：补 description/avatar_url/is_robot —— widget 卡片渲染直接消费
    // 同一份 find_nearby 结果（不再单开 render_nearby_widget 工具）。
    result.digital_humans = (data ?? []).map((r: any) => ({
      kind: 'digital_human',
      id: r.id,
      name: r.name ?? null,
      description: r.description ?? null,
      avatar_url: r.avatar_url ?? null,
      is_robot: r.is_robot ?? null,
      location_name: r.location_name ?? null,
      // v0.14.11：改走 locationFor()。此前硬写 {lat:r.lat, lng:r.lng, precise:true}
      // 把 RPC 返回的原值（d.lat::double precision，无 round）直接透传——实测 2129 个
      // 公开数字人里 1190 个坐标精确到 6 位以上小数，location_name 有 24 条带门牌号，
      // 而开发文档 §7.1 承诺「按 precise_enabled 降级到 3 位小数≈百米」。
      // nearby_public_digital_humans 不返回 precise_enabled 列 → locationFor 走 false
      // 分支自动模糊，无需改 RPC。
      location: locationFor(r),
      distance_meters: Math.round(r.distance_meters),
    }));
  }

  // 真实用户：走方案 B —— SECURITY DEFINER RPC（owner 身份只读「可发现」用户），
  // 已 grant execute to anon。不直接查 users 表，避免触碰现有 RLS 与泄露敏感列。
  if (types.includes('users')) {
    const { data, error } = await sb.rpc('nearby_discoverable_users');
    if (error) return { error: `查询 users 失败: ${error.message}` };
    result.users = (data ?? [])
      .filter((r: any) => getCoords(r))
      .map((r: any) => shapeUser(r))
      .filter((s: any) => distanceMeters(lat!, lng!, s.location.lat, s.location.lng) <= radius);
  }

  // 帖子：走方案 B —— SECURITY DEFINER RPC nearby_public_posts（owner 身份只读
  // is_public 行 + 半径过滤），已 grant execute to anon。不直接查表。
  if (types.includes('posts')) {
    const { data, error } = await sb.rpc('nearby_public_posts', {
      p_lat: lat,
      p_lng: lng,
      p_radius: radius,
    });
    if (error) return { error: `查询帖子失败: ${error.message}` };
    result.posts = (data ?? []).map((r: any) => ({
      kind: 'post',
      id: r.id,
      content: r.content ?? null,
      // v0.14.3：帖子头图。RPC 一直返回 image_url（94% 填充率，Supabase
      // Storage 公开桶），此前映射漏提炼 → widget 无图可渲染。
      image_url: r.image_url ?? null,
      author_id: r.user_id ?? null,
      // v0.14.9：作者公开资料（RPC 已 left join users，见 0004 迁移）
      author: buildAuthor(
        r.user_id,
        r.author_name,
        r.author_username,
        r.author_avatar_url,
        r.author_bio,
      ),
      location_name: r.location_name ?? null,
      // v0.14.11：同上，改走 locationFor()。实测 639 条有坐标的帖子中 455 条（71%）
      // 精确到 6 位以上，94 条 location_name 带街道门牌。
      location: locationFor(r),
      likes_count: r.likes_count ?? 0,
      comments_count: r.comments_count ?? 0,
      created_at: r.created_at ?? null,
      distance_meters: Math.round(r.distance_meters),
    }));
  }

  result.count = result.digital_humans.length + result.users.length + result.posts.length;
  return result;
}

async function getDigitalHuman(args: any, sb: any) {
  if (!args?.id) return { error: '缺少参数 id' };
  const { data, error } = await sb.rpc('get_public_digital_human', { p_id: String(args.id) });
  if (error) return { error: `查询数字人失败: ${error.message}` };
  if (!data) return { error: '未找到该公开数字人' };
  return data;
}

/**
 * 展示用短 id：只给模型看前 8 位。
 *
 * 让模型逐字符复制 36 位十六进制，出错率不可忽略——2026-10-31 实测同一批 5 次
 * 调用错 1 次（第 4 段 efc9d 抄成 efc9c）。而 id 一旦错位，所有接口都只能回
 * 「未找到公开帖子」，看起来像权限或状态判断的 bug，实际是入参根本不存在。
 * 8 位足够唯一（实测全库无重复前缀），且 resolve_public_post_id 认得。
 */
function shortId(v: any): string {
  const s = String(v ?? '').trim();
  return s.length > 8 ? s.slice(0, 8) : s;
}

/**
 * 把模型给的「帖子标识」归一成真实 id（v0.23.3）。
 *
 * 接受：完整 UUID / 帖子链接（含带 query、尾斜杠的）/ 8 位短 id / 后段抄错的 UUID
 * （按前 8 位唯一匹配救回）。撞多条不猜，明确要求改用完整 id。
 * 解析器自身故障时退回原值——否则一个辅助功能会把主流程拖死。
 */
async function resolvePostRef(
  sb: any,
  raw: any,
  notFoundText = '未找到该公开帖子，或它已被设为非公开',
): Promise<{ id?: string; error?: string }> {
  const s = String(raw ?? '').trim();
  if (!s) return { error: '缺少参数 post_id' };
  const { data, error } = await sb.rpc('resolve_public_post_id', { p_raw: s });
  if (error) return { id: s };
  if (data?.found) return { id: String(data.post_id) };
  if (data?.reason === 'ambiguous') {
    const list = Array.isArray(data?.candidates) ? data.candidates.join('、') : '';
    return {
      error:
        `post_id「${s}」的前 8 位匹配到多条帖子，无法确定是哪一条。` +
        `请改用更完整的帖子 id${list ? `，候选：${list}` : ''}`,
    };
  }
  return { error: notFoundText };
}

/** 评论 id 同理，但限定在该帖下找——否则可能拿别的帖的评论 id 误发。 */
async function resolveCommentRef(
  sb: any,
  raw: any,
  postId: string,
): Promise<{ id?: string; error?: string }> {
  const s = String(raw ?? '').trim();
  if (!s) return {};
  const { data, error } = await sb.rpc('resolve_public_comment_id', {
    p_raw: s,
    p_post_id: postId,
  });
  if (error) return { id: s };
  if (data?.found) return { id: String(data.comment_id) };
  return {
    error:
      `未找到评论「${s}」：它可能不在本帖下、已被删除，或 id 抄错了。` +
      '请重新调 get_post_replies，用它返回的 8 位短 id 再试。',
  };
}

async function getPostDetail(args: any, sb: any) {
  const ref = await resolvePostRef(sb, args?.post_id, '未找到该公开帖子');
  if (!ref.id) return { error: ref.error ?? '未找到该公开帖子' };
  const { data, error } = await sb.rpc('get_public_post_detail', {
    p_post_id: ref.id,
  });
  if (error) return { error: `查询帖子失败: ${error.message}` };
  if (!data || !data.post) return { error: '未找到该公开帖子' };
  // v0.14.9：RPC 返回的 author 不含 profile_url（域名不进 SQL），
  // 这里统一走 buildAuthor 归一化：补主页链接、头像域名白名单、简介截断。
  const rawAuthor = data.post.author;
  data.post.author = buildAuthor(
    rawAuthor?.id ?? data.post.author_id,
    rawAuthor?.display_name,
    rawAuthor?.username,
    rawAuthor?.avatar_url,
    rawAuthor?.bio,
  );
  return data;
}

async function getPostReplies(args: any, sb: any) {
  const ref = await resolvePostRef(sb, args?.post_id);
  if (!ref.id) return { error: ref.error ?? '未找到该公开帖子，或它已被设为非公开' };
  const page = Math.max(1, Math.trunc(Number(args?.page ?? 1)) || 1);
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(args?.limit ?? 20)) || 20));
  const { data, error } = await sb.rpc('get_public_post_replies', {
    p_post_id: ref.id,
    p_page: page,
    p_limit: limit,
  });
  if (error) return { error: `查询评论失败: ${error.message}` };
  // 帖子不存在 / 被设为非公开时 RPC 返回 {found:false}，不返回空评论数组——
  // 两者含义完全不同，不能都显示成「还没有人评论」。
  if (!data || !data.found) return { error: '未找到该公开帖子，或它已被设为非公开' };
  return data;
}

async function nearbyAttractions(args: any, sb: any) {
  const radius = Math.min(Math.max(Number(args?.radius_meters ?? 3000), 50), 50000);
  // v0.21.0（R8）：同 findNearby，坐标只从地名来。
  let lat: number | null = null;
  let lng: number | null = null;
  let geocodeNote: string | null = null;
  if (lat == null || lng == null) {
    if (args?.place) {
      const g = await geocodePlace(String(args.place));
      if (!g) return { error: `地名「${args.place}」无法解析为坐标` };
      lat = g.lat;
      lng = g.lng;
      // v0.13.5：高德模糊匹配可能命中完全无关的 POI，把实际匹配名带给调用方
      // 与模型，避免「火星广场」被悄悄解析成某个健身房俱乐部。
      if ((g.confidence ?? 1) < 0.8) {
        return {
          error:
            `地名「${args.place}」未能精确匹配（高德匹配到「${g.matched_name ?? '未知地点'}」，` +
            `匹配度 ${(g.confidence ?? 0).toFixed(2)}）。请改用更明确的地名` +
            `（如「XX广场」而非「XX广场附近的奶茶店」）。`,
        };
      }
      geocodeNote = `按地名「${args.place}」定位到「${g.matched_name ?? args.place}」`;
    } else {
      return {
        error:
          '请提供一个地点名（place），例如「国贸」「西湖」。' +
          '用户说「我附近」时，先问清是哪个城市或商圈，不要索取或猜测经纬度。',
      };
    }
  }
  const [ra, rb] = await Promise.all([
    sb.rpc('nearby_public_attractions', { p_lat: lat, p_lng: lng, p_radius: radius }),
    sb.rpc('nearby_public_business_districts', { p_lat: lat, p_lng: lng, p_radius: radius }),
  ]);
  if (ra.error) return { error: `查询景点失败: ${ra.error.message}` };
  if (rb.error) return { error: `查询商圈失败: ${rb.error.message}` };
  const attractions = (ra.data ?? []).sort((a: any, b: any) => a.distance_meters - b.distance_meters);
  const business_districts = (rb.data ?? []).sort(
    (a: any, b: any) => a.distance_meters - b.distance_meters,
  );
  return {
    center: { lat, lng, radius_meters: radius },
    ...(geocodeNote ? { geocode_note: geocodeNote } : {}),
    attractions,
    business_districts,
  };
}

async function listCampaigns(sb: any) {
  const { data, error } = await sb.rpc('list_public_campaigns');
  if (error) return { error: `查询活动失败: ${error.message}` };
  return { campaigns: data ?? [] };
}

// v0.21.0（Phase 6）：原 listMembershipPlans 已删除——plugin-guidelines.md:98
// 禁止插件展示订阅方案，见注册处的说明。

/**
 * v0.23.2：时间边界归一化。
 *
 * 纯日期（2026-10-25）必须按**北京时间自然日**解释。若直接把 '2026-10-25' 交给
 * Postgres 转 timestamptz，会按 UTC 解析 = 北京时间当天 08:00，整段偏移 8 小时，
 * 用户问「25 号那天」就会多出前 8 小时、少掉后 8 小时。故这里显式补 +08:00。
 *
 * endExclusive=true 用于 until：纯日期顺延到次日 00:00，语义是「含当天」——
 * 「10 月 20 到 25 号」传 until=2026-10-25 时，模型期望的是包含 25 号。
 */
function coerceTimeBound(
  raw: any,
  endExclusive: boolean,
): { value: string | null; error?: string } {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const s = String(raw).trim();
  // 月/日允许 1-2 位：模型写 2026-1-5 很常见，为此报错属于无谓摩擦，
  // 补零由 toISOString 统一处理。年份仍要求 4 位。
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!dateOnly) {
    // 非纯日期：要求是带时分的时间戳，交给 Postgres 解析；形状不对就明确报错，
    // 免得 PG 抛一句模型看不懂的 "invalid input syntax for type timestamp"。
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
      return { value: null, error: `时间格式无法识别：${s}（可用 YYYY-MM-DD 或 ISO 时间戳，如 2026-10-25T08:00:00+08:00）` };
    }
    return { value: s };
  }
  const y = Number(dateOnly[1]);
  const mo = Number(dateOnly[2]);
  const d = Number(dateOnly[3]);
  const day = new Date(Date.UTC(y, mo - 1, d));
  // 挡 2026-02-31 这类：Date 会静默滚到 3 月 3 日，回读不一致即判非法
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    return { value: null, error: `日期不存在：${s}` };
  }
  const target = new Date(day.getTime() + (endExclusive ? 86400000 : 0));
  return { value: `${target.toISOString().slice(0, 10)}T00:00:00+08:00` };
}

async function searchPosts(args: any, sb: any) {
  // v0.23.2：keyword 变可选。只给时间 = 帖子流（按发布时间倒序），
  // 给关键词 = 原相关度检索。排序在 SQL 里自适应，无需在此分支。
  const rawKw = args?.keyword;
  const keyword = typeof rawKw === 'string' && rawKw.trim() ? rawKw.trim() : null;

  const limitRaw = numOrNull(args?.limit);
  const limit = limitRaw === null ? 20 : Math.max(1, Math.min(50, Math.trunc(limitRaw)));

  let since: string | null = null;
  const hours = numOrNull(args?.since_hours);
  if (hours !== null) {
    if (hours <= 0) return { error: 'since_hours 必须是大于 0 的小时数' };
    since = new Date(Date.now() - hours * 3600_000).toISOString();
  } else {
    const c = coerceTimeBound(args?.since, false);
    if (c.error) return { error: c.error };
    since = c.value;
  }
  const untilBound = coerceTimeBound(args?.until, true);
  if (untilBound.error) return { error: untilBound.error };
  const until = untilBound.value;

  if (since && until && since >= until) {
    return { error: `时间范围为空：since(${since}) 不早于 until(${until})` };
  }

  const { data, error } = await sb.rpc('search_public_posts', {
    p_keyword: keyword,
    p_since: since,
    p_until: until,
    p_limit: limit,
  });
  if (error) return { error: `检索帖子失败: ${error.message}` };

  // 0011 起 RPC 返回 { total_matched, count, posts }：total 必须是命中总数，
  // 不能再用数组长度——那会把「命中 500 条、只取 20 条」错报成「命中 20 条」。
  const posts = Array.isArray(data?.posts) ? data.posts : [];
  return {
    keyword,
    total: numOrNull(data?.total_matched) ?? posts.length,
    count: posts.length,
    since,
    until,
    posts,
  };
}

// find_nearby 输出 → structuredContent（方案二：三类全量，同一份数据同时喂模型与 widget）。
// v0.13.0：widget 模板改绑到 find_nearby（OpenAI Apps 模式——数据工具即渲染工具，
// 模型自然会调的那个工具负责出 UI）。此前绑在独立的 render_nearby_widget 上，模型
// 只调 find_nearby，widget 永不触发（审计日志实锤：resources/read 有、render 调用 0 次）。
// v0.13.1：补 outputSchema。SDK 的 validateToolOutput 会**严格校验** structuredContent
// 是否匹配 outputSchema，不匹配即整个工具报错，故此处逐字段显式清洗类型，不依赖
// 上游 RPC 的 nullable/类型细节。
const LOCATION_SCHEMA = z.union([
  z.object({ lat: z.number(), lng: z.number(), precise: z.boolean() }),
  z.null(),
]);

// 组件只画数字人卡片，最多渲染 20 条；structuredContent 同时进模型上下文，
// 故三类各截断到该上限（完整数据仍在 content 文本里给模型）。
const COMPONENT_MAX_ITEMS = 20;

function numOrNull(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function strOrNull(v: any): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function locOrNull(v: any) {
  const lat = numOrNull(v?.lat);
  const lng = numOrNull(v?.lng);
  if (lat === null || lng === null) return null;
  return { lat, lng, precise: v?.precise === true };
}

/** v0.14.9：帖子作者公开资料。字段与 buildAuthor 严格一一对应
 * （SDK 会严格校验 structuredContent 是否匹配 outputSchema）。 */
const AUTHOR_SCHEMA = z
  .object({
    id: z.string(),
    display_name: z.string().nullable(),
    username: z.string().nullable(),
    avatar_url: z.string().nullable(),
    bio: z.string().nullable(),
    profile_url: z.string(),
  })
  .nullable();

const FIND_NEARBY_OUTPUT_SCHEMA = z.object({
  center: z.object({ lat: z.number(), lng: z.number(), radius_meters: z.number() }).nullable(),
  place: z.string().nullable(),
  // v0.13.5：地名模糊匹配的实际定位说明（仅按 place 查询时存在）
  geocode_note: z.string().nullable(),
  total: z.number(),
  count: z.number(),
  digital_humans: z.array(
    z.object({
      kind: z.literal('digital_human'),
      id: z.string(),
      name: z.string().nullable(),
      // v0.13.5：详情/对话深链
      // v0.14.8：补 describe——两条 URL 仅差 view=panel，模型此前无字段级语义
      // 提示，会把它们当成同一目标合并（用户实测复现）。
      detail_url: z
        .string()
        .nullable()
        .describe(
          '角色主页链接（地图定位 + 资料面板：简介/收藏/开始对话）。与 chat_url 不是同一页面，请以「查看资料」呈现',
        ),
      chat_url: z
        .string()
        .nullable()
        .describe(
          '直接进入与该数字人聊天窗的链接。与 detail_url 不是同一页面，请以「开始聊天」呈现',
        ),
      description: z.string().nullable(),
      avatar_url: z.string().nullable(),
      is_robot: z.boolean().nullable(),
      location_name: z.string().nullable(),
      location: LOCATION_SCHEMA,
      distance_meters: z.number(),
    }),
  ),
  users: z.array(
    z.object({
      kind: z.literal('user'),
      id: z.string(),
      display_name: z.string().nullable(),
      avatar_url: z.string().nullable(),
      location: LOCATION_SCHEMA,
      // v0.13.5：补distance_meters（原先缺失导致摘要里地点静默丢失）
      distance_meters: z.number(),
    }),
  ),
  posts: z.array(
    z.object({
      kind: z.literal('post'),
      id: z.string(),
      content: z.string().nullable(),
      // v0.14.3：帖子头图缩略（null = 无图，widget 回退「帖」字圆块）
      image_url: z.string().nullable(),
      // v0.13.5：帖子详情深链（组件卡片与模型引用都用它）
      post_url: z.string().nullable(),
      author_id: z.string().nullable(),
      // v0.14.9：作者公开资料（头像/昵称/简介/主页）
      author: AUTHOR_SCHEMA,
      location_name: z.string().nullable(),
      location: LOCATION_SCHEMA,
      likes_count: z.number(),
      comments_count: z.number(),
      created_at: z.string().nullable(),
      distance_meters: z.number(),
    }),
  ),
});

function nearbyStructuredContent(out: any, place: string | null) {
  // v0.13.5：users 分支原先没有距离字段（shapeUser 不产出），而摘要与组件都需要。
  const clat = numOrNull(out?.center?.lat);
  const clng = numOrNull(out?.center?.lng);
  const distFromCenter = (loc: any): number => {
    const la = numOrNull(loc?.lat);
    const ln = numOrNull(loc?.lng);
    if (clat == null || clng == null || la == null || ln == null) return 0;
    return Math.round(distanceMeters(clat, clng, la, ln));
  };
  const src = Array.isArray(out?.digital_humans) ? out.digital_humans : [];
  const digital_humans = src
    .slice()
    .sort((a: any, b: any) => (a?.distance_meters ?? 0) - (b?.distance_meters ?? 0))
    .slice(0, COMPONENT_MAX_ITEMS)
    .map((d: any) => ({
      kind: 'digital_human' as const,
      id: String(d?.id ?? ''),
      name: strOrNull(d?.name),
      // v0.13.5：补详情/对话深链，供组件卡片点击直达
      // （chat_url 走地图页分享深链：/map?type=&id=&lat=&lng=，打开即定位并弹聊天窗）
      // v0.14.6：由 /chat?digital_human_id= 改为 /map 深链——/chat 页对原生数字人
      // 组件错配（只渲染 OpenClaw 聊天窗，原生数字人发消息必 400），且地图深链
      // 顺带解决定位；坐标无效时传 0,0 占位（地图页对退化坐标有兜底：以数字人
      // 实际位置定位，见 src/app/(app)/map/page.tsx 分享 effect）。
      // v0.14.7：detail_url 改走 /map 深链 + view=panel。原值
      // `/digital-humans/{id}` 是**死链**——该路由只有一个 edit 子目录、没有
      // page.tsx，线上实测 307 跳 /register?next=... → 登录后落到 404 页
      // （用户在 ChatGPT 点「查看资料」实测复现）。view=panel 是地图页分享
      // effect 早已支持的既有分支：定位 + 弹出 DigitalHumanDetailPanel
      // （头像/简介/收藏数/开始聊天/现场打卡），前端零改动。
      detail_url: d?.id
        ? `${SITE_URL}/map?type=${d?.is_robot ? 'openclaw_robot' : 'digital_human'}&id=${encodeURIComponent(d.id)}&lat=${numOrNull(d?.location?.lat) ?? 0}&lng=${numOrNull(d?.location?.lng) ?? 0}&view=panel`
        : null,
      chat_url: d?.id
        ? `${SITE_URL}/map?type=${d?.is_robot ? 'openclaw_robot' : 'digital_human'}&id=${encodeURIComponent(d.id)}&lat=${numOrNull(d?.location?.lat) ?? 0}&lng=${numOrNull(d?.location?.lng) ?? 0}`
        : null,
      description: clampDesc(d?.description),
      avatar_url: mediaUrlOrNull(d?.avatar_url),
      is_robot: typeof d?.is_robot === 'boolean' ? d.is_robot : null,
      location_name: strOrNull(d?.location_name),
      location: locOrNull(d?.location),
      distance_meters: numOrNull(d?.distance_meters) ?? 0,
    }));

  const users = (Array.isArray(out?.users) ? out.users : [])
    .slice(0, COMPONENT_MAX_ITEMS)
    .map((u: any, i: number) => ({
      kind: 'user' as const,
      id: String(u?.id ?? ''),
      display_name: strOrNull(u?.display_name),
      avatar_url: mediaUrlOrNull(u?.avatar_url),
      location: locOrNull(u?.location),
      // v0.13.5：shapeUser 不产出距离，但摘要与组件都需要它
      // （原先摘要读 u.location_name/u.bio 这两个不存在的字段，导致地点静默丢失）。
      // nearbyStructuredContent 拿得到 out.center，故在此按坐标重算。
      distance_meters: distFromCenter(out?.center, u?.location),
    }));

  const posts = (Array.isArray(out?.posts) ? out.posts : [])
    .slice(0, COMPONENT_MAX_ITEMS)
    .map((p: any) => ({
      kind: 'post' as const,
      id: String(p?.id ?? ''),
      // v0.13.4：原先原样透传完整正文，实测最长一条 48646 字符、20 条可轻松
      // 撑爆模型上下文。组件只画摘要，这里同步截断；完整原文仍在 content 里。
      content: excerpt(p?.content),
      // v0.14.3：帖子头图（widget 卡片缩略图；null → 「帖」字圆块）
      image_url: strOrNull(p?.image_url),
      // v0.13.5：同上，find_nearby.posts 也补 post_url
      post_url: p?.id ? `${SITE_URL}/posts/${p.id}` : null,
      author_id: strOrNull(p?.author_id),
      // v0.14.9：作者公开资料（已在 findNearby 里组装成对象透传）
      author: p?.author ?? null,
      location_name: strOrNull(p?.location_name),
      location: locOrNull(p?.location),
      likes_count: numOrNull(p?.likes_count) ?? 0,
      comments_count: numOrNull(p?.comments_count) ?? 0,
      created_at: strOrNull(p?.created_at),
      distance_meters: numOrNull(p?.distance_meters) ?? 0,
    }));

  const cLat = numOrNull(out?.center?.lat);
  const cLng = numOrNull(out?.center?.lng);
  const cRadius = numOrNull(out?.center?.radius_meters);

  return {
    center:
      cLat === null || cLng === null
        ? null
        : { lat: cLat, lng: cLng, radius_meters: cRadius ?? 0 },
    place: strOrNull(place),
    geocode_note: strOrNull(out?.geocode_note),
    total: digital_humans.length,
    count: digital_humans.length + users.length + posts.length,
    digital_humans,
    users,
    posts,
  };
}

// ---- v0.13.4：多工具共用同一个 widget 模板 ----
// 官方 kitchen_sink 示例里多个工具指向同一个 TEMPLATE_URI，故无需为每个工具
// 做一套组件。做法：给目标工具补outputSchema + structuredContent + _meta 绑定，
// 组件侧按 structuredContent.view 分派渲染，不认识的形状回退到数字人列表。
//
// 三条清洗约定（均为实测数据踩出来的）：
// ① 帖子正文是完整原文，51 条合计 23.3 万字符（p50=45 但 p90=19534、最长 48646）
//    → 组件只画摘要，截断到 120 字。完整原文仍在 content 里供模型使用。
// ② business_districts 的 name 混着真实地名与坐标串（如 "39.909341, 116.396860"，
//    9 条里 5 条是坐标）→ 正则识别坐标串并剔除，否则卡片显示成乱码一样的东西。
// ③ campaigns 里多为草稿（4 条里 3 条 status=draft 且 cover_image=null）
//    → 只渲染已发布的，否则出一排空白占位卡。

const EXCERPT_MAX_CHARS = 120;

/** 数字人简介单条上限。实测 11 条合计 8,900 字符，个别 3,000+ 字人设会撑体积。 */
const DESC_MAX_CHARS = 300;

/**
 * 🔴 v0.13.5 —— 图片 URL 清洗（实测数据踩出来的最大体积坑）。
 *
 * 实测 find_nearby(place:故宫) 的 content[0].text 有 456,745 字符，其中 **71.4%
 * 是 avatar_url 一个字段**——因为有数据把位图矢量化成内联 SVG 存进头像列：
 *   data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmci...
 *   单字段 324,666 字符（base64 解码后是 243,428 字符的 SVG 源码）
 * 其他 10 条都是 37~187 字符的普通 https URL，即这是**单点脏数据**而非普遍形态。
 *
 * 后果：45 万字符 ≈ 285,466 token ≈ GPT-4 128K 上下文的 2.2 倍，**一次工具调用
 * 就会撑爆模型上下文**，而且是静默的（无报错、无告警，用户只会觉得"插件很笨"）。
 *
 * 这里统一判定并置 null；组件侧 normAvatar() 本就有 null 兜底（退化成彩色字母
 * 头像），所以视觉上零损失。真实修复应在数据层（该条头像重新上传为图片文件）。
 */
const MAX_URL_CHARS = 2048;

/** 简介/描述单条上限：压到 300 字，超出截断。 */
function clampDesc(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const clean = v.replace(/\s+/g, ' ').trim();
  if (clean.length <= DESC_MAX_CHARS) return clean;
  return clean.slice(0, DESC_MAX_CHARS).trim() + '…';
}

function mediaUrlOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  // 内联 data URL 一律丢弃：无论是位图 base64 还是矢量化 SVG 源码，
  // 对模型而言都毫无信息量，却可能单条撑爆上下文。
  if (v.startsWith('data:')) return null;
  // 超长 URL 同样是异常形态（非 data URL 但体积失控）。
  if (v.length > MAX_URL_CHARS) return null;
  // v0.14.4：域名白名单。widget CSP（_meta.ui.csp.resourceDomains +
  // openai/widgetCSP）只放行 SITE_URL 与 SUPABASE_URL——v0.13.4 实证
  // 可过创建校验的最小形态，加域名有触发「部分应用设置未通过验证」的
  // 风险（见 §红线）。而 posts.image_url 实测域名极杂：supabase.co(730) /
  // unsplash(94) / picsum(5) / bing(1) / volces(1) / 残缺相对路径
  // （caocao.svg、baozheng.svg 各 1）。非白名单图进了 widget 只会被
  // CSP 拦成破图，不如数据层挡掉 → 回退「帖」字圆块（视觉零破坏）。
  if (!mediaHostAllowed(v)) return null;
  return v;
}

/** v0.14.9：作者头像地址归一化。
 * 生产库 127 个用户存的是相对路径 `/logo.png`（历史默认占位图），
 * 直接进 mediaUrlOrNull 会因 new URL() 失败被置 null；补成站点绝对地址
 * 后落在 SITE_URL 域（CSP 白名单内），可正常显示站点 logo。
 * 其余外域（dicebear/googleusercontent/volces，占公开帖 6%）仍被白名单挡掉
 * → 组件回退「姓名首字」圆块。扩 CSP 属独立决策（有创建校验风险），本版不动。 */
function authorAvatarOrNull(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith('/')) return mediaUrlOrNull(`${SITE_URL}${raw}`);
  return mediaUrlOrNull(raw);
}

/** v0.14.9：把 RPC 返回的作者字段组装成统一 author 对象。
 * 数据来源两形：nearby_public_posts 是平列（author_name/...），
 * search_public_posts 与 get_public_post_detail 是嵌套 json（author{...}）。
 * 字段白名单固定为 昵称/登录名/头像/简介；profile_url 在此拼（RPC 不依赖域名）。
 * ⚠️ users 表 RLS 开启、anon 不可直读，故这里的数据一律来自 SECURITY DEFINER RPC。 */
function buildAuthor(
  id: unknown,
  displayName: unknown,
  username: unknown,
  avatar: unknown,
  bio: unknown,
) {
  const uid = strOrNull(id);
  if (!uid) return null;
  const rawBio = strOrNull(bio);
  return {
    id: uid,
    display_name: strOrNull(displayName) ?? strOrNull(username),
    username: strOrNull(username),
    avatar_url: authorAvatarOrNull(strOrNull(avatar)),
    // 给模型的简介压缩到 80 字；完整长文交给 get_post_detail 场景
    bio: rawBio ? (rawBio.length > 80 ? `${rawBio.slice(0, 80).trim()}…` : rawBio) : null,
    profile_url: `${SITE_URL}/users/${encodeURIComponent(uid)}`,
  };
}

/** v0.14.4：白名单 = 本项目 Supabase Storage 域 + 站点主域。 */
// v0.14.5：放行 unsplash/picsum（生产库 posts 图 94+5 条，见头注）。
// 单变量增量：仅扩具体域名，不碰 CSP 其他键；与 resourceDomains 保持一致。
const EXTRA_MEDIA_HOSTS = ['images.unsplash.com', 'picsum.photos'];

function mediaHostAllowed(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false; // 残缺相对路径（caocao.svg 等历史脏数据）
  }
  const supabaseHost = SUPABASE_URL
    ? (() => {
        try {
          return new URL(SUPABASE_URL).hostname;
        } catch {
          return '';
        }
      })()
    : 'xhahsqbaohraqrdhtvay.supabase.co';
  let siteHost = '';
  try {
    siteHost = new URL(SITE_URL).hostname;
  } catch {
    /* SITE_URL 恒为合法绝对 URL，防御性兜底 */
  }
  return host === supabaseHost
    || (siteHost !== '' && host === siteHost)
    || EXTRA_MEDIA_HOSTS.includes(host);
}

/** 坐标串形如 "39.909341, 116.396860" —— 上游商圈数据源没给地名的退化情况。 */
function looksLikeCoords(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(v.trim());
}

function excerpt(v: unknown): string | null {
  const s = typeof v === 'string' ? v : null;
  if (!s) return null;
  // 帖子正文实测是富文本 HTML（如 "<p>正文</p>"），直接展示会把标签当文本。
  // 这里剥掉常见块级/换行标签后再压空白，避免 widget 里出现「<p>」这种噪声。
  const stripped = s
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return stripped.length <= EXCERPT_MAX_CHARS ? stripped : stripped.slice(0, EXCERPT_MAX_CHARS).trim() + '…';
}

// 帖子详情（search_posts 与 find_nearby.posts 字段不同：前者 lat/lng 平铺，
// 后者 location 对象），故清洗函数各自处理。
const POST_CARD_SCHEMA = z.object({
  kind: z.literal('post'),
  id: z.string(),
  // v0.13.5：帖子详情深链
  post_url: z.string().nullable(),
  // v0.14.4：头图（search_public_posts RPC 补返回 image_url，与 find_nearby 对齐）
  image_url: z.string().nullable(),
  excerpt: z.string().nullable(),
  location_name: z.string().nullable(),
  location: LOCATION_SCHEMA,
  likes_count: z.number(),
  comments_count: z.number(),
  created_at: z.string().nullable(),
  distance_meters: z.number(),
  // v0.14.9：作者公开资料（search_public_posts RPC 内嵌 author）
  author: AUTHOR_SCHEMA,
});

const ATTRACTION_CARD_SCHEMA = z.object({
  kind: z.literal('attraction'),
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  attraction_type: z.string().nullable(),
  image_url: z.string().nullable(),
  location: LOCATION_SCHEMA,
  distance_meters: z.number(),
});

const CAMPAIGN_CARD_SCHEMA = z.object({
  kind: z.literal('campaign'),
  id: z.string(),
  name: z.string().nullable(),
  slug: z.string().nullable(),
  description: z.string().nullable(),
  theme_color: z.string().nullable(),
  act_count: z.number(),
});

const SEARCH_POSTS_OUTPUT_SCHEMA = z.object({
  view: z.literal('posts'),
  keyword: z.string().nullable(),
  total: z.number(),
  count: z.number(),
  posts: z.array(POST_CARD_SCHEMA),
});

const NEARBY_ATTRACTIONS_OUTPUT_SCHEMA = z.object({
  view: z.literal('attractions'),
  place: z.string().nullable(),
  // v0.13.5
  geocode_note: z.string().nullable(),
  total: z.number(),
  count: z.number(),
  attractions: z.array(ATTRACTION_CARD_SCHEMA),
  business_districts: z.array(ATTRACTION_CARD_SCHEMA),
});

const LIST_CAMPAIGNS_OUTPUT_SCHEMA = z.object({
  view: z.literal('campaigns'),
  total: z.number(),
  count: z.number(),
  campaigns: z.array(CAMPAIGN_CARD_SCHEMA),
});

function searchPostsStructuredContent(out: any, keyword: string | null) {
  const all = Array.isArray(out?.posts) ? out.posts : [];
  // v0.13.5：原先 total = posts.length（已slice 到 20），实测命中 51 条时
  // 会向模型报「命中 20 条」——静默错数。真实命中数以原始数组长度为准。
  const total = numOrNull(out?.total) ?? all.length;
  const posts = all
    .slice(0, COMPONENT_MAX_ITEMS)
    .map((p: any) => ({
      kind: 'post' as const,
      id: String(p?.id ?? ''),
      // v0.13.5：补 post_url，组件卡片据此跳转到/posts/{id}（公开路由，
      // 已在 paywall-guard 的 PUBLIC_PREFIXES 里）。模型也能直接引用这个 URL。
      post_url: p?.id ? `${SITE_URL}/posts/${p.id}` : null,
      // v0.14.4：头图（RPC 已补 image_url；mediaUrlOrNull 挡 data URL/超长异常值）
      image_url: mediaUrlOrNull(p?.image_url),
      excerpt: excerpt(p?.content),
      location_name: strOrNull(p?.location_name),
      // v0.14.11：改走 locationFor()。此前 locOrNull({lat,lng}) 只把 precise 标成 false，
      // **坐标本身仍是原值**——标着「不精确」却是全精度，比赤裸透传更危险。
      // 帖子属个人数据，与 find_nearby 的帖子分支同一口径。
      location: locationFor(p),
      likes_count: numOrNull(p?.likes_count) ?? 0,
      comments_count: numOrNull(p?.comments_count) ?? 0,
      created_at: strOrNull(p?.created_at),
      distance_meters: numOrNull(p?.distance_meters) ?? 0,
      // v0.14.9：作者公开资料。search_public_posts 返回的是嵌套 author 对象
      // （json_build_object），这里统一走 buildAuthor 归一化头像域名。
      author: buildAuthor(
        p?.author?.id,
        p?.author?.display_name,
        p?.author?.username,
        p?.author?.avatar_url,
        p?.author?.bio,
      ),
    }));
  return {
    view: 'posts' as const,
    keyword: strOrNull(keyword),
    total,
    count: posts.length,
    posts,
  };
}

function nearbyAttractionsStructuredContent(out: any, place: string | null) {
  const map = (arr: any) =>
    (Array.isArray(arr) ? arr : [])
      // 剔除退化数据：坐标串冒充商圈名。
      .filter((x: any) => !looksLikeCoords(x?.name))
      .slice(0, COMPONENT_MAX_ITEMS)
      .map((x: any) => ({
        kind: 'attraction' as const,
        id: String(x?.id ?? ''),
        name: strOrNull(x?.name),
        description: excerpt(x?.description),
        attraction_type: strOrNull(x?.attraction_type ?? x?.type),
        image_url: mediaUrlOrNull(x?.image_url),
        location: locOrNull({ lat: x?.lat, lng: x?.lng }),
        distance_meters: numOrNull(x?.distance_meters) ?? 0,
      }));
  const attractions = map(out?.attractions);
  const business_districts = map(out?.business_districts);
  return {
    view: 'attractions' as const,
    place: strOrNull(place),
    geocode_note: strOrNull(out?.geocode_note),
    total: attractions.length,
    count: attractions.length + business_districts.length,
    attractions,
    business_districts,
  };
}

function listCampaignsStructuredContent(out: any) {
  const campaigns = (Array.isArray(out?.campaigns) ? out.campaigns : [])
    // 只渲染已发布的：草稿无封面无打卡点，画出来是空白占位卡。
    .filter((c: any) => c?.status === 'published')
    .slice(0, COMPONENT_MAX_ITEMS)
    .map((c: any) => ({
      kind: 'campaign' as const,
      id: String(c?.id ?? ''),
      name: strOrNull(c?.name),
      slug: strOrNull(c?.slug),
      description: excerpt(c?.description),
      theme_color: strOrNull(c?.theme_color),
      act_count: Array.isArray(c?.acts) ? c.acts.length : 0,
    }));
  return {
    view: 'campaigns' as const,
    total: campaigns.length,
    count: campaigns.length,
    campaigns,
  };
}

// ---- 工具结果包装（CallToolResult 形态）----

// 🔴 v0.13.5 —— content[0].text 必须是人话摘要，不能是数据转储。
//
// 官方 reference.md:553-554 的示例即如此：content 给模型一句 formatIntro(...)，
// structuredContent 才给结构化数据。此前本文件对find_nearby/search_posts 用
// `JSON.stringify(out, null, 2)` 当 text，实测一次调用 456,745 字符
//（≈285,466 token，是 128K 上下文的 2.2 倍）→ 无 widget 能力的 agent
//（Claude / Cursor / 国产 App）一次调用就爆上下文，且静默无报错。
//
// 这里改为「位置 + 数量 + 每项一行关键信息 + 完整版链接」，控制在几 KB 内。
const SITE = 'https://global.powpow.online';

function fmtDist(m: unknown): string {
  if (typeof m !== 'number' || !Number.isFinite(m)) return '';
  if (m < 1000) return `${Math.round(m)} 米`;
  return `${(m / 1000).toFixed(1)} 公里`;
}

function oneLine(v: unknown, max = 60): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() + '…' : s;
}

/** 组装「给模型看的摘要行」，统一处理空列表。 */
function bullet(lines: string[], label: string, items: any[], render: (it: any) => string) {
  if (!items.length) return;
  lines.push('', `${label}（${items.length}）：`);
  for (const it of items.slice(0, 20)) {
    const s = render(it);
    if (s) lines.push(`- ${s}`);
  }
  if (items.length > 20) lines.push(`- …另有 ${items.length - 20} 条`);
}

function summaryFindNearby(sc: any, place: string | null): string {
  const c = sc?.center;
  const where = place || (c ? `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}` : '');
  const lines: string[] = [];
  lines.push(
    `PowPow 附近发现：${where || '当前位置'}${c?.radius_meters ? ` 半径 ${fmtDist(c.radius_meters)}` : ''}`,
  );
  // v0.13.5：若地名是模糊匹配来的，明确告诉模型实际定位到了哪个 POI，
  // 让它有机会提醒用户「你要找的是不是这里」。
  if (sc?.geocode_note) lines.push(`注意：${sc.geocode_note}。若与用户想问的地点不符，请先与用户确认。`);
  const dh = sc?.digital_humans || [];
  const us = sc?.users || [];
  const po = sc?.posts || [];
  lines.push(`共 ${dh.length} 个公开数字人、${us.length} 位用户、${po.length} 条公开帖子。`);
  // v0.14.8：每位数字人下面直接给出两条**带用途标注**的链接。
  // 背景：v0.14.7 把 detail_url 也改成 /map 深链后，它与 chat_url 只差
  // `&view=panel` 一个参数，而此前摘要里根本没出现过这两条 URL（只有名字/
  // 位置/距离/简介）——模型只能从 structuredContent 里猜，于是把两条几乎
  // 同形的链接判为重复，在图一里合并成了一条「打开角色主页与聊天入口」。
  // 依据 build-mcp-server.md:138-141：content 是「帮助模型回答用户」的文本，
  // 模型怎么写链接以此为主要依据；structuredContent 只是数据。
  // 故在 content 里显式区分两条链，模型才有依据分别呈现。
  bullet(lines, '数字人', dh, (d: any) =>
    [oneLine(d.name, 20), d.location_name ? `位于 ${oneLine(d.location_name, 20)}` : '',
     d.distance_meters != null ? `距你 ${fmtDist(d.distance_meters)}` : '',
     oneLine(d.description, 50)].filter(Boolean).join(' · ')
    + (d.detail_url ? `\n  资料（打开角色主页/资料面板）：${d.detail_url}` : '')
    + (d.chat_url ? `\n  对话（直接进入聊天窗）：${d.chat_url}` : ''));
  if (dh.length) {
    lines.push(
      '链接说明：以上每位数字人都有「资料」与「对话」两条**不同**链接——前者打开角色主页（地图+资料面板，可看简介并「开始对话」），后者直接进入聊天窗。请分别以「查看资料」「开始聊天」呈现，不要合并、不要只给一条。',
    );
  }
  bullet(lines, '用户', us, (u: any) =>
    // v0.13.5：原先读u.location_name / u.bio，但 shapeUser 的输出只有
    // display_name / avatar_url / location（无 location_name、无 bio），
    // 导致真实用户的所在地点在摘要里永远静默消失。改读 location 坐标。
    [oneLine(u.display_name, 20),
     u.location ? `位置 ${Number(u.location.lat).toFixed(3)}, ${Number(u.location.lng).toFixed(3)}` : '',
     u.distance_meters != null ? `距你 ${fmtDist(u.distance_meters)}` : '',
    ].filter(Boolean).join(' · '));
  bullet(lines, '帖子', po, (p: any) =>
    [oneLine(p.author?.display_name, 16) ? `@${oneLine(p.author?.display_name, 16)}` : '',
     oneLine(p.content, 50), p.location_name ? `在 ${oneLine(p.location_name, 16)}` : '',
     p.likes_count != null ? `${p.likes_count} 赞` : ''].filter(Boolean).join(' · '));
  lines.push('', `完整版（含地图、详情与互动）：${SITE}/map`);
  return lines.join('\n');
}

/** ISO → 北京时间「YYYY-MM-DD HH:mm」。
 *
 *  v0.23.2：Edge（Deno）系统时区是 UTC，此前各处摘要都是 `slice(0,16).replace('T',' ')`
 *  直接截 ISO 串——显示出来的时间比北京时间早 8 小时。这一版的主题就是时间，
 *  不能在摘要里再错一次。
 */
function fmtCnTime(v: any): string {
  const s = strOrNull(v);
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ');
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 把检索的时间窗渲染成人话，让模型能对用户复述「查的是哪一段」。 */
function fmtWindow(since: any, until: any): string {
  const a = fmtCnTime(since);
  const b = fmtCnTime(until);
  if (a && b) return `${a} 至 ${b}`;
  if (a) return `${a} 之后`;
  if (b) return `${b} 之前`;
  return '';
}

function summaryPosts(out: any, keyword: string | null): string {
  const po = Array.isArray(out?.posts) ? out.posts : [];
  const total = numOrNull(out?.total) ?? po.length;
  const win = fmtWindow(out?.since, out?.until);
  const lines: string[] = [];
  lines.push(
    `PowPow 帖子${keyword ? `检索「${keyword}」` : '时间流'}${win ? `（${win}）` : ''}：` +
      `命中 ${total} 条，按${keyword ? '相关度' : '发布时间倒序'}列出 ${po.length} 条。`,
  );

  if (!po.length) {
    // 关键防呆：日活低的时段本来就是空的，模型若拿别的时间凑数就重演了
    // 「把 7 月的帖子冒充今天」那个错。
    lines.push(
      '',
      '这段时间没有任何公开帖子。请如实告诉用户该时段无新帖，不要用其他时间的内容替代；' +
        '若用户想看，可放宽时间范围或去掉时间条件。',
    );
    return lines.join('\n');
  }

  lines.push('');
  for (const p of po) {
    const body = stripRichText(p?.content);
    // 评论数在这一版里已经修过漂移，这里一并显示——回复前先看有没有人聊过
    const bits = [
      `@${strOrNull(p?.author?.display_name) ?? '匿名'}`,
      body ? `${body.slice(0, 60)}${body.length > 60 ? '…' : ''}` : '',
      p?.location_name ? `在 ${p.location_name}` : '',
      p?.likes_count != null ? `${p.likes_count} 赞` : '',
      p?.comments_count != null ? `${p.comments_count} 评论` : '',
      fmtCnTime(p?.created_at),
      // v0.23.3：只显示 8 位短 id——模型抄 36 位会出错，8 位它抄得准，
      // 服务端 resolve_public_post_id 也认（见 shortId 的注释）。
      `id: ${shortId(p?.id)}`,
    ].filter(Boolean);
    lines.push(`- ${bits.join(' · ')}`);
  }
  lines.push(
    '',
    '（上面每条的 id 是 8 位短 id，可直接传给 get_post_detail / get_post_replies / reply_to_post）',
    `完整版：${SITE}/posts`,
  );
  return lines.join('\n');
}

function summaryAttractions(sc: any, place: string | null): string {
  const at = sc?.attractions || [];
  const bd = sc?.business_districts || [];
  const lines: string[] = [];
  lines.push(`PowPow 附近地点${place ? `（${place}）` : ''}：${at.length} 个景点、${bd.length} 个商圈。`);
  if (sc?.geocode_note) lines.push(`注意：${sc.geocode_note}。若与用户想问的地点不符，请先与用户确认。`);
  bullet(lines, '景点', at, (x: any) =>
    [oneLine(x.name, 20), x.attraction_type ? oneLine(x.attraction_type, 24) : '',
     x.distance_meters != null ? fmtDist(x.distance_meters) : '',
     oneLine(x.description, 50)].filter(Boolean).join(' · '));
  bullet(lines, '商圈', bd, (x: any) =>
    [oneLine(x.name, 20), x.distance_meters != null ? fmtDist(x.distance_meters) : '']
      .filter(Boolean).join(' · '));
  lines.push('', `完整版（含地图）：${SITE}/map`);
  return lines.join('\n');
}

function summaryCampaigns(sc: any): string {
  const cs = sc?.campaigns || [];
  const lines: string[] = [];
  lines.push(`PowPow 公开活动：${cs.length} 个。`);
  bullet(lines, '活动', cs, (c: any) =>
    [oneLine(c.name, 24), c.theme_color ? `主题色 ${oneLine(c.theme_color, 9)}` : '',
     c.act_count != null ? `${c.act_count} 个打卡点` : '',
     oneLine(c.description, 50)].filter(Boolean).join(' · '));
  lines.push('', `完整版：${SITE}/campaign`);
  return lines.join('\n');
}

/** jsonResult 的兜底：只对 error 与极小payload 做原样序列化，其余走摘要。 */
function isErrorPayload(payload: unknown): boolean {
  return !!(payload && typeof payload === 'object' && (payload as any).error);
}

function jsonResult(payload: unknown) {
  const isErr = !!(payload && typeof payload === 'object' && (payload as any).error);
  if (isErr) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: summarizeUnknown(payload) }],
    isError: false,
  };
}

/**
 * 帖子详情摘要。工具描述承诺「完整内容」，故正文给到DETAIL_BODY_MAX_CHARS
 * （远大于列表场景的 120 字），但仍设上限防止最长的 4.8 万字符正文灌爆上下文。
 * 富文本 HTML 必须先剥标签，且正文里嵌了位置胶囊的内联 SVG data URL
 * （实测正文里带 data:image/svg+xml 的 style 背景图），一并清掉。
 */
const DETAIL_BODY_MAX_CHARS = 4000;

function stripRichText(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  if (!s) return '';
  return s
    // 内联 SVG data URL（位置胶囊的图标），长度可达万级
    .replace(/data:image\/[a-z+]+;[^"')\s]{40,}/gi, '')
    // 富文本标签
    .replace(/<[^>]*>/g, ' ')
    // HTML 实体
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function summaryPostDetail(data: any): string {
  const p = data?.post ?? {};
  const body = stripRichText(p.content);
  const shown = body.length > DETAIL_BODY_MAX_CHARS
    ? body.slice(0, DETAIL_BODY_MAX_CHARS).trim() + `…（正文共 ${body.length} 字，已截断）`
    : body;
  const lines: string[] = [];
  // v0.14.9：作者改为 RPC 新增的嵌套 author 对象（原先读 p.author_name，
  // 但 get_public_post_detail 从未返回该字段 → 标题行恒退回帖子 id）。
  const authorName = strOrNull(p?.author?.display_name) ?? strOrNull(p?.author?.username);
  lines.push(`帖子：${authorName ? `@${authorName} 的帖子` : (p.id ?? '（无标题）')}`);
  if (p.id) lines.push(`链接：${SITE_URL}/posts/${p.id}`);
  if (authorName) {
    const extra = [
      p?.author?.profile_url ? `主页 ${p.author.profile_url}` : '',
      p?.author?.avatar_url ? `头像 ${p.author.avatar_url}` : '',
      p?.author?.bio ? `简介：${p.author.bio}` : '',
    ].filter(Boolean).join(' · ');
    lines.push(`作者：${authorName}${extra ? `（${extra}）` : ''}`);
  }
  if (p.location_name) lines.push(`位置：${p.location_name}`);
  const meta: string[] = [];
  if (typeof p.likes_count === 'number') meta.push(`${p.likes_count} 赞`);
  if (typeof p.comments_count === 'number') meta.push(`${p.comments_count} 评论`);
  if (p.created_at) meta.push(String(p.created_at).slice(0, 10));
  if (meta.length) lines.push(`互动：${meta.join(' · ')}`);
  lines.push('', shown || '（正文为空）');
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  // v0.23.1：0004 版的 RPC 把全部评论平铺返回（无作者名、无分页），
  // 0010 版收敛为「comments_total + 最新 3 条」并补上 display_name。
  // 这里不能再拿 comments.length 当总数——那是本页条数，会把 30 条说成 3 条。
  const commentsTotal = Number(data?.comments_total ?? comments.length);
  if (commentsTotal > 0) {
    lines.push('', `评论（共 ${commentsTotal} 条，这里只显示最新 ${comments.length} 条）：`);
    for (const c of comments) {
      const t = stripRichText(c?.content);
      if (!t) continue;
      // display_name 是 0010 才有的；老数据落在 user_id 上，两者都没有才算匿名
      const who = strOrNull(c?.display_name) ?? strOrNull(c?.user_id) ?? '匿名';
      lines.push(`- ${who}：${t.slice(0, 200)}`);
    }
    if (commentsTotal > comments.length) {
      lines.push('（要看完整讨论和回复关系，用 get_post_replies；这里只给个概览）');
    }
  }
  return lines.join('\n');
}

/**
 * 当前连接账号的 PowPow userId（best effort + 10 分钟缓存）。
 *
 * 为什么需要它：get_post_replies 走的是匿名 RPC，返回里只有 user_id，没有
 * 「这是你」的标记。对话一长，模型就得先调 whoami 再自己比对 id，很容易串行。
 * 这里在读取时补一次身份，好在摘要里直接把「你」标出来。
 *
 * 失败一律静默降级为 null（不标记而已），绝不能因为 whoami 抖动就让读评论失败。
 */
const SELF_ID_TTL_MS = 10 * 60 * 1000;
let cachedSelfId: { id: string | null; at: number } | null = null;

async function myPowpopUserId(accessToken: string | null): Promise<string | null> {
  if (!accessToken) return null;
  if (cachedSelfId && Date.now() - cachedSelfId.at < SELF_ID_TTL_MS) return cachedSelfId.id;
  try {
    const g = await callGateway(accessToken, 'whoami', {});
    const uid = g.ok ? (strOrNull((g.data as any)?.id) ?? null) : null;
    cachedSelfId = { id: uid, at: Date.now() };
    return uid;
  } catch {
    cachedSelfId = { id: null, at: Date.now() };
    return null;
  }
}

/**
 * 评论列表摘要（v0.23.0）。
 *
 * 每条一级评论都带「评论 id」，这是 agent 后续调用 reply_to_post 的唯一锚点——
 * 没有 id 它只能瞎猜，所以 id 单独占一行，不能混进正文。
 * 二级回复全部展示，但 RPC 每个父评论最多给 20 条，超出的用 replies_count 兜底提示。
 */
function summaryPostReplies(d: any, selfId: string | null): string {
  const post = d?.post ?? {};
  const comments = Array.isArray(d?.comments) ? d.comments : [];
  const lines: string[] = [];

  const excerpt = stripRichText(post?.excerpt);
  lines.push(`帖子：${excerpt ? excerpt.slice(0, 60) : (post?.id ?? '（未知）')}`);
  if (post?.id) lines.push(`链接：${SITE_URL}/posts/${post.id}`);
  lines.push(
    `评论：一级 ${d?.total_top_level ?? 0} 条，含回复共 ${d?.total_all ?? 0} 条` +
      `（第 ${d?.page ?? 1} 页，本页 ${comments.length} 条）`,
    '（评论 id 只显示前 8 位，这就是 reply_to_post 的 reply_to_comment_id，原样传即可）',
  );

  if (!comments.length) {
    lines.push('', '这条帖子还没有人评论。');
    return lines.join('\n');
  }

  lines.push('');
  // 标出「你」：模型看对话时不用再去比对 user_id
  const label = (name: string | null, uid: unknown): string => {
    const base = name ?? '匿名';
    const isMe = Boolean(selfId) && typeof uid === 'string' && uid === selfId;
    return isMe ? `${base}（你）` : base;
  };

  for (const c of comments) {
    const when = String(c?.created_at ?? '').slice(0, 16).replace('T', ' ');
    lines.push(`- ${label(strOrNull(c?.display_name), c?.user_id)}（${when}）`);
    const body = stripRichText(c?.content);
    lines.push(`  ${body.slice(0, 300)}${body.length > 300 ? '…' : ''}`);
    lines.push(`  [评论 id: ${shortId(c?.id)}]`);

    const replies = Array.isArray(c?.replies) ? c.replies : [];
    for (const r of replies) {
      const rt = strOrNull(r?.reply_to_display_name);
      const t = stripRichText(r?.content);
      lines.push(
        `  └ ${label(strOrNull(r?.display_name), r?.user_id)}${rt ? ` 回复 @${rt}` : ''}：` +
          `${t.slice(0, 200)}${t.length > 200 ? '…' : ''}  [id: ${shortId(r?.id)}]`,
      );
    }
    const shown = replies.length;
    const total = Number(c?.replies_count ?? shown);
    if (total > shown) lines.push(`  （另有 ${total - shown} 条回复未显示）`);
  }

  if (d?.has_more) {
    lines.push('', `还有更多一级评论，用 page=${Number(d?.page ?? 1) + 1} 继续翻。`);
  }
  return lines.join('\n');
}

/**
 * 「我帖子收到的新回复」摘要（v0.23.0）。
 *
 * 已读游标是本工具最容易踩坑的地方：模型看到内容就直接 mark_read 的话，
 * 用户下次再问就什么都查不到了。所以这里显式把「还没标已读」写进结果，
 * 让模型知道要不要传 mark_read 由用户决定。
 */
function summaryMyPostReplies(d: any): string {
  const items = Array.isArray(d?.items) ? d.items : [];
  const lines: string[] = [];

  if (d?.mode === 'window') {
    lines.push(`时间范围：最近 ${String(d?.since ?? '').slice(0, 16).replace('T', ' ')} 之后`);
  } else if (d?.cursor?.first_time) {
    lines.push('首次查看：按最近 7 天算「新」，之后会记住读到哪儿。');
  } else {
    lines.push(
      `未读：从 ${String(d?.since ?? '').slice(0, 16).replace('T', ' ')} 之后开始算` +
        (d?.marked_read ? '（本次已标为已读）' : '（尚未标为已读）'),
    );
  }

  lines.push(`共 ${d?.total ?? items.length} 条，本页显示 ${items.length} 条。`);

  if (!items.length) {
    if (d?.mode === 'window') lines.push('', '这段时间没有人回复你的帖子。');
    else lines.push('', '没有新回复——你帖子下的评论都已经看过了。');
    return lines.join('\n');
  }

  lines.push('');
  for (const it of items) {
    const when = String(it?.created_at ?? '').slice(0, 16).replace('T', ' ');
    const who = strOrNull(it?.author?.display_name) ?? strOrNull(it?.author?.username) ?? '匿名';
    const to = strOrNull(it?.reply_to_display_name);
    // reason：on_my_post = 在我帖子下；reply_to_me = 别人在别处回复我。
    // 后者才是「对话」，必须明确说出来，否则模型会把它当成又一条普通评论。
    const onMyPost = it?.reason !== 'reply_to_me';
    const where = onMyPost ? '你的帖子' : '别人的帖子';
    lines.push(`- ${who}${to && it?.is_reply ? ` 回复 @${to}` : ''}（${when}）`);
    const body = stripRichText(it?.content);
    lines.push(`  ${body.slice(0, 300)}${body.length > 300 ? '…' : ''}`);
    const postExcerpt = stripRichText(it?.post?.excerpt);
    lines.push(
      `  在${where}「${postExcerpt ? postExcerpt.slice(0, 40) : (it?.post?.id ?? '')}」下` +
        `  [评论 id: ${shortId(it?.comment_id)}] ${it?.post?.url ?? ''}`,
    );
  }

  if (d?.mode === 'unread' && !d?.marked_read) {
    lines.push('', '这些回复还没标为已读；用户确认看过之后再传 mark_read=true。');
  }
  return lines.join('\n');
}

/**
 * 发评论/回复的结果摘要（v0.23.0）。
 */
function summaryCommentCreate(d: any): string {
  const bits: string[] = [];
  if (d?.is_reply) {
    const to = strOrNull(d?.reply_to_display_name);
    bits.push(`已回复${to ? ` ${to}` : ''}的那条评论。`);
  } else {
    bits.push('评论已发出。');
  }
  bits.push(d?.content ? `内容：「${String(d.content).slice(0, 100)}」` : '');
  if (typeof d?.comments_count === 'number') {
    bits.push(`这条帖子现在 ${d.comments_count} 条评论。`);
  }
  if (d?.resurrected) {
    bits.push('这条泡泡之前已经过期，因为你的评论被延长了 24 小时。');
  }
  bits.push(`链接：${d?.url ?? `${SITE_URL}/posts/${d?.post_id ?? ''}`}`);
  return bits.filter(Boolean).join('\n');
}

/**
 * 数字人详情摘要。工具描述承诺「完整资料：人设、位置、心情、类型」，
 * 故这些字段全量输出；只有超长的人设文本才截断（persona 常排在字段表第 9 位，
 * 通用兜底只取前 8 字段会把它整条丢掉）。
 */
const PERSONA_MAX_CHARS = 2000;

function summaryDigitalHuman(d: any): string {
  const lines: string[] = [];
  const name = strOrNull(d?.name) ?? strOrNull(d?.id) ?? '未命名';
  lines.push(`数字人：${name}`);
  if (d?.id) {
    // v0.14.7：详情链接同步改地图深链 + view=panel——原 `/digital-humans/{id}`
    // 无对应 page.tsx（该路由只有 edit 子目录），点开必 404。
    const locD = d?.location;
    const dhTypeD = d?.is_robot ? 'openclaw_robot' : 'digital_human';
    const coordD = `&lat=${numOrNull(locD?.lat) ?? 0}&lng=${numOrNull(locD?.lng) ?? 0}`;
    lines.push(`详情：${SITE_URL}/map?type=${dhTypeD}&id=${d.id}${coordD}&view=panel`);
    // v0.14.6：对话链接改地图深链（同 find_nearby.chat_url 口径）。
    // 坐标无效传 0,0 占位，地图页分享 effect 对退化坐标有兜底定位。
    lines.push(`对话：${SITE_URL}/map?type=${dhTypeD}&id=${d.id}${coordD}`);
  }
  if (strOrNull(d?.category)) lines.push(`分类：${d.category}`);
  if (d?.is_robot != null) lines.push(`类型：${d.is_robot ? '机器人' : '原生'}`);
  const loc = d?.location;
  const locName = strOrNull(loc?.location_name) ?? strOrNull(d?.location_name);
  if (locName) lines.push(`位置：${locName}`);
  const desc = strOrNull(d?.description);
  if (desc) lines.push('', `简介：${desc.length > PERSONA_MAX_CHARS ? desc.slice(0, PERSONA_MAX_CHARS) + '…' : desc}`);
  const persona = strOrNull(d?.persona);
  if (persona) {
    lines.push('', `人设：${persona.length > PERSONA_MAX_CHARS ? persona.slice(0, PERSONA_MAX_CHARS) + `…（共 ${persona.length} 字，已截断）` : persona}`);
  } else {
    lines.push('', '人设：（该数字人未填写）');
  }
  if (strOrNull(d?.mood)) lines.push('', `心情：${d.mood}`);
  return lines.join('\n');
}

/**
 * 未绑 widget 的只读工具的通用摘要兜底（jsonResult 用）。
 * 刻意保守：只输出「字段名: 短值」清单，完整数据靠模型按需再查，
 * 避免再次出现单次数万字符的转储。
 */
function summarizeUnknown(payload: any): string {
  const ser = (v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (typeof s !== 'string') return '';
    const clean = s.replace(/\s+/g, ' ').trim();
    return clean.length > 160 ? clean.slice(0, 160).trim() + '…' : clean;
  };
  if (!payload || typeof payload !== 'object') return ser(payload);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}（${v.length} 项）：`);
      for (const it of v.slice(0, 20)) {
        const s = ser(it);
        if (s) lines.push(`- ${s}`);
      }
      if (v.length > 20) lines.push(`- …另有 ${v.length - 20} 项`);
    } else if (typeof v === 'object') {
      const inner = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x != null)
        .slice(0, 8)
        .map(([ik, iv]) => `${ik}: ${ser(iv)}`)
        .join('，');
      if (inner) lines.push(`${k}：${inner}`);
    } else {
      lines.push(`${k}：${ser(v)}`);
    }
  }
  return lines.join('\n');
}

// v0.13.4：widget 模板 _meta 的统一工厂。多个工具共用同一个 v2.html 模板
// （官方 kitchen_sink 示例即如此），差别只在 invoking/invoked 的状态文案。
function widgetMeta(invoking: string, invoked: string) {
  if (HIDE_WIDGET) return {};
  return {
    _meta: {
      // 标准键（MCP Apps）：_meta.ui.resourceUri
      ui: { resourceUri: RESOURCE_URI },
      // ChatGPT 兼容别名。官方 chatgpt-ui 的字段对照表给出的是「标准键 + 别名」
      // 两列，v0.21.1 删掉了此前多写的平铺 'ui/resourceUri' —— 官方文档里没有
      // 这个键，留着只会让审核看不出我们到底声明了几种绑定方式。
      'openai/outputTemplate': RESOURCE_URI,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': invoking,
      'openai/toolInvocation/invoked': invoked,
    },
  };
}

// ---- MCP 服务装配（官方 SDK：每请求全新实例，适配无状态 Edge 运行时）----
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

// v0.16.0：只读但会触达「开放世界」的工具。
// 依据 docs/openai-apps-docs/plugin-guidelines.md：openWorldHint 表达「是否会与
// 外部实体交互 / 结果是否非有界目录」。find_nearby 返回任意位置的任意公开内容，
// geocode_place 直接打高德外部接口，两者都不是有界目录，必须为 true。
const OPEN_WORLD_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

// v0.18.0（Phase 3）：写工具的两种标注。
// 口径按 plugin-guidelines.md「Use false only for additive writes」：
//   - 加一行关系（关注、收藏）→ destructiveHint=false
//   - 删一行关系 / 覆盖用户自己写的内容 → destructiveHint=true。
//     「能撤销」本身不足以设 false——取关、删收藏都是 deletion。
// openWorldHint 一律 false：动的是 PowPow 账号内部的既有对象，不是开放世界。
const WRITE_ADD_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

const WRITE_DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

// v0.19.0（Phase 4）：发帖是「对外发布」，按官方口径 openWorldHint 必须为 true
// ——内容是发给站外可见的信息流，不是账号内部对象。同时 destructiveHint 也是
// true：发出去不可撤回（24h 内能删，但「能撤销不足以设 false」）。
const WRITE_PUBLIC_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

// v0.20.0（Phase 5）：建数字人与发帖同理是「对外发布」——它出现在公共地图上，
// 任何人都可以找到它并和它对话，openWorldHint 必须 true。但 destructiveHint
// 保持 false：不删除也不覆盖任何既有内容（扣 2 徽章是站内强制的资源消耗，
// 用户已在产品层确认「徽章即配额」，不是 deletion）。
const WRITE_PUBLISH_DH_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

// v0.17.0：OpenAI 的 profile 工具契约（build-auth.md「Support multiple accounts」）。
// 只能有 id / name / nickname 三字段，required 仅 id，且必须 additionalProperties:false
// （zod .strict() 才能生成该约束）。超出这个形状宿主就不认，多账号识别会退化成
// 「一个 PowPow 账号」。
// 刻意不含 email：绝大多数账号是影子邮箱 shadow-<uuid>@powpow.internal，
// 当显示值会让人以为串号了。
const PROFILE_OUTPUT_SCHEMA = z.strictObject({
  id: z.string().min(1),
  name: z.string().optional(),
  nickname: z.string().optional(),
});

// v0.13.10 注：v0.13.6 曾在此定义 NOAUTH_SECURITY_SCHEMES 并写入全部工具 _meta
// （依据 build-auth.md:567 per-tool securitySchemes 建议）。10-14 隔离实验证实：
// HIDE_WIDGET 形态（无任何 securitySchemes）可过 ChatGPT 创建校验 → 该字段是
// widget 特性外的并列嫌疑，本次一并回退。若后续需显式 noauth 声明再加回逐项验证。

// v0.14.2：handler 由模块级单例改为 per-request 构建（官方 byo-mcp 同款形态——
//「A fresh server per request: Edge Functions are stateless」）。原因：OAuth
// 门禁通过后，工具处理器需要知道「这次请求是哪个 PowPow 用户」（token sub 经
// auth_users_link 桥接解析），per-request 闭包捕获是最直接且并发安全的传递方式
// （模块级共享会被并发请求踩；AsyncLocalStorage 在 Edge Runtime 的支持未验证，
//  不引入不必要的运行时依赖）。
// 用户态工具（P4 起）在 handler 内读 authUser；匿名工具不读，行为零变化。
/**
 * MCP 网关（v0.15.0）
 *
 * Edge 侧只持 Supabase access token，拿不到 PowPow 的 JWT（JWT_SECRET 在 Vercel），
 * 所以「以自己的身份读/写自己的数据」这一类动作统一转发给 Vercel 的
 * `/api/mcp/act`：那边验 Supabase token → 桥接 powpowUserId → 铸 JWT → 调站内
 * 既有 API（审核 / 徽章 / 限流 / 设备指纹全部原样生效）。
 *
 * 灰度开关：secret MCP_GATEWAY_URL 可覆盖地址（默认线上主域），便于先指向预览环境。
 */
const GATEWAY_BASE = (Deno.env.get('MCP_GATEWAY_URL') ?? 'https://global.powpow.online').replace(
  /\/+$/,
  '',
);

interface GatewayResponse {
  ok: boolean;
  data?: any;
  error?: string;
  code?: string;
}

async function callGateway(
  accessToken: string | null,
  action: string,
  args: Record<string, unknown> = {},
): Promise<GatewayResponse> {
  if (!accessToken) {
    return { ok: false, code: 'unauthorized', error: '未连接 PowPow 账号' };
  }
  try {
    const res = await fetchWithTimeout(
      `${GATEWAY_BASE}/api/mcp/act`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ action, args }),
      },
      GATEWAY_TIMEOUT_MS,
    );
    const text = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {
      // 非 JSON（网关 502 / 预览保护页）→ 统一按失败处理
    }
    if (!res.ok || !j?.ok) {
      return {
        ok: false,
        code: j?.code ?? `http_${res.status}`,
        error: j?.error ?? '网关请求失败，请稍后重试',
      };
    }
    return { ok: true, data: j.data };
  } catch (err) {
    return {
      ok: false,
      code: 'network',
      error: err instanceof Error ? err.message : '网关不可达',
    };
  }
}

/** 网关失败时的统一话术（区分「没连账号」和「服务异常」，避免把 5xx 说成未登录）。 */
function gatewayFailureText(g: GatewayResponse): string {
  if (g.code === 'unauthorized') {
    return '需要先连接 PowPow 账号：请在 ChatGPT 设置 → 连接器中找到 PowPow 并完成授权。';
  }
  // v0.15.1：会员过期与网络故障区分开，避免让用户徒劳重试
  if (g.code === 'subscription_required') {
    return `你的 PowPow 会员已过期，因此暂时读不到账号数据。请在 ${SITE}/subscription 续费后再试。`;
  }
  return `暂时读不到账号数据（${g.error ?? '未知原因'}），请稍后再试。`;
}

/**
 * 写操作的失败文案（v0.18.0）。
 *
 * 与只读的差别：写失败大多是「用户能改的动作」，比如没传 user_id、目标不存在、
 * 自己把写权限关了。这些必须把网关原文（本来就是中文且可操作）透给模型，
 * 而不是套一句「请稍后再试」——那样模型只会原话重复、用户永远不知道错在哪。
 */
function gatewayWriteFailureText(g: GatewayResponse): string {
  if (g.code === 'unauthorized') {
    return '需要先连接 PowPow 账号：请在 ChatGPT 设置 → 连接器中找到 PowPow 并完成授权。';
  }
  if (g.code === 'subscription_required') {
    return `你的 PowPow 会员已过期，暂时无法执行写操作。请在 ${SITE}/subscription 续费后再试。`;
  }
  const actionable = [
    'write_disabled',
    'rate_limited',
    'missing_user_id',
    'missing_id',
    'missing_item_id',
    'missing_item_name',
    'invalid_target',
    'invalid_item_type',
    'nothing_to_update',
    'not_found',
    // v0.19.0（Phase 4）发帖链路
    'missing_content',
    'content_too_long',
    'missing_draft_id',
    'draft_expired',
    'draft_deleted',
    'publishing',
    'content_blocked',
    'post_failed',
    'missing_post_id',
    'not_mcp_post',
    'too_old',
    // v0.20.0（Phase 5）资料与数字人
    'invalid_input',
    'update_failed',
    'missing_name',
    'missing_description',
    'name_too_long',
    'missing_location',
    'badge_insufficient',
    'create_failed',
    'not_mcp_dh',
    'has_conversations',
    'has_messages',
  ];
  if (g.code && actionable.includes(g.code) && g.error) return g.error;
  return `操作没有完成（${g.error ?? '未知原因'}），请稍后再试。`;
}

function summaryFollow(d: any): string {
  const who = d?.user?.nickname || d?.user?.username || d?.user?.id || '对方';
  const lines = [`已关注 ${who}。`];
  if (d?.already_following) lines.push('（之前就已经关注了，这次没有重复添加。）');
  if (d?.is_friend) lines.push('对方也关注你，所以在 PowPow 里你们算好友。');
  else lines.push('对方还没有关注你，所以目前还不算好友——PowPow 没有好友申请，好友就是互相关注。');
  if (d?.user?.profile_url) lines.push(`主页：${d.user.profile_url}`);
  return lines.join('\n');
}

function summaryUnfollow(d: any): string {
  return d?.removed
    ? '已取消关注。'
    : '你本来就没有关注这个人，关系没有变化。';
}

function summaryFavoriteAdd(d: any): string {
  if (d?.already) return '这条内容本来就在你的收藏里，没有重复添加。';
  return '已加入收藏。';
}

function summaryFavorite(d: any, verb: string): string {
  const bits: string[] = [`已${verb}收藏：${d?.item_name ?? d?.id ?? ''}`];
  if (d?.category) bits.push(`分类：${d.category}`);
  if (Array.isArray(d?.tags) && d.tags.length) bits.push(`标签：${d.tags.join('、')}`);
  if (d?.note) bits.push(`备注：${d.note}`);
  return bits.join('\n');
}

// ---- v0.19.0（Phase 4）内容写：草稿 / 发布 / 撤回 / 点赞 ----

/**
 * ChatGPT 文件参数（`_meta["openai/fileParams"]`）要求的固定结构。
 *
 * 四个 properties 必须全部声明；required 只能含 download_url 与 file_id，
 * 多声明一个 required 或少声明一个 property 都会被 Scan Tools 打回。
 * 运行时 ChatGPT 一定给 download_url + file_id，mime_type / file_name 可能缺省。
 */
const OpenAIFileSchema = z.object({
  download_url: z.string().describe('ChatGPT 提供的临时下载地址（会过期，服务端会立刻转存）'),
  file_id: z.string().describe('文件 id，用于去重与跨轮次引用'),
  mime_type: z.string().optional().describe('MIME 类型，如 image/jpeg'),
  file_name: z.string().optional().describe('原始文件名'),
});

function summaryPreparePost(d: any): string {
  const p = d?.preview ?? {};
  const bits: string[] = [];
  bits.push(d?.reused ? '这条内容刚才已经草拟过，沿用同一份草稿。' : '草稿已备好（还没有发布）。');
  bits.push(`draft_id：${d?.draft_id ?? ''}`);
  bits.push(`正文（${p.content_length ?? 0} 字）：${p.content ?? ''}`);
  if (Number(p.image_count ?? 0) > 0) {
    bits.push(`图片：${p.image_count} 张（已转存到 PowPow，发布后长期有效）`);
  } else {
    bits.push('图片：无（纯文字）');
  }
  bits.push(
    p.place
      ? `地点：${p.place}——发布后会出现在这个地点的地图上`
      : '不带位置：只进信息流，不进地图',
  );
  bits.push(
    `有效期到 ${String(d?.expires_at ?? '').slice(0, 16).replace('T', ' ')}（UTC）。确认无误后调用 publish_post，draft_id 传上面这个值；要改就直接重新 prepare_post。`,
  );
  return bits.join('\n');
}

function summaryPublishPost(d: any): string {
  if (d?.already_published) {
    return `这条草稿已经发布过了，没有重复发帖。帖子：${d?.post_url ?? ''}`;
  }
  const bits = [`已发布：${d?.post_url ?? ''}`];
  if (d?.on_map && d?.place) bits.push(`同时在「${d.place}」的地图上可见。`);
  else bits.push('这条帖子在信息流里可见（未带位置，不在地图上）。');
  bits.push('24 小时内可以让我撤回，超过就只能到站内删。');
  return bits.join('\n');
}

function summaryDeletePost(d: any): string {
  return d?.deleted ? '已撤回，这条帖子在信息流和地图上都不再显示。' : '没有删掉任何东西。';
}

function summaryLikePost(d: any): string {
  if (d?.already) return `你本来就点过这条的赞，现在 ${d?.likes_count ?? 0} 个赞，没有重复。`;
  const bits = [`已点赞，现在 ${d?.likes_count ?? 0} 个赞。`];
  if (d?.resurrected) bits.push('这条泡泡之前已经过期，因为你的点赞被延长了 24 小时。');
  return bits.join('\n');
}

function summaryUnlikePost(d: any): string {
  return d?.removed
    ? `已取消点赞，现在 ${d?.likes_count ?? 0} 个赞。`
    : `你本来就没有给这条点赞，现在 ${d?.likes_count ?? 0} 个赞。`;
}

// ---- v0.20.0（Phase 5）资料与数字人 ----

function summaryProfileUpdate(d: any): string {
  const bits: string[] = ['资料已更新，立即在全站生效（信息流、地图、对话里显示的名字都会变）。'];
  if (d?.nickname) bits.push(`昵称：${d.nickname}`);
  bits.push(d?.bio ? `简介：${d.bio}` : '简介：已清空');
  return bits.join('\n');
}

function summaryDhCreate(d: any): string {
  const bits = [`数字人「${d?.name ?? ''}」已创建。`];
  if (d?.location) {
    bits.push(`位置：${d.location}——现在其他人可以在地图上找到它并和它对话。`);
  }
  bits.push(`扣了 ${d?.badges_spent ?? 2} 个徽章，剩余 ${d?.badges_remaining ?? 0} 个。`);
  bits.push(
    `30 天后过期（${String(d?.expires_at ?? '').slice(0, 10)}），到期之后要再建得重新扣徽章。`,
  );
  bits.push(`id：${d?.id ?? ''}`);
  if (d?.note) bits.push(d.note);
  return bits.join('\n');
}

function summaryDhDelete(d: any): string {
  if (!d?.deleted) return '没有删除任何数字人。';
  const bits = [`已撤销「${d?.name ?? ''}」，它已从地图上消失。`];
  if (d?.badges_refunded) {
    bits.push(`退还 ${d.badges_refunded} 个徽章，现在有 ${d?.badges_remaining ?? 0} 个。`);
  }
  return bits.join('\n');
}

function summaryWhoami(d: any): string {
  const sub = d?.subscription ?? {};
  const member = sub.active
    ? `${sub.tier || 'FREE'}${sub.expires_at ? `，到期 ${String(sub.expires_at).slice(0, 10)}` : '（长期有效）'}`
    : '未开通';
  return [
    `已连接 PowPow 账号：${d?.nickname || d?.username}（@${d?.username}）`,
    `徽章：${d?.badges ?? 0}　会员：${member}`,
    `已发布 ${d?.counts?.posts ?? 0} 条帖子　${d?.counts?.digital_humans ?? 0} 个数字人`,
    `主页：${d?.profile_url ?? ''}`,
  ].join('\n');
}

function summaryMyPosts(d: any): string {
  const items: any[] = Array.isArray(d?.items) ? d.items : [];
  if (!items.length) {
    return '你还没有在 PowPow 发布过帖子。';
  }
  const lines = items.map((p, i) => {
    const when = String(p?.created_at ?? '').slice(0, 16).replace('T', ' ');
    const place = p?.location_name ? ` · ${p.location_name}` : '';
    return `${i + 1}. ${p?.excerpt || '（无正文）'}\n   ${when}${place} · 赞 ${p?.likes ?? 0} 评 ${p?.comments ?? 0}\n   ${p?.url ?? ''}`;
  });
  const head = `你共发布过 ${d?.total ?? items.length} 条帖子，这里是最近 ${items.length} 条：`;
  const more =
    (d?.total ?? items.length) > items.length ? '\n\n还有更多，可以说「继续看」翻下一页。' : '';
  return `${head}\n\n${lines.join('\n')}${more}`;
}

function summaryMyDigitalHumans(d: any): string {
  const items: any[] = Array.isArray(d?.items) ? d.items : [];
  if (!items.length) {
    return '你还没有创建过数字人。创建后它会出现在 PowPow 地图上，其他用户可以点开聊天。';
  }
  const lines = items.map((dh, i) => {
    const state = dh?.expired
      ? '已过期'
      : `还剩 ${dh?.days_left ?? '?'} 天`;
    const place = dh?.location_name ? `　位置：${dh.location_name}` : '';
    return `${i + 1}. ${dh?.name}（${state}）${place}\n   对话：${dh?.chat_url ?? ''}`;
  });
  return `你有 ${d?.total ?? items.length} 个数字人：\n\n${lines.join('\n')}`;
}

// ---- v0.17.0（Phase 2）：只读工具的文本摘要 ----

/** 账号概览：承接 whoami 收窄后让出的统计信息。 */
function summaryMyAccount(d: any): string {
  return [
    summaryWhoami(d),
    '',
    '需要更细的可以问：我的关注 / 谁关注我 / 我的好友 / 我的收藏 / 徽章流水。',
  ].join('\n');
}

/** 关注 / 粉丝 / 好友三种列表共用，label 决定文案与「未回关」提示。 */
function summaryUserList(d: any, label: string): string {
  const items: any[] = Array.isArray(d?.items) ? d.items : [];
  if (!items.length) {
    const empty: Record<string, string> = {
      following: '你还没有关注任何人。在 PowPow 里看到感兴趣的人，可以在主页点关注。',
      followers: '还没有人关注你。',
      friends: '你还没有好友。PowPow 的「好友」= 互相关注：你关注的人回关你之后，就会出现在这里。',
    };
    return empty[label] ?? '列表为空。';
  }
  const lines = items.map((u, i) => {
    const name = u?.nickname || u?.username || '（未命名）';
    const handle = u?.username ? ` (@${u.username})` : '';
    const bio = u?.bio ? `\n   ${u.bio}` : '';
    const mutual = u?.is_mutual ? '　已互关' : '';
    return `${i + 1}. ${name}${handle}${mutual}${bio}`;
  });
  const head: Record<string, string> = {
    following: `你关注了 ${d?.total ?? items.length} 人：`,
    followers: `有 ${d?.total ?? items.length} 人关注你：`,
    friends: `你有 ${d?.total ?? items.length} 位好友（互相关注）：`,
  };
  const more =
    (d?.total ?? items.length) > items.length ? '\n\n还有更多，可以说「继续看」翻下一页。' : '';
  return `${head[label] ?? '列表：'}\n\n${lines.join('\n')}${more}`;
}

function summaryFavorites(d: any): string {
  const items: any[] = Array.isArray(d?.items) ? d.items : [];
  if (!items.length) {
    return '你的收藏夹是空的。在 PowPow 里收藏的地点、帖子、数字人会出现在这里。';
  }
  const kind: Record<string, string> = {
    location: '地点',
    post: '帖子',
    digital_human: '数字人',
  };
  const lines = items.map((f, i) => {
    const t = kind[f?.item_type] ?? f?.item_type ?? '收藏';
    const cat = f?.category ? ` · ${f.category}` : '';
    const note = f?.note ? `\n   备注：${f.note}` : '';
    const url = f?.url ? `\n   ${f.url}` : '';
    return `${i + 1}. [${t}] ${f?.item_name ?? '（未命名）'}${cat}${note}${url}`;
  });
  return `你收藏了 ${d?.total ?? items.length} 项：\n\n${lines.join('\n')}`;
}

function summaryBadgeHistory(d: any): string {
  const items: any[] = Array.isArray(d?.items) ? d.items : [];
  const head = `当前徽章余额：${d?.balance ?? 0} 枚`;
  if (!items.length) return `${head}\n\n还没有徽章流水记录。`;
  const lines = items.map((t, i) => {
    const when = String(t?.created_at ?? '').slice(0, 16).replace('T', ' ');
    const delta = typeof t?.amount === 'number' ? (t.amount > 0 ? `+${t.amount}` : `${t.amount}`) : '?';
    const desc = t?.description ? `　${t.description}` : '';
    return `${i + 1}. ${when}　${delta}（余 ${t?.balance_after ?? '?'}）　${t?.source ?? ''}/${t?.operation ?? ''}${desc}`;
  });
  return `${head}\n\n最近 ${items.length} 条流水：\n\n${lines.join('\n')}`;
}

function summaryUserProfile(d: any): string {
  if (!d) return '没有找到这个用户。';
  const name = d?.nickname || d?.username || '（未命名）';
  const handle = d?.username ? `（@${d.username}）` : '';
  const parts = [`${name}${handle}`];
  if (d?.bio) parts.push(`简介：${d.bio}`);
  parts.push(
    `帖子 ${d?.counts?.posts ?? 0}　关注 ${d?.counts?.following ?? 0}　粉丝 ${d?.counts?.followers ?? 0}　徽章 ${d?.badges ?? 0}`,
  );
  if (typeof d?.is_following === 'boolean') {
    parts.push(d.is_following ? '你已关注 TA。' : '你还没有关注 TA。');
  }
  const recent: any[] = Array.isArray(d?.recent_posts) ? d.recent_posts : [];
  if (recent.length) {
    parts.push('', '最近发布：');
    recent.forEach((p, i) => {
      const when = String(p?.created_at ?? '').slice(0, 10);
      const place = p?.location_name ? ` · ${p.location_name}` : '';
      parts.push(`${i + 1}. ${p?.excerpt || '（无正文）'}　${when}${place}`);
    });
  }
  if (d?.profile_url) parts.push('', `主页：${d.profile_url}`);
  return parts.join('\n');
}

function summarySearchUsers(d: any): string {
  const items: any[] = Array.isArray(d?.items) ? d.items : [];
  const q = d?.query ? `「${d.query}」` : '';
  if (!items.length) return `没有找到匹配 ${q} 的用户。`;
  const lines = items.map((u, i) => {
    const name = u?.nickname || u?.username || '（未命名）';
    const handle = u?.username ? ` (@${u.username})` : '';
    const flags = [u?.is_self ? '这是你自己' : '', u?.is_following ? '已关注' : '']
      .filter(Boolean)
      .join('　');
    const tail = flags ? `　${flags}` : '';
    const bio = u?.bio ? `\n   ${u.bio}` : '';
    return `${i + 1}. ${name}${handle}${tail}${bio}`;
  });
  return `匹配 ${q} 的用户 ${items.length} 个：\n\n${lines.join('\n')}`;
}

// ---- v0.17.0：公开只读（不要求登录；public.users 是 RLS forced 表，须 service-role）----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 入参可能是 UUID、@username 或 username。 */
function userRefOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/^@+/, '') : '';
}

/** 他人主页：资料 + 三项计数 + 最近 3 条帖子；已登录时附 is_following。 */
async function fetchPublicUserProfile(raw: unknown, viewerId: string | null) {
  const ref = userRefOf(raw);
  if (!ref) return { error: '缺少参数 user（用户 ID 或用户名）' };
  const sb = adminClient();

  const base = sb
    .from('users')
    .select('id, username, nickname, avatar_url, bio, badges, first_visit');
  const { data, error } = await (UUID_RE.test(ref) ? base.eq('id', ref) : base.eq('username', ref))
    .limit(1);
  if (error) return { error: '查询用户失败，请稍后重试' };
  const u: any = data?.[0];
  if (!u) return { error: `没有找到用户 ${ref}` };

  // 徽章真值在 badge_balance 表；users.badges 是历史遗留字段（多数用户停在 1/3）。
  // 口径与 src/storage/database/unifiedBadgeManager 一致：有 balance 记录读 balance，无记录才回退 users.badges。
  const [postsRes, followingRes, followersRes, recentRes, badgeRes] = await Promise.all([
    sb.from('posts').select('id', { count: 'exact', head: true }).eq('user_id', u.id),
    sb.from('follows').select('id', { count: 'exact', head: true }).eq('follower_id', u.id),
    sb.from('follows').select('id', { count: 'exact', head: true }).eq('following_id', u.id),
    sb
      .from('posts')
      .select('id, content, image_url, location_name, likes_count, comments_count, created_at')
      .eq('user_id', u.id)
      .order('created_at', { ascending: false })
      .limit(3),
    sb.from('badge_balance').select('balance').eq('user_id', u.id).limit(1),
  ]);
  const balanceRow: any = badgeRes.data?.[0];
  const badges = balanceRow ? Number(balanceRow.balance) : (u.badges ?? null);

  let isFollowing: boolean | null = null;
  if (viewerId) {
    const r = await sb
      .from('follows')
      .select('id')
      .eq('follower_id', viewerId)
      .eq('following_id', u.id)
      .limit(1);
    isFollowing = !!r.data?.length;
  }

  const recent = Array.isArray(recentRes.data) ? recentRes.data : [];
  return {
    ok: true,
    data: {
      id: u.id,
      username: u.username,
      nickname: u.nickname,
      avatar_url: u.avatar_url,
      bio: u.bio ? String(u.bio).slice(0, 200) : null,
      badges,
      joined_at: u.first_visit,
      is_following: isFollowing,
      counts: {
        posts: postsRes.count ?? 0,
        following: followingRes.count ?? 0,
        followers: followersRes.count ?? 0,
      },
      recent_posts: recent.map((p: any) => ({
        id: p.id,
        excerpt: stripRichText(p.content).slice(0, 120),
        image_url: p.image_url,
        location_name: p.location_name,
        likes: p.likes_count,
        comments: p.comments_count,
        created_at: p.created_at,
        url: `${SITE_URL}/posts/${p.id}`,
      })),
      profile_url: `${SITE_URL}/users/${u.id}`,
    },
  };
}

/** 用户搜索：用户名 / 昵称模糊匹配；已登录时附 is_following。 */
async function searchPublicUsers(raw: unknown, limit: number, viewerId: string | null) {
  // PostgREST 的 or() 用逗号和括号分隔条件，关键词里出现就会被解析成额外条件
  const q = userRefOf(raw)
    .replace(/[,%()]/g, '')
    .slice(0, 40);
  if (!q) return { error: '缺少有效的搜索关键词' };

  const sb = adminClient();
  const { data, error } = await sb
    .from('users')
    .select('id, username, nickname, avatar_url, bio')
    .or(`username.ilike.%${q}%,nickname.ilike.%${q}%`)
    .limit(limit);
  if (error) return { error: '搜索失败，请稍后重试' };
  const rows: any[] = Array.isArray(data) ? data : [];

  let followingSet = new Set<string>();
  if (viewerId && rows.length) {
    const ids = rows.map((r) => r.id);
    const { data: rel } = await sb
      .from('follows')
      .select('following_id')
      .eq('follower_id', viewerId)
      .in('following_id', ids);
    followingSet = new Set((rel ?? []).map((r: any) => r.following_id));
  }

  return {
    ok: true,
    data: {
      query: q,
      count: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        nickname: r.nickname,
        avatar_url: r.avatar_url,
        bio: r.bio ? String(r.bio).slice(0, 80) : null,
        is_self: viewerId ? r.id === viewerId : false,
        is_following: followingSet.has(r.id),
        profile_url: `${SITE_URL}/users/${r.id}`,
      })),
    },
  };
}

// v0.15.0：新增 accessToken 参数——MCP 网关（Vercel /api/mcp/act）要的是
// 「Supabase access token 原文」，而不是解析后的 claims（它自己去 /auth/v1/user
// 验签，拿到同一份身份后再铸 powpop JWT）。token 只在本请求闭包里存活，不落库、
// 不进日志（审计只记 powpowUserId）。
function buildMcpHandler(authUser: AuthenticatedUser | null, accessToken: string | null) {
  return createMcpHandler(() => {
    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      // v0.16.0：声明 serverInfo.icons（MCP 2025-11-25 起协议支持）。
      // 诚实说明：OpenAI 的文档里查不到这个字段的消费方式（7 处 icons 全是视觉
      // 规范），ChatGPT 是否拿它当连接器图标尚未证实，所以不列入验收项。
      // 真正保证「创建插件时自带 logo」的是 plugin.json 的 assets。
      // 这里必须用 https 绝对地址（协议要求），且该路径在 proxy.ts 的
      // STATIC_PREFIXES 白名单内——否则付费墙恢复后会被 307 到 /register，
      // 图标永远加载不出来。
      //
      // v0.21.0：按 Icon.theme 同时给亮/暗两张。原版 logo 是深红环（#B22222），
      // 在深色界面上几乎糊成一块；暗色版把环提亮到 #DE5454（对比度 2.36→4.36），
      // 色相不变。支持 theme 的客户端会自己按当前主题挑一张，不支持的会退回
      // 数组第一项也就是亮色版，行为不比之前差。
      icons: [
        {
          src: 'https://global.powpow.online/logo.png',
          mimeType: 'image/png',
          sizes: ['192x192'],
          theme: 'light',
        },
        {
          src: 'https://global.powpow.online/logo-dark.png',
          mimeType: 'image/png',
          sizes: ['256x256'],
          theme: 'dark',
        },
      ],
    }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    'find_nearby',
    {
      title: 'Find Nearby',
      description:
        '查找某个地点附近可公开发现的数字人、真实用户与帖子。返回对象含大致/精确位置（取决于对方是否开启精确发现）、类型与摘要。这是「XX 附近有什么人」「XX 周围有什么」场景的核心工具；调用后会以「PowPow 附近发现」卡片组件展示附近的公开数字人。**必须先向用户确认要看哪个地点**（用户说「我附近」时，问他在哪个城市/商圈/地标），不要猜坐标。',
      inputSchema: z.object({
        // v0.21.0（R8）：删掉 lat/lng。插件规范明确「不得索取用户精确位置」，
        // 而我们此前的 schema 直接邀请模型传 GPS 坐标——目录审核会判违规。
        // 位置一律由用户口述地名、再由 Edge 侧 geocode：既合规，也避免模型
        // 拿着 WGS-84 坐标撞 GCJ-02 偏移（此前描述里还得教它坐标系，本身就是
        // 设计跑偏的信号）。
        place: z
          .string()
          .describe('要查找的地点名（如『国贸』『中关村』『北京故宫』）。用户说「我附近」时要先问清是哪里'),
        radius_meters: z.number().int().default(1000).describe('搜索半径（米），默认 1000'),
        types: z
          .array(z.enum(['digital_humans', 'users', 'posts']))
          .optional()
          .describe(
            '要返回的对象类型：digital_humans(数字人) / users(真实用户) / posts(帖子)。默认全部',
          ),
      }),
      annotations: OPEN_WORLD_READ_ANNOTATIONS,
      // v0.13.1：官方明文「Declare `outputSchema` for any tool that returns
      // `structuredContent`」，且 structuredContent 必须匹配它。
      outputSchema: FIND_NEARBY_OUTPUT_SCHEMA,
      // widget 模板绑定在本工具（OpenAI Apps 模式：数据工具即渲染工具）。
      // v0.13.4 起改用共用的 widgetMeta() 工厂，与 search_posts /
      // nearby_attractions / list_campaigns 指向同一个模板，靠 structuredContent.view
      // 区分渲染形态（原先这段是逐字展开的，现统一到工厂避免四处漂移）。
      ...widgetMeta('正在查找附近的数字人…', '附近发现已就绪'),
    },
    async (args: any) => {
      const waitSec = await takeOpenWorldSlot(accessToken, 'find_nearby');
      if (waitSec > 0) return rateLimitedResult(waitSec);
      const out = await findNearby(args, anonClient());
      if ((out as any)?.error) return jsonResult(out);
      const sc = nearbyStructuredContent(out, args?.place ?? null);
      return {
        // content 给模型与无 widget 能力的 agent —— 人话摘要（v0.13.5 前是原始
        // JSON 转储，实测 45 万字符 ≈ 28万 token，一次调用即爆上下文）。
        content: [{ type: 'text' as const, text: summaryFindNearby(sc, args?.place ?? null) }],
        // structuredContent 同时给模型与 widget（宿主经 ui/notifications/tool-result
        // 推送 params.structuredContent）；形状已按 outputSchema 清洗
        structuredContent: sc,
        isError: false,
      };
    },
  );

  server.registerTool(
    'geocode_place',
    {
      title: 'Geocode Place',
      description:
        '把地名/地标转成经纬度坐标，便于在 find_nearby 中使用。返回含 matched_name（高德实际匹配到的 POI 名）与 confidence（0~1 匹配度）：地名模糊时务必核对 matched_name 是否真的是用户要找的地方，不确定就把两者转告用户确认。',
      inputSchema: z.object({
        place: z.string().describe('地名/地标'),
      }),
      annotations: OPEN_WORLD_READ_ANNOTATIONS,
    },
    async (args: any) => {
      if (!args?.place) return jsonResult({ error: '缺少参数 place' });
      const waitSec = await takeOpenWorldSlot(accessToken, 'geocode_place');
      if (waitSec > 0) return rateLimitedResult(waitSec);
      const g = await geocodePlace(String(args.place));
      if (!g) return jsonResult({ error: `地名「${args.place}」无法解析` });
      // v0.13.5：透传 matched_name/confidence，让模型能说清「我找到的是什么」。
      // 低置信度时显式提示，避免把模糊匹配当成确定答案。
      const lowConfidence = (g.confidence ?? 1) < 0.8;
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `地名「${args.place}」解析为 ${g.lat}, ${g.lng}` +
              (g.matched_name ? `\n实际匹配的地点名称：${g.matched_name}` : '') +
              `\n匹配度：${(g.confidence ?? 1).toFixed(2)}` +
              (lowConfidence
                ? `\n注意：这是模糊匹配，「${args.place}」可能是错的。若用户要查询地点周边的内容，请先向用户确认这是否是他要的地点。`
                : ''),
          },
        ],
        isError: false,
      };
    },
  );

  server.registerTool(
    'get_digital_human',
    {
      title: 'Get Digital Human',
      description:
        '获取某个公开数字人的完整资料：人设(persona)、简介、头像、所在位置，以及它当前的情绪(mood)。是 find_nearby 找到数字人后的「下一跳」——agent 可先介绍数字人，再引导用户与其对话。',
      inputSchema: z.object({
        id: z.string().describe('数字人 ID（来自 find_nearby / 其它工具返回的 id）'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const out = await getDigitalHuman(args, anonClient());
      // v0.13.5：走专用摘要而非通用兜底——描述承诺「完整资料：人设…」，
      // 而 persona 常排在字段表第 9 位，通用兜底只取前 8 字段会把它整条丢掉。
      return isErrorPayload(out)
        ? jsonResult(out)
        : { content: [{ type: 'text' as const, text: summaryDigitalHuman(out) }], isError: false };
    },
  );

  server.registerTool(
    'get_post_detail',
    {
      title: 'Get Post Detail',
      description:
        '获取某条公开帖子的完整正文、作者、位置与互动数，附带最新 3 条评论作为概览（仅公开帖可查）。想看完整讨论、谁回复了谁、或要回复某个人，用 get_post_replies——那个才是专门的评论区入口。',
      inputSchema: z.object({
        post_id: z
          .string()
          .describe('帖子 id。搜索结果里的 8 位短 id 就够，也接受完整 id 或帖子链接'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const out = await getPostDetail(args, anonClient());
      // v0.13.5：走专用摘要——描述承诺「完整内容」，通用兜底只给 160 字会打脸。
      return isErrorPayload(out)
        ? jsonResult(out)
        : { content: [{ type: 'text' as const, text: summaryPostDetail(out) }], isError: false };
    },
  );

  // v0.23.0（Phase 6）：评论互动三件套之一——读某帖的评论树。
  // 与 get_post_detail 的分工：detail 是「一次看全文 + 顺带几条评论」，
  // 本工具是「专门看讨论」——分页、带作者名、带每条评论的 id（回复时的锚点）。
  server.registerTool(
    'get_post_replies',
    {
      title: 'Get Post Replies',
      description:
        '获取某条公开帖子下的评论：一级评论分页返回（最新在前），每条内嵌其下的回复，带作者昵称、时间和「评论 id」。想看某条帖子具体在聊什么、或者要回复某条评论时用这个（回复需要传 reply_to_comment_id，id 就是这里输出的）。只想看帖子正文用 get_post_detail。',
      inputSchema: z.object({
        post_id: z
          .string()
          .describe('帖子 id。search_posts / my_posts 返回的 8 位短 id 即可，也接受链接'),
        page: z.number().int().min(1).default(1).describe('页码，默认 1'),
        limit: z.number().int().min(1).max(50).default(20).describe('每页一级评论条数，默认 20'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      // 并行：读评论 + 拿自己的 id（用于标「你」）。后者失败不影响前者。
      const [out, selfId] = await Promise.all([
        getPostReplies(args, anonClient()),
        myPowpopUserId(accessToken),
      ]);
      return isErrorPayload(out)
        ? jsonResult(out)
        : {
            content: [{ type: 'text' as const, text: summaryPostReplies(out, selfId) }],
            isError: false,
          };
    },
  );

  server.registerTool(
    'nearby_attractions',
    {
      title: 'Nearby Attractions',
      description:
        '查找某个地点附近的景点与商圈，与「附近的数字人」互补，构成完整的地图发现能力。返回景点(attractions)与商圈(business_districts)两组，各带距离。调用后会以「PowPow 附近发现」卡片组件展示景点与商圈列表。**必须先向用户确认地点**（用户说「我附近」时问他哪个城市/商圈），不要猜坐标。',
      inputSchema: z.object({
        // v0.21.0（R8）：同 find_nearby，删掉 lat/lng，位置只从地名来。
        place: z.string().describe('要查找的地点名，如『国贸』『西湖』；用户说「我附近」时先问清是哪里'),
        radius_meters: z.number().int().default(3000).describe('搜索半径（米），默认 3000'),
      }),
      // v0.21.0：改 openWorldHint=true。它现在必须传地名、内部调高德检索任意
      // 地点，语义与 find_nearby 完全相同；此前写 false 是遗漏（同一个高德
      // 链路，两个工具两个标注）。
      annotations: OPEN_WORLD_READ_ANNOTATIONS,
      outputSchema: NEARBY_ATTRACTIONS_OUTPUT_SCHEMA,
      ...widgetMeta('正在查找附近的景点…', '附近景点已就绪'),
    },
    async (args: any) => {
      const waitSec = await takeOpenWorldSlot(accessToken, 'nearby_attractions');
      if (waitSec > 0) return rateLimitedResult(waitSec);
      const out = await nearbyAttractions(args, anonClient());
      if ((out as any)?.error) return jsonResult(out);
      const sc = nearbyAttractionsStructuredContent(out, args?.place ?? null);
      return {
        content: [{ type: 'text' as const, text: summaryAttractions(sc, args?.place ?? null) }],
        structuredContent: sc,
        isError: false,
      };
    },
  );

  server.registerTool(
    'list_campaigns',
    {
      title: 'List Campaigns',
      description:
        '列出 PowPow 的全部公开活动（如「北京 100 家博物馆」打卡活动），每个活动内嵌其打卡点(acts)列表。用于 agent 介绍当前可参与的活动。调用后会以「PowPow 附近发现」卡片组件展示已发布的活动。',
      inputSchema: z.object({}),
      outputSchema: LIST_CAMPAIGNS_OUTPUT_SCHEMA,
      ...widgetMeta('正在读取活动…', '活动已就绪'),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const out = await listCampaigns(anonClient());
      if ((out as any)?.error) return jsonResult(out);
      const sc = listCampaignsStructuredContent(out);
      return {
        content: [{ type: 'text' as const, text: summaryCampaigns(sc) }],
        structuredContent: sc,
        isError: false,
      };
    },
  );

  // v0.21.0（Phase 6）：原 list_membership_plans 已移除。
  // plugin-guidelines.md:98 明文「Plugins must not display subscription plans,
  // initiate new subscriptions, or promote upgrades」，而这个工具的作用正是
  // 把两个套餐表连价格一起吐给模型——目录审核必判违规。曾有 MCP_HIDE_TOOLS
  // 排除名单做过「注册但不暴露」，但那次重构后名单本身也没了（工具实际是
  // 暴露的）。这次直接删干净：功能上它在 ChatGPT 里永远不许用，留着只是
  // 等着某天被人重新打开。站内会员页不受影响，MCP 也未提供任何购买入口。

  server.registerTool(
    'search_posts',
    {
      title: 'Search Posts',
      // v0.23.2：语义从「关键词检索」扩成「时间流 + 关键词检索」。
      // 背景：agent 想找「过去 24 小时的新帖」时，此前全站没有任何按时间倒序
      // 的工具，它只能拿宽泛关键词去搜，而那个排序是相关度优先——上次它因此
      // 拿到一批 7 月的帖子，并（正确地）拒绝冒充成今天的新内容。
      // description 里刻意强调「返回真实时间、不要假定很新」，空结果时由摘要兜底。
      description:
        '按时间和/或关键词检索公开帖子。' +
        '① 只给时间（since_hours，或 since/until）：返回该时段的帖子流，按发布时间倒序——用户问「最近有什么新帖」「今天社区在聊什么」「10 月 25 日那天发了什么」时用这个。' +
        '② 给了 keyword：在该时段内按关键词命中次数排序，取最相关的帖子。' +
        '③ 时间与关键词都不给：返回全站最新发布的 20 条。' +
        '时间参数：since_hours=24 表示过去 24 小时（相对现在计算）；since/until 用 YYYY-MM-DD 表示北京时间自然日，until 含当天。' +
        '每条结果都带真实发布时间，请据此判断新旧，不要假定拿到的都是新内容；结果为空就如实说该时段无帖。',
      inputSchema: z.object({
        keyword: z
          .string()
          .optional()
          .describe('检索关键词（匹配帖子正文）。省略则只按时间倒序返回帖子流。'),
        since: z
          .string()
          .optional()
          .describe(
            '起始时间（含）。YYYY-MM-DD 按北京时间当天 00:00 解释；也可传带时区的 ISO 时间戳，如 2026-10-25T08:00:00+08:00。',
          ),
        until: z
          .string()
          .optional()
          .describe('结束时间。传纯日期时含当天整天，如 until=2026-10-25 表示到 25 日 24:00 为止。'),
        since_hours: z
          .number()
          .optional()
          .describe(
            '相对当前时间往前推的小时数，如 24 表示过去 24 小时。与 since 二选一；同时给时以本参数为准。',
          ),
        limit: z.number().optional().describe('返回条数，1-50，默认 20。'),
      }),
      outputSchema: SEARCH_POSTS_OUTPUT_SCHEMA,
      ...widgetMeta('正在检索帖子…', '帖子已就绪'),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const out = await searchPosts(args, anonClient());
      if ((out as any)?.error) return jsonResult(out);
      // 摘要走原始 out（全量 limit 条、正文已剥标签），而非 structuredContent——
      // 后者按组件上限截到 20 条，agent 传 limit=50 时会静默少看 30 条。
      const sc = searchPostsStructuredContent(out, out?.keyword ?? null);
      return {
        content: [{ type: 'text' as const, text: summaryPosts(out, out?.keyword ?? null) }],
        structuredContent: sc,
        isError: false,
      };
    },
  );

  // v0.14.2 起 whoami 是「应用内登录」的验收工具。
  // v0.17.0（Phase 2）按 OpenAI profile 契约收窄：只返回身份三字段 +
  // _meta["openai/profile"]，并给出结构化输出。收益是 ChatGPT 设置页能显示
  // 「已连接：董焘」，而不是 Cold Start 里的域名。统计信息（会员/徽章/帖数/
  // 数字人数）搬到 get_my_account——身份与统计是两个用途，混在一起会让宿主
  // 解析不出「这是谁」。
  //
  // 未连接时必须返回 auth error（官方原文：return the appropriate auth error
  // instead of a placeholder ID），所以这里 isError 由 false 变 true。
  server.registerTool(
    'whoami',
    {
      title: 'Who Am I',
      description:
        '确认当前连接的是哪个 PowPow 账号，只返回身份标识（用户 ID、用户名、昵称）。当用户问「我是谁」「登录了吗」「我连的是哪个号」，或在执行任何需要身份的操作前，先调用本工具。账号统计（会员、徽章余额、帖子数、数字人数）请改用 get_my_account。',
      inputSchema: z.object({}),
      outputSchema: PROFILE_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'openai/profile': true },
    },
    async () => {
      if (!authUser) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                '未连接 PowPow 账号。公开内容（附近的数字人、帖子、活动）无需登录即可浏览；' +
                '账号相关能力需要先授权：在 ChatGPT 设置 → 连接器中找到 PowPow，点击连接并完成授权。',
            },
          ],
        };
      }
      const profile = await fetchPowpowProfile(authUser.powpowUserId);
      const structuredContent: { id: string; name?: string; nickname?: string } = {
        id: authUser.powpowUserId,
      };
      if (profile?.username) structuredContent.name = profile.username;
      if (profile?.nickname) structuredContent.nickname = profile.nickname;

      const label = structuredContent.nickname || structuredContent.name || 'PowPow 用户';
      const handle = structuredContent.name ? `（@${structuredContent.name}）` : '';
      return {
        isError: false,
        content: [{ type: 'text' as const, text: `已连接 PowPow 账号：${label}${handle}` }],
        structuredContent,
      };
    },
  );

  // v0.17.0：账号概览。whoami 让出的统计信息全部由这里承接，数据仍从网关取，
  // 与站内「我的」页面同源。
  server.registerTool(
    'get_my_account',
    {
      title: 'My Account Overview',
      description:
        '查看当前账号的概览：昵称、徽章余额、会员等级与到期时间、已发布帖子数、数字人数量、加入时间、主页链接。当用户问「我还有多少徽章」「我的会员什么时候到期」「我发了多少帖」时使用。与 whoami 的区别：whoami 只回答「我是谁」，本工具回答「我的账号现在什么状态」。',
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const g = await callGateway(accessToken, 'get_my_account');
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryMyAccount(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  // v0.15.0：用户态只读工具（P0）。数据经 Vercel 网关以「你自己的身份」读取，
  // 与站内「我的」页面同源；不返回 structuredContent（未声明 outputSchema）。
  server.registerTool(
    'my_posts',
    {
      title: 'My Posts',
      description:
        '列出当前已连接账号在 PowPow 发布过的帖子（按时间倒序，含位置、点赞/评论数、原帖链接）。用于「我发过什么」「帮我看看我上一条游记」这类回顾场景；也可在发布后确认是否真的上线。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('返回条数，默认 20'),
        offset: z.number().int().min(0).default(0).describe('翻页偏移，默认 0'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'my_posts', {
        limit: args?.limit,
        offset: args?.offset,
      });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryMyPosts(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  // v0.23.0（Phase 6）：评论互动三件套之二——我帖子收到的新回复。
  // 站内没有这个页面（notifications 只聚合关注），这是 MCP 独有的「回来看看」入口。
  server.registerTool(
    'get_my_post_replies',
    {
      title: 'Get Replies to My Posts',
      description:
        '查看别人给我的回音，两类都算：① 我发的帖子下的评论与回复；② 别人在**别人的帖子里**回复我的话（我评论过、对方回我）。自己回自己不算。默认只返回「上次读过之后」的新内容；想回溯历史就传 since_hours。mark_read=true 会把这次返回的标为已读——只有用户明确表示看过、或你已经把内容转述给他时才传，否则用户下次再问就查不到这批了。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('返回条数，默认 20'),
        since_hours: z
          .number()
          .int()
          .min(1)
          .max(720)
          .optional()
          .describe('按时间窗回溯（小时），如 24=最近一天、168=最近一周。传了就不走已读游标'),
        mark_read: z
          .boolean()
          .default(false)
          .describe('是否把这批标为已读（仅对默认模式生效）。用户没确认看过就别传 true'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'my_post_replies', {
        limit: args?.limit,
        since_hours: args?.since_hours,
        mark_read: args?.mark_read,
      });
      return g.ok
        ? {
            isError: false,
            content: [{ type: 'text' as const, text: summaryMyPostReplies(g.data) }],
          }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  server.registerTool(
    'my_digital_humans',
    {
      title: 'My Digital Humans',
      description:
        '列出当前已连接账号创建的数字人，含是否过期、剩余天数、所在位置与对话链接。数字人有 30 天有效期、创建消耗 2 枚徽章，所以回答「我的数字人还能用多久」「什么时候到期」必须先调本工具。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('返回条数，默认 20'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'my_digital_humans', { limit: args?.limit });
      return g.ok
        ? {
            isError: false,
            content: [{ type: 'text' as const, text: summaryMyDigitalHumans(g.data) }],
          }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  // ---- v0.17.0（Phase 2）：社交关系 / 收藏 / 徽章流水（均以本人身份读自己的数据）----
  server.registerTool(
    'my_following',
    {
      title: 'People I Follow',
      description:
        '列出当前账号在 PowPow 关注的人（按关注时间倒序，含昵称、用户名、简介、主页链接）。注意 PowPow 的「好友」不是单独的关系，而是互相关注的结果；问「我的好友」应调用 list_friends。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('返回条数，默认 20'),
        offset: z.number().int().min(0).default(0).describe('翻页偏移，默认 0'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'my_following', {
        limit: args?.limit,
        offset: args?.offset,
      });
      return g.ok
        ? {
            isError: false,
            content: [{ type: 'text' as const, text: summaryUserList(g.data, 'following') }],
          }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  server.registerTool(
    'my_followers',
    {
      title: 'My Followers',
      description:
        '列出关注当前账号的人（按关注时间倒序）。每项带 is_mutual 标记：为 true 说明你也回关了，也就是 PowPow 里的「好友」。用于回答「谁关注我」「有没有新粉丝」。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('返回条数，默认 20'),
        offset: z.number().int().min(0).default(0).describe('翻页偏移，默认 0'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'my_followers', {
        limit: args?.limit,
        offset: args?.offset,
      });
      return g.ok
        ? {
            isError: false,
            content: [{ type: 'text' as const, text: summaryUserList(g.data, 'followers') }],
          }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  server.registerTool(
    'list_friends',
    {
      title: 'My Friends',
      description:
        '列出当前账号在 PowPow 的好友。PowPow 没有「好友申请」流程：好友 = 你关注的人里也关注了你的人（互相关注）。用于「我有哪些好友」「我和谁是互关」。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('返回条数，默认 20'),
        offset: z.number().int().min(0).default(0).describe('翻页偏移，默认 0'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'my_friends', {
        limit: args?.limit,
        offset: args?.offset,
      });
      return g.ok
        ? {
            isError: false,
            content: [{ type: 'text' as const, text: summaryUserList(g.data, 'friends') }],
          }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  server.registerTool(
    'list_favorites',
    {
      title: 'My Favorites',
      description:
        '列出当前账号在 PowPow 的收藏（三类：地点 location、帖子 post、数字人 digital_human），可带分类、标签与备注。用于「我收藏了哪些地方」「我之前存的那个帖子」。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('返回条数，默认 20'),
        offset: z.number().int().min(0).default(0).describe('翻页偏移，默认 0'),
        item_type: z
          .enum(['location', 'post', 'digital_human'])
          .optional()
          .describe('只看某一类收藏，不传则为全部'),
        category: z.string().optional().describe('按收藏分类过滤，如「必去」「想去」'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'my_favorites', {
        limit: args?.limit,
        offset: args?.offset,
        item_type: args?.item_type,
        category: args?.category,
      });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryFavorites(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  server.registerTool(
    'get_badge_history',
    {
      title: 'My Badge History',
      description:
        '查看当前账号的徽章余额与发放/消耗流水（时间、增减数量、变动后余额、来源如活动打卡、操作类型）。用于「我的徽章怎么来的」「最近有没有扣徽章」。徽章不能通过本工具增减，只能查看。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20).describe('返回条数，默认 20'),
        offset: z.number().int().min(0).default(0).describe('翻页偏移，默认 0'),
        source: z.string().optional().describe('按来源过滤，如 campaign_checkin'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'my_badge_history', {
        limit: args?.limit,
        offset: args?.offset,
        source: args?.source,
      });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryBadgeHistory(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayFailureText(g) }] };
    },
  );

  // ---- v0.17.0：公开只读（不需要登录）----
  server.registerTool(
    'get_user_profile',
    {
      title: 'User Profile',
      description:
        '查看任意 PowPow 用户的公开主页：昵称、简介、徽章数、帖子/关注/粉丝数、最近 3 条帖子。入参可以是用户 ID（UUID）或用户名（可带 @）。已登录时还会告诉你是否已关注 TA。用于「看看这个人的主页」「@xxx 是谁」。',
      inputSchema: z.object({
        user: z.string().describe('用户 ID（UUID）或用户名，例如 @dongtao'),
      }),
      annotations: OPEN_WORLD_READ_ANNOTATIONS,
    },
    async (args: any) => {
      const viewerId = authUser?.powpowUserId ?? null;
      const r = await fetchPublicUserProfile(args?.user, viewerId);
      return (r as any)?.error
        ? jsonResult(r)
        : { isError: false, content: [{ type: 'text' as const, text: summaryUserProfile((r as any).data) }] };
    },
  );

  server.registerTool(
    'search_users',
    {
      title: 'Search Users',
      description:
        '按用户名或昵称模糊搜索 PowPow 用户（不区分大小写，最多 20 条）。返回昵称、用户名、简介与主页链接；已登录时标注哪些是你已关注的人。用于「帮我找找叫 xx 的用户」。',
      inputSchema: z.object({
        q: z.string().describe('搜索关键词：用户名或昵称的一部分'),
        limit: z.number().int().min(1).max(20).default(10).describe('返回条数，默认 10'),
      }),
      annotations: OPEN_WORLD_READ_ANNOTATIONS,
    },
    async (args: any) => {
      const viewerId = authUser?.powpowUserId ?? null;
      const r = await searchPublicUsers(args?.q, args?.limit ?? 10, viewerId);
      return (r as any)?.error
        ? jsonResult(r)
        : { isError: false, content: [{ type: 'text' as const, text: summarySearchUsers((r as any).data) }] };
    },
  );

  // ---- v0.18.0（Phase 3）写能力 A：关注与收藏 ----
  // 每个动作单独成一个工具（plugin-guidelines.md 明确禁止 generic executor /
  // action 参数聚合），annotations 按官方口径标注。
  server.registerTool(
    'follow_user',
    {
      title: 'Follow a Person',
      description:
        '关注 PowPow 上的某个人。需要 user_id——先用 search_users 或 get_user_profile 查到对方的 user_id，不要把昵称当 id 传。重复关注不会报错。注意：PowPow 没有「加好友」这个动作，好友 = 互相关注，返回值里的 is_friend 会说明对方是否也关注你。',
      inputSchema: z.object({
        user_id: z.string().describe('要关注的用户 id（36 位，来自 search_users / get_user_profile 的结果）'),
      }),
      annotations: WRITE_ADD_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'follow', { user_id: args?.user_id });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryFollow(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'unfollow_user',
    {
      title: 'Unfollow a Person',
      description:
        '取消关注 PowPow 上的某个人。需要 user_id。本来就没关注也不会报错，返回 removed=false。',
      inputSchema: z.object({
        user_id: z.string().describe('要取消关注的用户 id'),
      }),
      annotations: WRITE_DESTRUCTIVE_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'unfollow', { user_id: args?.user_id });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryUnfollow(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'add_favorite',
    {
      title: 'Add to Favorites',
      description:
        '把地点、帖子或数字人加入当前账号的收藏夹，可附带分类、标签和备注。item_type 为 location / post / digital_human；post 与 digital_human 必须真实存在。重复收藏同一内容不会报错。',
      inputSchema: z.object({
        item_type: z
          .enum(['location', 'post', 'digital_human'])
          .describe('收藏对象类型：location 地点 / post 帖子 / digital_human 数字人'),
        item_id: z.string().describe('对象 id（帖子 id、数字人 id，或地点的自定义标识）'),
        item_name: z.string().describe('给用户看的名字，如地名或帖子摘要，用于收藏列表展示'),
        category: z.string().optional().describe('自定义分类，如「必去」「想去」「美食」，最长 50 字'),
        tags: z.array(z.string()).optional().describe('标签数组，最多 10 个，单个最长 20 字'),
        note: z.string().optional().describe('备注'),
      }),
      annotations: WRITE_ADD_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'favorite_add', {
        item_type: args?.item_type,
        item_id: args?.item_id,
        item_name: args?.item_name,
        category: args?.category,
        tags: args?.tags,
        note: args?.note,
      });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryFavoriteAdd(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'update_favorite',
    {
      title: 'Update a Favorite',
      description:
        '修改某条收藏的分类、标签或备注（只改你传的字段，没传的保持原样）。需要收藏记录 id，可用 list_favorites 查到。注意这会覆盖原来填的内容，没有历史版本。',
      inputSchema: z.object({
        id: z.string().describe('收藏记录 id（来自 list_favorites）'),
        category: z.string().optional().describe('新的分类；传空字符串表示清空'),
        tags: z.array(z.string()).optional().describe('新的标签数组（整体替换）；传空数组表示清空'),
        note: z.string().optional().describe('新的备注；传空字符串表示清空'),
      }),
      annotations: WRITE_DESTRUCTIVE_ANNOTATIONS,
    },
    async (args: any) => {
      const payload: Record<string, unknown> = { id: args?.id };
      for (const k of ['category', 'tags', 'note'] as const) {
        if (args?.[k] !== undefined) payload[k] = args[k];
      }
      const g = await callGateway(accessToken, 'favorite_update', payload);
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryFavorite(g.data, '更新') }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'remove_favorite',
    {
      title: 'Remove a Favorite',
      description:
        '把某条收藏从收藏夹删除。需要收藏记录 id。本来就不存在也不会报错，返回 removed=false。',
      inputSchema: z.object({
        id: z.string().describe('收藏记录 id（来自 list_favorites）'),
      }),
      annotations: WRITE_DESTRUCTIVE_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'favorite_remove', { id: args?.id });
      return g.ok
        ? {
            isError: false,
            content: [
              {
                type: 'text' as const,
                text: g.data?.removed ? '已从收藏夹移除。' : '收藏里本来就没有这条，没有变化。',
              },
            ],
          }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  // ---- v0.19.0（Phase 4）写能力 B：内容（草稿 → 发布 → 撤回 / 点赞）----
  // 两步式不是洁癖：publish_post 的唯一入参是 draft_id，没有草稿就发不出去，
  // 「模型跳过确认直接公开」在结构上不可能发生。
  server.registerTool(
    'prepare_post',
    {
      title: 'Prepare a Post',
      description:
        '准备一条要发布到 PowPow 的泡泡（保存为草稿，**不会公开**）。真正公开必须再调用 publish_post 并带上返回的 draft_id。content 是正文（最多 5000 字）；images 是用户在对话里上传的图片（最多 3 张）——用户发了图，就把那张图作为文件传进这个参数（用客户端给出的文件引用，不要自己编造 URL）；正文和图片至少要有一样。place 是可选地名，会解析成地图位置，发布后这条泡泡会出现在该地点。草稿 1 小时内有效。',
      inputSchema: z.object({
        content: z.string().describe('正文，最多 5000 字。直接写给人看的内容，不要包含 HTML 标签。只发图时可以不传'),
        place: z
          .string()
          .optional()
          .describe('地点名，如「故宫博物院」「国贸」。留空则发布为不带位置的普通帖子（只进信息流，不进地图）'),
        images: z
          .array(OpenAIFileSchema)
          .max(3)
          .optional()
          .describe('用户在对话里上传的图片，最多 3 张。用户发了图就带上这个参数，用客户端给出的文件引用；不要自己编造 download_url 或图片链接'),
      }),
      annotations: WRITE_ADD_ANNOTATIONS,
      // 声明 images 为文件参数：ChatGPT 会把它替换成 { download_url, file_id, ... }
      _meta: { 'openai/fileParams': ['images'] },
    },
    async (args: any) => {
      const content = typeof args?.content === 'string' ? args.content.trim() : '';
      const files = Array.isArray(args?.images) ? args.images : [];
      const imageUrls = files
        .map((f: any) => (typeof f?.download_url === 'string' ? f.download_url.trim() : ''))
        .filter(Boolean);
      const imageKeys = files
        .map((f: any) => (typeof f?.file_id === 'string' ? f.file_id.trim() : ''))
        .filter(Boolean);

      if (!content && imageUrls.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: '正文和图片至少要有一样：写点内容，或者让用户先发一张图。',
            },
          ],
        };
      }

      const payload: Record<string, unknown> = { content };
      if (imageUrls.length > 0) payload.image_urls = imageUrls;
      if (imageKeys.length > 0) payload.image_keys = imageKeys;
      const place = typeof args?.place === 'string' ? args.place.trim() : '';
      if (place) {
        const geo = await geocodePlace(place);
        if (!geo) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `没查到这个地点：「${place}」。换一个更具体的名字（如「故宫博物院」而不是「故宫」），或者不带位置直接发布。`,
              },
            ],
          };
        }
        payload.lat = geo.lat;
        payload.lng = geo.lng;
        payload.location_name = geo.matched_name ?? place;
      }

      const g = await callGateway(accessToken, 'post_draft', payload);
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryPreparePost(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  // ---- v0.22.4：临时对照工具（v0.23.4 起由 MCP_ENABLE_PROBE 控制，默认不注册）----
  // 线上 5 次 prepare_post 的 arg_keys 只有 ["content"]，images 恒为 absent。
  // 官方 blog 明说 tools can directly consume files uploaded in the chat via
  // openai/fileParams，所以机制存在；而 codex 源码（file_params.rs）显示注入的
  // 前提是「模型先在参数里给出文件引用」——images 是 optional，模型就可能干脆不填。
  // 本工具除 required 外与 prepare_post 完全一致，用来隔离这一个变量：
  // 同一台手机、同一张图分别调两个，看哪个真收到 images。
  if (PROBE_ENABLED) {
    server.registerTool(
      'prepare_post_probe',
      {
        title: 'Prepare a Post (file-param probe)',
        description:
          '诊断工具：只检查用户在对话里上传的图片有没有进入工具参数，不建草稿、不发布。正常发帖请用 prepare_post；只有用户明确要求排查图片上传问题时才调用本工具。返回的是收到的文件清单（file_id、MIME、来源域名），请把内容原样念给用户。',
        inputSchema: z.object({
          content: z.string().describe('正文，最多 5000 字'),
          images: z
            .array(OpenAIFileSchema)
            .min(1)
            .max(3)
            .describe('用户在对话里上传的图片，1–3 张。用客户端给出的文件引用，不要自己编造 download_url'),
        }),
        annotations: WRITE_ADD_ANNOTATIONS,
        _meta: { 'openai/fileParams': ['images'] },
      },
      async (args: any) => {
        const files = Array.isArray(args?.images) ? args.images : [];
        const lines = files.map((f: any, i: number) => {
          const url = typeof f?.download_url === 'string' ? f.download_url.trim() : '';
          let host = '(缺)';
          if (url) {
            try {
              host = new URL(url).host;
            } catch {
              host = '(无法解析)';
            }
          }
          const fid = typeof f?.file_id === 'string' ? f.file_id : '(缺)';
          return `${i + 1}. file_id=${fid} mime=${f?.mime_type ?? '(缺)'} host=${host}`;
        });
        // 只回报形状、不建草稿：探针的目的是看「注入有没有发生」，
        // 不该在正式库里留垃圾帖。日志里 mcp_request_logs.arg_keys 同样是证据。
        return {
          isError: false,
          content: [
            {
              type: 'text' as const,
              text:
                `收到 ${files.length} 个文件参数：\n${lines.join('\n') || '(空)'}\n\n` +
                '这是诊断工具，没有生成草稿。请把上面这段原样念给用户听。',
            },
          ],
        };
      },
    );
  }

  server.registerTool(
    'publish_post',
    {
      title: 'Publish a Prepared Post',
      description:
        '把 prepare_post 生成的草稿真正发布出去。必须带 draft_id。发布后立即公开：其他人能在 PowPow 信息流看到，带地点时还会出现在地图上。同一 draft_id 重复调用不会重复发帖，会返回同一条帖子。',
      inputSchema: z.object({
        draft_id: z.string().describe('prepare_post 返回的 draft_id'),
      }),
      annotations: WRITE_PUBLIC_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'post_publish', { draft_id: args?.draft_id });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryPublishPost(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'delete_post',
    {
      title: 'Delete an AI-published Post',
      description:
        '撤回**通过 AI 发布**的帖子，仅限发布后 24 小时内。站内自己发的帖子不在这里删——请到站内帖子页删除。删除不可撤销，帖子的评论和点赞会一起消失。',
      inputSchema: z.object({
        post_id: z.string().describe('要撤回的帖子 id（publish_post 返回的 post_id）'),
      }),
      annotations: WRITE_DESTRUCTIVE_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'post_delete', { post_id: args?.post_id });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryDeletePost(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'like_post',
    {
      title: 'Like a Post',
      description:
        '给某条帖子点赞。需要 post_id，可从 search_posts、get_post_detail 或 find_nearby 的结果里取。已经点过不会报错。若这条泡泡已经过期，点赞会把它延长 24 小时。',
      inputSchema: z.object({
        post_id: z.string().describe('帖子 id。8 位短 id 即可，也接受完整 id 或帖子链接'),
      }),
      annotations: WRITE_ADD_ANNOTATIONS,
    },
    async (args: any) => {
      const ref = await resolvePostRef(anonClient(), args?.post_id);
      if (!ref.id) {
        return { isError: true, content: [{ type: 'text' as const, text: ref.error ?? '缺少 post_id' }] };
      }
      const g = await callGateway(accessToken, 'post_like', { post_id: ref.id });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryLikePost(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'unlike_post',
    {
      title: 'Unlike a Post',
      description: '取消对某条帖子的点赞。本来没点过也不会报错。',
      inputSchema: z.object({
        post_id: z.string().describe('帖子 id。8 位短 id 即可，也接受完整 id 或帖子链接'),
      }),
      annotations: WRITE_DESTRUCTIVE_ANNOTATIONS,
    },
    async (args: any) => {
      const ref = await resolvePostRef(anonClient(), args?.post_id);
      if (!ref.id) {
        return { isError: true, content: [{ type: 'text' as const, text: ref.error ?? '缺少 post_id' }] };
      }
      const g = await callGateway(accessToken, 'post_unlike', { post_id: ref.id });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryUnlikePost(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  // v0.23.0（Phase 6）：评论互动三件套之三——写侧，发评论 / 回复。
  // 入参刻意只收一个「回复哪条」，不暴露 parent_id / reply_to_user_id：库表是
  // 两层结构且「只能回复一级评论」，把原始字段交给模型必然填错（详见网关
  // actionCommentCreate 的注释）。模型只需把 get_post_replies 里的评论 id 丢进来。
  server.registerTool(
    'reply_to_post',
    {
      title: 'Comment on a Post',
      description:
        '在某条公开帖子下发评论；传了 reply_to_comment_id 就是回复那条评论（别人对别人的回复也能回，不用自己判断层级）。**发出前必须把正文原样念给用户确认**——这是以用户本人名义公开留言，站内所有人都能看到。正文 500 字以内、不能为空。',
      inputSchema: z.object({
        post_id: z.string().describe('帖子 id。8 位短 id 即可，也接受完整 id 或帖子链接'),
        content: z.string().describe('评论正文，500 字以内'),
        reply_to_comment_id: z
          .string()
          .optional()
          .describe(
            '要回复的评论 id（get_post_replies 输出的 8 位短 id 就够）。不传就是新发一条一级评论',
          ),
      }),
      annotations: WRITE_ADD_ANNOTATIONS,
    },
    async (args: any) => {
      const postId = String(args?.post_id ?? '').trim();
      const content = String(args?.content ?? '').trim();
      if (!postId) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: '缺少 post_id：请先确认要评论哪条帖子。' }],
        };
      }
      if (!content) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: '评论正文不能为空。' }],
        };
      }
      if (content.length > 500) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `评论正文最多 500 字，当前 ${content.length} 字，请删减后再发。`,
            },
          ],
        };
      }
      const ref = await resolvePostRef(anonClient(), postId);
      if (!ref.id) {
        return { isError: true, content: [{ type: 'text' as const, text: ref.error ?? '未找到该帖子' }] };
      }
      let replyId: string | undefined;
      if (args?.reply_to_comment_id) {
        const c = await resolveCommentRef(anonClient(), args.reply_to_comment_id, ref.id);
        if (!c.id) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: c.error ?? '未找到要回复的评论' }],
          };
        }
        replyId = c.id;
      }
      const g = await callGateway(accessToken, 'comment_create', {
        post_id: ref.id,
        content,
        reply_to_comment_id: replyId,
      });
      return g.ok
        ? {
            isError: false,
            content: [{ type: 'text' as const, text: summaryCommentCreate(g.data) }],
          }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'update_profile',
    {
      title: 'Update My Profile',
      description:
        '修改用户自己的 PowPow 昵称或个人简介。昵称 1-20 字，简介 200 字以内；可同时改，至少传一个（bio 传空字符串表示清空简介）。修改后立即在全站生效。注意：头像不能通过这里更换，请让用户到站内设置里操作。',
      inputSchema: z.object({
        nickname: z.string().optional().describe('新昵称，1-20 个字符。不传则不改'),
        bio: z.string().optional().describe('新的个人简介，200 字以内。传空字符串表示清空'),
      }),
      annotations: WRITE_DESTRUCTIVE_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'profile_update', {
        nickname: args?.nickname,
        bio: args?.bio,
      });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryProfileUpdate(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'create_digital_human',
    {
      title: 'Create a Digital Human',
      description:
        '帮用户创建一个 PowPow 数字人（可对话的 AI 角色）。创建成功扣 2 个徽章，30 天后过期。数字人会出现在地图上，其他人可以找到它并和它对话，所以创建前必须先和用户确认名字与人设。位置用地名描述（不要传坐标），不传则用用户上次在站内的定位。头像是品牌默认样式，可在站内更换。',
      inputSchema: z.object({
        name: z.string().describe('数字人名字，100 字以内'),
        description: z.string().describe('数字人的人设与说话风格，会直接影响它对话的方式'),
        location: z
          .string()
          .optional()
          .describe('地点名，如「北京故宫」。决定它出现在地图上的位置；不传则用上次定位'),
      }),
      annotations: WRITE_PUBLISH_DH_ANNOTATIONS,
    },
    async (args: any) => {
      const name = String(args?.name ?? '').trim();
      const description = String(args?.description ?? '').trim();
      if (!name || !description) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: '需要同时提供 name（名字）和 description（人设描述）。' }],
        };
      }

      // 地名 → 坐标在 Edge 侧完成（复用 geocode_place 同一条高德链路与相关性排序）。
      // 两个原因：① 插件规范不得索取精确坐标，工具入参只接受地名；② 网关侧不持
      // 高德 key，坐标解析属于「理解用户输入」，不属于「以用户身份写数据」。
      let lng: number | undefined;
      let lat: number | undefined;
      let locationName: string | undefined;
      if (args?.location) {
        const place = String(args.location).trim();
        const geo = await geocodePlace(place);
        if (!geo) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `没找到「${place}」的位置。换个更具体的地名（如「北京故宫博物院」），或者不传 location 用上次定位。`,
              },
            ],
          };
        }
        lng = geo.lng;
        lat = geo.lat;
        locationName = geo.matched_name || place;
      }

      const g = await callGateway(accessToken, 'dh_create', {
        name,
        description,
        lng,
        lat,
        location_name: locationName,
      });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryDhCreate(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  server.registerTool(
    'delete_digital_human',
    {
      title: 'Delete an AI-created Digital Human',
      description:
        '撤销**通过 AI 创建**的数字人，仅限创建后 24 小时内、且还没有和它聊过天；满足条件时删除并退还创建时扣的徽章。站内自己建的数字人不在这里删，请到站内「我的数字人」操作。删除后它从地图上消失，对话记录一起清空。',
      inputSchema: z.object({
        id: z.string().describe('要撤销的数字人 id（create_digital_human 或 my_digital_humans 返回的 id）'),
      }),
      annotations: WRITE_DESTRUCTIVE_ANNOTATIONS,
    },
    async (args: any) => {
      const g = await callGateway(accessToken, 'dh_delete', { id: args?.id });
      return g.ok
        ? { isError: false, content: [{ type: 'text' as const, text: summaryDhDelete(g.data) }] }
        : { isError: true, content: [{ type: 'text' as const, text: gatewayWriteFailureText(g) }] };
    },
  );

  // MCP Apps UI 资源：widget HTML 经 resources/read 交付。v0.13.0 起 widget 模板
  // 绑定在 find_nearby 的 _meta 上（见上），资源自身只负责交付 HTML；不再单开
  // render_nearby_widget 工具——独立的「渲染」工具模型不会主动调用，正是线上
  // 「连接成功但 UI 光秃秃」的根因（审计日志：resources/read 有、render 调用 0 次）。
  if (!HIDE_WIDGET) {
    // _meta 带 prefersBorder 与 CSP。
    // availableDisplayModes 让 ChatGPT 在加载前就选定展示模式（组件支持 inline+fullscreen）；
    // widgetDescription 给模型一句话描述组件，减少它复述组件内容。
    //
    // v0.13.10 注：v0.13.5 曾在此加 openai/widgetCSP.redirect_domains（官方
    // reference.md:422 要求，解决 widget 8 处 openExternal 悬空）。该批字段是
    // ChatGPT 创建校验的嫌疑对象，13.10 回退至 v0.13.4 最小形态；13.10 实证
    // 创建通过后，13.11 按计划单独加回本键（单变量验证其是否为卡点）。
    // 仍未加回：csp.connectDomains 与 resourceDomains:['https:']（widget 零外部
    // 请求，用不到 connectDomains；头像域已由 v0.14.5 具体域名白名单覆盖）。
    const resourceMeta = {
      ui: {
        prefersBorder: true,
        csp: {
          // v0.13.10：回退 v0.13.4 形态——仅 resourceDomains 具体域名。
          // v0.13.5 加的 connectDomains 是创建校验的并列嫌疑字段，暂不加回。
          // v0.14.5：执行 13.10 头注预案「实测破图再按 13.5 方案放宽」——
          //   放行 unsplash/picsum 两域（与 mediaHostAllowed 白名单同步，
          //   生产库 posts 图 94+5 条，见文件头注）。仅加具体域名，
          //   不加新键，失败可整域回退。
          // v0.14.11：加 OSM 瓦片域（地图底图）。OSM 官方 Tile Usage Policy 明确要求
          //   「Use exactly: https://tile.openstreetmap.org/{z}/{x}/{y}.png」，并注明
          //   「Other subdomains or hostnames may be slower or withdrawn without notice」
          //   → 单一域名，无需通配符、无需列 a/b/c 子域（本地 nslookup 实证 tile.osm.org
          //   与 tile.openstreetmap.org 同一 Fastly CNAME）。Leaflet 已内联，
          //   不新增脚本域，本批只加这一个域，保持单变量验证。
          resourceDomains: [SITE_URL, SUPABASE_URL || 'https://xhahsqbaohraqrdhtvay.supabase.co', 'https://images.unsplash.com', 'https://picsum.photos', 'https://tile.openstreetmap.org'],
        },
      },
      // v0.13.11：加回 redirect_domains（官方 reference.md:422：window.openai.
      // openExternal 的跳转目标白名单必须走这个 legacy snake_case 键，
      // _meta.ui.csp 不支持）。缺它 widget 内 8 处「打开完整版」全部悬空。
      'openai/widgetCSP': {
        redirect_domains: [SITE_URL, 'https://powpow.online', 'https://www.powpow.online'],
      },
      // v0.14.11：显式钉死初始形态。mcp-extensions spec 规定「同时声明 inline+fullscreen
      // 时默认进 fullscreen」，但我们此前只写了 availableDisplayModes 没写本键，
      // 线上实际仍是 inline（宿主行为与规范有出入）。显式声明可防宿主某次更新后
      // 卡片列表突然全屏弹出。
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' },
      'openai/widgetDescription':
        // v0.13.4：组件已支持四种形态（数字人/帖子/景点商圈/活动），描述要覆盖，
        // 否则模型会以为组件只显示数字人，进而复述卡片内容。
        // v0.14.11：补「全屏地图」——否则模型不知道展开后能看到空间分布，
        // 会在回答里用文字重复罗列距离。
        '「PowPow 发现」交互组件：卡片列表 + 地图，支持附近公开数字人（头像/简介/位置/距离）、公开帖子摘要、附近景点与商圈、以及已发布活动，均内置 PowPow 放射形快捷菜单与「打开完整版」入口；对话内联形态顶部即有地图预览条（带聚合标记，可缩放拖动），点右上角展开全屏后左侧卡片列表、右侧大地图（按缩放级别自动聚合，点标记可看详情并跳转）。由 find_nearby / search_posts / nearby_attractions / list_campaigns 工具触发渲染。',
    };
    const readWidget = async (uri: URL) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: UI_MIME_TYPE,
          text: WIDGET_HTML,
          _meta: resourceMeta,
        },
      ],
    });

    server.registerResource(
      'powpow-nearby-discovery',
      RESOURCE_URI,
      {
        title: 'PowPow 附近发现',
        description:
          '「PowPow 附近发现」交互组件：附近公开数字人卡片列表 + PowPow 放射形快捷菜单 + 打开完整版入口。由 find_nearby 工具触发渲染。',
        mimeType: UI_MIME_TYPE,
        _meta: resourceMeta,
      },
      readWidget,
    );

    // v0.13.1：同组件的模板化入口，供 resources/templates/list 发现。官方 pizzaz
    // 示例同时注册 resources + resourceTemplates；只给 resources 时宿主可能找不到
    // 可挂载的组件模板。
    // ⚠️ 必须用 SDK 的 ResourceTemplate 类（`new ResourceTemplate(uri, { list?, complete? })`），
    // 不能传裸 UriTemplate 实例或 `{ uriTemplate }` 普通对象：SDK 注册时执行
    // `template.uriTemplate.variableNames.some(v => !!template.completeCallback(v))`，
    // 对这两种写法都会抛 TypeError → 工厂函数每次请求都炸 → 全线 500
    // （本项目 v0.13.1 首次上线即踩中，本地 Node harness 定位）。
    server.registerResource(
      'powpow-nearby-discovery-template',
      new ResourceTemplate(RESOURCE_URI_TEMPLATE, {}),
      {
        title: 'PowPow 附近发现',
        description:
          '「PowPow 附近发现」交互组件（模板）：附近公开数字人卡片列表 + PowPow 放射形快捷菜单 + 打开完整版入口。由 find_nearby 工具触发渲染。',
        mimeType: UI_MIME_TYPE,
        _meta: resourceMeta,
      },
      readWidget,
    );
  }

    return server;
  });
}

// ---- HTTP 入口（官方形态 Deno.serve((req) => handler.fetch(req)) + 审计日志 + CORS）----
Deno.serve(async (req: Request): Promise<Response> => {
  // CORS 预检（网页版 MCP 客户端）
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 审计日志：clone 读请求体，不影响 handler 消费原 body
  const url = new URL(req.url);
  let bodyText: string | null = null;
  if (req.method === 'POST') {
    try {
      bodyText = await req.clone().text();
    } catch {
      /* ignore */
    }
  }
  let rpc: string | null = null;
  if (bodyText) {
    try {
      rpc = (JSON.parse(bodyText) as any)?.method ?? null;
    } catch {
      /* ignore */
    }
  }

  // v0.13.7：resources/read 头补齐 shim。OpenAI 新校验组件（弗吉尼亚 56.10.x、
  // 3.0.61.x 等）读 widget 时不带 Mcp-Method / MCP-Protocol-Version / Mcp-Name 头，
  // SDK 2.3.1 现代协议路径会以 -32020 拒绝（400）→ 组件重试 4 次、耗时 71 秒仍可能
  // 验证失败（10-14 实测 3×400+1×200）。
  // v0.13.9：泛化到【所有 modern 请求】。10-14 复测 ChatGPT 真实请求序列发现
  // 不止 resources/read——server/discover、tools/list、tools/call 等任何带
  // _meta 信封的请求缺头都会被 -32020 拒（HTTP 400）。这里在进 SDK 前从 body
  // 补齐【缺失】的头。只补缺失、绝不覆盖已有值：客户端已发送的头之间的 -32020
  // 失配检查仍由 SDK 执行（防盗链语义保留）。legacy initialize 无 _meta 信封，
  // 不碰（Inspector 等 legacy 客户端零回归）。审计日志仍记录原始头 →
  // 可通过「mmh 为空但 status=200」识别 shim 命中。
  let handledReq = req;
  if (bodyText && rpc) {
    try {
      const parsed = JSON.parse(bodyText) as {
        method?: string;
        params?: { uri?: unknown; _meta?: Record<string, unknown> };
      };
      const pv = parsed.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
      const uri = parsed.params?.uri;
      // 仅 modern 请求（带 _meta 信封且信封里有协议版本）需要补头
      if (parsed.params?._meta && typeof pv === 'string') {
        const h = new Headers(req.headers);
        let patched = false;
        if (!h.get('mcp-method') && typeof parsed.method === 'string') {
          h.set('mcp-method', parsed.method);
          patched = true;
        }
        if (!h.get('mcp-protocol-version')) {
          h.set('mcp-protocol-version', pv);
          patched = true;
        }
        if (!h.get('mcp-name') && typeof uri === 'string') {
          h.set('mcp-name', uri);
          patched = true;
        }
        if (patched) {
          handledReq = new Request(req.url, { method: 'POST', headers: h, body: bodyText });
        }
      }
    } catch {
      /* body 非 JSON 或已消费：原样交给 handler */
    }
  }

  // v0.13.8：path-level OAuth discovery 探测（路径含 /.well-known/）不进 SDK，直接
  // 返回干净 404 JSON。10-14 实测：ChatGPT noauth prober GET {endpoint}/.well-known/
  // {oauth-protected-resource,openid-configuration,oauth-authorization-server}（直连
  // /mcp-server/mcp/.well-known/* 三连 405）被 SDK 以 405「Method not allowed」拒绝
  // → ChatGPT 判「身份验证设置未通过验证」。RFC 9728：无 OAuth 时 discovery 路径
  // 语义上应为 404；根级 /.well-known/* 已由网关/代理层 404。404 仍走下方审计日志
  // → 可在 mcp_request_logs 按 status=404 + path 含 .well-known 确认 prober 命中。
  // v0.14.2：OAuth 层接管顺序——① metadata 路由（handleOAuthRoutes，仅
  // MCP_OAUTH=true 时生效）② 连接器级门禁（无有效 token → 401 +
  // WWW-Authenticate，触发 ChatGPT OAuth 授权流 = 应用内登录）③ .well-known
  // 404 hack（v0.13.8，auth.ts 未认领的探测路径）④ MCP handler（per-request
  // 构建，闭包带本次请求的用户身份，见 buildMcpHandler 注释）。
  // authenticate() 结果在门禁与 handler 间复用，只算一次（JWKS 验签 +
  // auth_users_link 桥接查询；MCP_OAUTH 关闭时整体短路，零开销）。
  let resp: Response;
  const oauthResp = handleOAuthRoutes(handledReq);
  if (oauthResp) {
    resp = oauthResp;
  } else {
    const authUser = MCP_OAUTH_ENABLED ? await authenticate(handledReq) : null;
    if (MCP_OAUTH_ENABLED && !authUser) {
      resp = unauthorizedHttp(handledReq);
    } else if (url.pathname.includes('/.well-known/')) {
      resp = new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } else {
      resp = await buildMcpHandler(authUser, parseBearer(handledReq)?.token ?? null).fetch(
        handledReq,
      );
    }
  }

  // 响应补 CORS 头（原样透传 body 与状态，不破坏 SSE 流）
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  // v0.13.6：补 charset=utf-8。官方 SDK 返回的 SSE/JSON Content-Type 不带 charset，
  // 而工具 description 是中文 → 客户端按错误编码解码会乱码（线上实测 find_nearby
  // 描述全乱码）。保留原有类型（text/event-stream / application/json），仅补 charset。
  const existingCT = headers.get('content-type') ?? '';
  if (existingCT && !/;\s*charset=/i.test(existingCT)) {
    headers.set('content-type', `${existingCT}; charset=utf-8`);
  }
  const out = new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });

  dbLog({
    method: req.method,
    path: url.pathname,
    host: url.host,
    user_agent: req.headers.get('user-agent'),
    accept: req.headers.get('accept'),
    origin: req.headers.get('origin'),
    session_id: req.headers.get('mcp-session-id'),
    client_ip: req.headers.get('x-forwarded-for'),
    protocol_version: req.headers.get('mcp-protocol-version'),
    mcp_method_header: req.headers.get('mcp-method'),
    mcp_name: req.headers.get('mcp-name'),
    rpc_methods: rpc,
    sse: (resp.headers.get('content-type') ?? '').includes('text/event-stream'),
    status: resp.status,
    request_body: bodyText ? bodyText.slice(0, 2000) : null,
  });

  return out;
});
