// v0.14.11：Leaflet 1.9.4 以字符串内联注入（见 leaflet-inline.ts）。
// v0.14.12：inline 形态也建图（顶部 168px 预览条），此前只有全屏才有地图。
// 不用 CDN：CSP 只声明 resourceDomains，多一个脚本域就多一个创建校验的嫌疑变量。
import { LEAFLET_CSS, LEAFLET_JS } from './leaflet-inline.ts';

// 站点对外域名：widget 外链目标（redirect_domains）/ 相对头像路径前缀。
// 定义在本模块（widget HTML 模板插值引用），index.ts 从这里导入。
export const SITE_URL = 'https://global.powpow.online';

// widget：自包含完整 HTML5 文档（v0.12.0 从 index.ts 原样抽出，内容未动）。
// 内联 CSS/JS，无外部依赖；JS 全用字符串拼接，避免模板字面量转义。
// 渲染规格复刻站点 (app)/map 页的 LeftBottomMenu（#B22222、80px 主按钮、72px 菜单项、
// 110px 半径、73° 起始每项 -30°、spring 近似 cubic-bezier(.34,1.56,.64,1)）。
export const WIDGET_HTML_RAW = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PowPow 附近发现</title>
<style>
/* v0.10.0：改回完整 HTML5 文档，全局 reset 回归全文档作用域（widget 自身
 * 即整个 iframe 文档，无需再收窄到根容器）。 */
.app, .app * { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --pp-red: #B22222;
  --pp-red-hover: #C94040;
  --bg: var(--color-background-primary, #ffffff);
  --bg2: var(--color-background-secondary, #f7f7f8);
  --fg: var(--color-text-primary, #0d0d0d);
  --fg2: var(--color-text-secondary, #6b6b6b);
  --border: var(--color-border-primary, rgba(13, 13, 13, 0.08));
  --font: var(--font-sans, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif);
}
.app {
  font-family: var(--font);
  background: var(--bg);
  color: var(--fg);
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
/* v0.13.3：对齐站点 LeftBottomMenu 的形态——菜单是「浮在内容上」的 FAB，
 * 扇形展开靠全屏遮罩盖住内容，不需要在底部预留任何空白。
 * 此前 padding-bottom:132px 造成组件底部一大块白块（截图实证）。 */
.app { position: relative; padding-bottom: 8px; }
.hdr { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 16px 10px; }
.hdr-title { font-size: 15px; font-weight: 700; letter-spacing: 0.2px; }
.hdr-sub { font-size: 12px; color: var(--fg2); margin-top: 1px; }
.icon-btn {
  width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg2); color: var(--fg); cursor: pointer; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.15s ease;
}
.icon-btn:hover { background: var(--border); }
.icon-btn svg { width: 15px; height: 15px; }
.cards { display: flex; flex-direction: column; gap: 8px; padding: 0 16px; max-height: 400px; overflow-y: auto; }
/* v0.13.5：.menu 是 absolute 定位的 80px FAB（bottom:12px），不占文档流，
 * 会永久压在 .cards 滚动区上，吃掉最后 1~2 张卡片的点击区。
 * 解法不能是「给 .app 加 padding-bottom」——那正是 v0.13.3 之前 132px 白块的成因。
 * 正解：把留白加在**滚动容器内部**（padding-bottom），这样
 *   - 列表不滚动时容器高度=内容高度，不产生任何多余空白；
 *   - 列表滚动时末尾卡片可被完整滚进这 92px 留白，不被 FAB 遮住。
 * 92 = FAB 高 80 + bottom 12。 */
.cards { padding-bottom: 0; }
.cards.is-scrollable { padding-bottom: 92px; }
.card {
  display: flex; gap: 12px; align-items: flex-start; width: 100%;
  padding: 12px; border-radius: 14px; border: 1px solid var(--border);
  background: var(--bg2); cursor: pointer; text-align: left;
  font-family: inherit; color: inherit;
  transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}
.card:hover { transform: translateY(-1px); border-color: rgba(178, 34, 34, 0.35); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.07); }
.avatar {
  width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0;
  object-fit: cover; background: linear-gradient(135deg, #B22222, #D05555);
  color: #ffffff; font-size: 17px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
/* v0.13.4：非数字人卡片（帖子/景点/活动）的首字徽标配色，按类型区分 */
.avatar-blue { background: linear-gradient(135deg, #2C5AA0, #4A7BC8); }
.avatar-green { background: linear-gradient(135deg, #1F6B54, #33997A); }
.avatar-red { background: linear-gradient(135deg, #B22222, #D05555); }
.avatar-gray { background: linear-gradient(135deg, #55554F, #7A7A72); }
.avatar-img { background: var(--bg2); }
/* v0.14.3：帖子卡头图缩略（84px 圆角矩形，替代 44px 圆形 glyph 位）。
 * 无图/加载失败时 JS 回退 .avatar-blue「帖」字圆块，布局不塌。 */
.thumb {
  width: 84px; height: 84px; border-radius: 10px; flex-shrink: 0;
  object-fit: cover; background: var(--bg2);
}
.card-body { flex: 1; min-width: 0; }
.card-name-row { display: flex; align-items: center; gap: 8px; }
/* 卡片标题行：数字人是短名（单行省略），帖子/景点是长文本（允许两行）。
 * v0.13.4起帖子卡标题是正文开头，故改为 line-clamp 2。 */
.card-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-name-wrap { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; flex-shrink: 0; background: rgba(178, 34, 34, 0.09); color: var(--pp-red); font-weight: 500; }
.card-desc { font-size: 12px; color: var(--fg2); margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
/* v0.14.9：帖子卡作者行（头像 + @昵称） */
.author-line { display: flex; align-items: center; gap: 6px; margin-top: 4px; min-width: 0; }
.author-avatar { width: 18px; height: 18px; border-radius: 999px; object-fit: cover; flex-shrink: 0; background: #eee; }
.author-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #8ab4f8, #5b8def); }
.author-name { font-size: 11px; color: var(--fg2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* v0.14.10：作者行可点 → 个人主页 */
.author-link { cursor: pointer; }
.author-link:hover .author-name, .author-link:focus-visible .author-name { color: var(--pp-red); }
.author-link:focus-visible { outline: 2px solid var(--pp-red); outline-offset: 2px; border-radius: 4px; }
.card-meta { display: flex; align-items: center; gap: 10px; margin-top: 5px; font-size: 11px; color: var(--fg2); }
.meta-item { display: inline-flex; align-items: center; gap: 3px; min-width: 0; }
.meta-item svg { width: 11px; height: 11px; flex-shrink: 0; }
.meta-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dist { color: var(--pp-red); font-weight: 500; }
/* v0.13.5：数字人卡「点进去聊天」的 affordance */
/* v0.14.8：动作区改成右上角一组——「资料」（次级，灰）+「聊一聊」（主，红）。
 * 次级放在外层容器里右对齐，故 chat 自身不再需要 margin-left:auto。 */
.card-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 12px; flex-shrink: 0; }
.chat-affordance { color: var(--pp-red); font-weight: 500; }
.detail-affordance { color: var(--fg2); font-weight: 500; cursor: pointer; }
.detail-affordance:hover { color: var(--pp-red); }
.card-meta .chat-affordance .meta-text, .card-meta .detail-affordance .meta-text { color: inherit; }
.empty { text-align: center; padding: 34px 16px 10px; color: var(--fg2); font-size: 13px; }
.empty svg { width: 34px; height: 34px; opacity: 0.35; margin-bottom: 8px; }
.spinner { width: 22px; height: 22px; margin: 40px auto; border-radius: 50%; border: 2.5px solid var(--border); border-top-color: var(--pp-red); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* 底部右「打开完整版」：与左侧 + 按钮垂直居中对齐（+ 按钮 80px、bottom:12px
 * → 圆心距底 52px；link-btn 高约 28px → bottom:38px 时圆心同为 52px）。 */
.foot { position: absolute; left: 16px; right: 16px; bottom: 38px; display: flex; justify-content: flex-end; }
.link-btn {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 500; font-family: inherit;
  color: var(--pp-red); background: var(--bg);
  border: 1px solid rgba(178, 34, 34, 0.3);
  padding: 6px 12px; border-radius: 999px; cursor: pointer;
  transition: background 0.15s ease;
}
.link-btn:hover { background: rgba(178, 34, 34, 0.06); }
.link-btn svg { width: 11px; height: 11px; }

/* ---- 放射形菜单（复刻站点 LeftBottomMenu）---- */
.menu-overlay {
  position: fixed; inset: 0; z-index: 40;
  background: rgba(0, 0, 0, 0.3);
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  opacity: 0; pointer-events: none; transition: opacity 0.22s ease;
}
.menu-overlay.show { opacity: 1; pointer-events: auto; }
/* v0.13.3：fixed → absolute。之前 fixed 是相对 iframe 视口定位，菜单浮在组件
 * 内容之上却不参与文档流，于是底部 padding-bottom:132px 全成了空白（截图实证）。
 * 改 absolute 后锚在 .app 自身左下角，扇形项向上展开、由 .menu-overlay
 * （fixed 全屏遮罩）盖住其余内容 —— 与站点 LeftBottomMenu「浮层 FAB、零预留」
 * 的形态一致。按钮尺寸 80px 保持不变（用户要求）。 */
.menu { position: absolute; left: 16px; bottom: 12px; width: 80px; height: 80px; z-index: 50; }
.menu-main {
  position: absolute; inset: 0; padding: 0; border-radius: 50%;
  background: var(--pp-red); border: 4px solid #ffffff; color: #ffffff;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  font-size: 36px; font-weight: 300; line-height: 1;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; z-index: 2; font-family: inherit;
  transition: transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.15s ease;
}
.menu-main:hover { background: var(--pp-red-hover); }
.menu.open .menu-main { transform: rotate(45deg) scale(1.1); }
.menu-item {
  position: absolute; left: 50%; top: 50%; padding: 0;
  width: 72px; height: 72px; border-radius: 50%;
  background: var(--pp-red); border: 2px solid #ffffff; color: #ffffff;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; z-index: 1; font-family: inherit;
  opacity: 0; pointer-events: none;
  transform: translate(-50%, -50%) scale(0.5);
  transition: transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.18s ease, background 0.15s ease;
}
.menu-item:hover { background: var(--pp-red-hover); }
.menu-item svg { width: 28px; height: 28px; }

/* 全屏（宿主模式切换 / 本地开发演示） */
/* v0.7.0：全屏类从宿主 body 改到 widget 根 #app（fragment 语义），选择器同步收窄 */
.app.is-fullscreen, .app.dev-fullscreen { min-height: 100vh; }
.app.is-fullscreen .cards, .app.dev-fullscreen .cards { max-height: calc(100vh - 250px); }

/* ---- v0.14.11：全屏地图视图 ---- */
/* 注入 Leaflet 1.9.4 样式（内联，不新增脚本域，见 leaflet-inline.ts） */
/*__LEAFLET_CSS__*/

/* 分栏：inline 时 map 不参与布局，行为与 v0.14.10 完全一致 */
.split { display: block; }
.map-pane { display: none; }
.app.is-fullscreen .split, .app.dev-fullscreen .split {
  display: flex; align-items: stretch;
  height: calc(100vh - 74px);
}
.app.is-fullscreen .split .cards, .app.dev-fullscreen .split .cards {
  flex: 0 0 360px; width: 360px; max-height: none;
  overflow-y: auto; padding-bottom: 104px;
}
.app.is-fullscreen .map-pane, .app.dev-fullscreen .map-pane {
  display: block; position: relative; flex: 1 1 auto; min-width: 0;
  border-left: 1px solid var(--border);
}
/* 地图不可用（Leaflet 未注入 / 无坐标数据）→ 退回单列，不白屏 */
.split.no-map .map-pane { display: none !important; }
.split.no-map .cards { flex: 1 1 auto !important; width: auto !important; }
/* ---- v0.14.12：inline 形态也给地图预览 ----
 * 用户反馈「对话里看不到地图」：v0.14.11 只在全屏建图，inline 纯卡片。
 * 官方 UI 指南虽建议地图走全屏（Extend → fullscreen），但产品要求「列表和地图
 * 在对话里同时可见」。折中：inline 用 168px 顶部地图条 + 卡片列表（压缩到
 * 240px 滚动），点右上角仍可展开成全屏分栏。
 * 高度按官方「inline card 可扩展到移动端显示区高度」估算，控制在 ~460px。 */
.app:not(.is-fullscreen):not(.dev-fullscreen) .split:not(.no-map) {
  display: flex; flex-direction: column;
}
.app:not(.is-fullscreen):not(.dev-fullscreen) .split:not(.no-map) .map-pane {
  display: block; order: 1; flex: 0 0 168px; min-height: 168px;
  position: relative; border-bottom: 1px solid var(--border);
}
.app:not(.is-fullscreen):not(.dev-fullscreen) .split:not(.no-map) .cards {
  order: 2; max-height: 240px;
}
.map { position: absolute; inset: 0; background: var(--bg2); }

/* CIS：只有红白灰 → 瓦片去色，红色标记才是唯一焦点。
 * 用滤镜而不换底图服务：零额外依赖、零 CSP 变更。 */
.map .leaflet-tile-pane { filter: grayscale(1) brightness(1.04) contrast(0.94); }
.map .leaflet-control-attribution {
  font-size: 10px; line-height: 1.6; padding: 1px 6px;
  background: rgba(255, 255, 255, 0.84); color: var(--fg2);
  border-radius: 4px 0 0 0;
}
.map .leaflet-control-zoom { border: 0; box-shadow: none; }
.map .leaflet-control-zoom a {
  width: 30px; height: 30px; line-height: 28px; font-size: 16px;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border);
  border-radius: 4px;
}
.map .leaflet-control-zoom a:hover { background: var(--bg2); color: var(--pp-red); }
.map .leaflet-control-zoom a:first-child { border-radius: 4px 4px 0 0; }
.map .leaflet-control-zoom a:last-child { border-radius: 0 0 4px 4px; border-top: 0; }

/* 单点：白圈 + 头像（CIS 无阴影、1px 细边框、红色描边） */
.mp {
  width: 40px; height: 40px; border-radius: 50%; overflow: hidden;
  background: #fff; border: 2px solid var(--pp-red);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600; color: var(--pp-red);
}
.mp img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 聚合点：白底 + 红描边 + 红数字（与站点聚合视觉同源） */
.mc {
  min-width: 36px; height: 34px; padding: 0 8px; border-radius: 999px;
  background: #fff; border: 2px solid var(--pp-red); color: var(--pp-red);
  font-size: 12px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
/* popup 是 CIS 明确豁免「可用阴影」的必要场景 */
.map .leaflet-popup-content-wrapper {
  border-radius: 8px; border: 1px solid var(--border);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
}
.map .leaflet-popup-content { margin: 10px 12px; font-family: var(--font); line-height: 1.5; }
.mpop { display: flex; gap: 9px; align-items: flex-start; width: 196px; }
.mpop-av {
  width: 34px; height: 34px; border-radius: 50%; flex: none; object-fit: cover;
  background: var(--pp-red); color: #fff; font-size: 13px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
.mpop-b { min-width: 0; flex: 1 1 auto; }
.mpop-n {
  font-size: 13px; font-weight: 600; color: var(--fg);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.mpop-m { font-size: 11px; color: var(--fg2); margin-top: 2px; }
.mpop-a {
  margin-top: 6px; font-size: 11px; font-weight: 500; color: var(--pp-red);
  cursor: pointer; display: inline-flex; align-items: center; gap: 3px;
}
.mpop-a svg { width: 11px; height: 11px; }
/* 从地图点回列表时，短暂高亮对应卡片 */
.card.card-hit { border-color: rgba(178, 34, 34, 0.75); }

/* 全屏时「打开完整版」按钮收进左栏，避免压住地图右下角的 OSM 署名 */
.app.is-fullscreen .foot, .app.dev-fullscreen .foot {
  right: auto; width: 344px; bottom: 22px;
}

/* 窄容器：上下堆叠，地图在上、列表在下 */
@media (max-width: 720px) {
  .app.is-fullscreen .split, .app.dev-fullscreen .split { flex-direction: column; }
  .app.is-fullscreen .split .cards, .app.dev-fullscreen .split .cards {
    flex: 1 1 auto; width: auto; order: 2; padding-bottom: 104px;
  }
  .app.is-fullscreen .map-pane, .app.dev-fullscreen .map-pane {
    order: 1; flex: 0 0 46vh; border-left: 0; border-bottom: 1px solid var(--border);
  }
  .app.is-fullscreen .foot, .app.dev-fullscreen .foot { width: auto; right: 16px; }
}
</style>
<div class="app" id="app">
  <div class="hdr">
    <div>
      <div class="hdr-title">PowPow 附近发现</div>
      <div class="hdr-sub" id="sub">正在加载…</div>
    </div>
    <button class="icon-btn" id="btn-full" type="button" title="全屏查看" aria-label="全屏查看"></button>
  </div>
  <div class="spinner" id="loading" role="status" aria-label="加载中"></div>
  <div class="split" id="split">
    <div class="cards" id="cards" hidden></div>
    <div class="map-pane" id="map-pane">
      <div class="map" id="map"></div>
    </div>
  </div>
  <div class="empty" id="empty" hidden></div>
  <div class="foot">
    <button class="link-btn" id="btn-open" type="button">打开完整版</button>
  </div>
  <div class="menu-overlay" id="menu-overlay"></div>
  <div class="menu" id="menu">
    <button class="menu-main" id="menu-btn" type="button" aria-label="打开菜单" title="菜单"><span style="display:block;margin-top:-3px;">+</span></button>
  </div>
</div>
<script>/*__LEAFLET_JS__*/</script>
<script type="module">
(function () {
  "use strict";
  var SITE_URL = "${SITE_URL}";

  var ICONS = {
    house: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    shrink: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    // v0.13.4：帖子/景点/活动三类卡片新增
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'
  };

  // 与站点 map 页 menuItems 一致（zh-CN：动态/发布/故事/好友/我的）
  var MENU_ITEMS = [
    { label: "动态", path: "/", icon: ICONS.house },
    { label: "发布", path: "/publish", icon: ICONS.message },
    { label: "故事", path: "/campaign", icon: ICONS.book },
    { label: "好友", path: "/friends", icon: ICONS.users },
    { label: "我的", path: "/profile", icon: ICONS.user }
  ];

  var state = { data: null, fullscreen: false, menuOpen: false, dev: false };
  var hostCaps = null;
  var hostTheme = null; // v0.13.12：host-context-changed 推送的宿主主题（light/dark），仅记录用
  var pending = {};
  var nextId = 1;
  var menuEls = [];

  function el(id) { return document.getElementById(id); }

  function icon(paths) {
    var t = document.createElement("template");
    t.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    return t.content.firstChild;
  }

  // ---------- MCP Apps UI 桥（postMessage JSON-RPC -> window.parent）----------
  function send(msg) {
    try { window.parent.postMessage(msg, "*"); } catch (e) { /* 跨域受限，忽略 */ }
  }
  function rpcRequest(method, params, timeoutMs) {
    var mid = "w" + (nextId++);
    return new Promise(function (resolve, reject) {
      var p = { resolve: resolve, reject: reject };
      pending[mid] = p;
      if (timeoutMs) {
        p.timer = setTimeout(function () {
          delete pending[mid];
          reject(new Error("bridge timeout: " + method));
        }, timeoutMs);
      }
      send({ jsonrpc: "2.0", id: mid, method: method, params: params || {} });
    });
  }
  function notify(method, params) {
    send({ jsonrpc: "2.0", method: method, params: params || {} });
  }
  window.addEventListener("message", function (ev) {
    // v0.6.0：只信任宿主窗口（官方 quickstart 同款校验）
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.method === "ui/notifications/tool-result") {
      onData(m.params || {});
      return;
    }
    // v0.13.12：host-context-changed（ext-apps 2.0.3 HOST_CONTEXT_CHANGED_METHOD）。
    // 宿主侧全屏按钮/系统主题切换会推这个通知，widget 据此同步：
    // ① displayMode——宿主替用户切了全屏时更新按钮图标（此前只认自己发的请求，
    //    宿主-initiated 切换会让按钮态与实际相反）；
    // ② theme——仅记录。视觉主题本身由宿主注入的 --color-* CSS 变量自动切换
    //    （widget :root 全套消费，见文件头 CSS），无需手动换 class。
    if (m.method === "ui/notifications/host-context-changed") {
      var hc = (m.params && (m.params.context || m.params)) || {};
      if (hc.displayMode && hc.displayMode !== state.fullscreen) {
        setFullscreen(hc.displayMode === "fullscreen");
      }
      if (hc.theme && hc.theme !== hostTheme) {
        hostTheme = hc.theme;
        try { console.log("[powpow-widget] host theme:", hostTheme); } catch (e) { /* 忽略 */ }
      }
      return;
    }
    if ((m.id !== undefined && m.id !== null) && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(new Error((m.error && m.error.message) || "bridge error"));
      else p.resolve(m.result || {});
    }
  });

  function initBridge() {
    // 顶层窗口 = 无宿主（file:// 直开或独立页）：postMessage 会自回声，
    // 必须跳过握手，直接进开发模式
    var top = false;
    try { top = window.parent === window; } catch (e) { top = false; }
    if (top) {
      enterDev();
      return;
    }
    rpcRequest("ui/initialize", {
      appInfo: { name: "powpow-nearby-discovery", title: "PowPow 附近发现", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: "2026-01-26"
    }, 3000).then(function (r) {
      hostCaps = (r && r.hostCapabilities) || {};
      notify("ui/notifications/initialized", {});
      setupSizeChanged();
    }).catch(function () {
      hostCaps = null;
      enterDev();
    });
  }

  // ---------- v0.13.11：自动高度上报（对齐 ext-apps 2.0.3 官方 autoResize）----------
  // 官方 App.setupSizeChangedNotifications() 同款方案：ResizeObserver 监听
  // documentElement/body，rAF 节流，测 documentElement 的 max-content 高度，
  // 尺寸变化时发 ui/notifications/size-changed { width, height }。inline 模式
  // 下宿主据此撑开 iframe，避免内容被滚动裁剪或大片留白。
  // 注：全屏切换（setFullscreen）会改变内容尺寸 → ResizeObserver 自然触发上报。
  function setupSizeChanged() {
    var scheduled = false, lastW = 0, lastH = 0;
    function report() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        var root = document.documentElement;
        var prev = root.style.height;
        root.style.height = "max-content";
        var h = Math.ceil(root.getBoundingClientRect().height);
        root.style.height = prev;
        var w = Math.ceil(window.innerWidth);
        if (w !== lastW || h !== lastH) {
          lastW = w;
          lastH = h;
          notify("ui/notifications/size-changed", { width: w, height: h });
        }
      });
    }
    report();
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(report);
      ro.observe(document.documentElement);
      ro.observe(document.body);
    }
    window.addEventListener("resize", report);
  }

  // ---------- 开发模式（无宿主：直接打开或本地服务器，渲染演示数据）----------
  function enterDev() {
    if (state.data || state.dev) return;
    var top = false;
    try { top = window.parent === window; } catch (e) { top = false; }
    var loc = window.location;
    var local = top || loc.protocol === "file:" || loc.hostname === "localhost" || loc.hostname === "127.0.0.1";
    if (local) {
      state.dev = true;
      renderView(demoData(new URLSearchParams(loc.search).get("demo") || undefined));
    }
  }

  // v0.13.4：本地预览各形态用。?demo=posts|attractions|campaigns（不带则默认数字人）
  function demoData(kind) {
    if (kind === "posts") {
      return {
        view: "posts", keyword: "故宫", total: 3, count: 3,
        posts: [
          // v0.14.3：d1 带 image_url 验证头图渲染；d2/d3 无图验证 glyph 回退
          { kind: "post", id: "d1", excerpt: "今天在故宫角楼拍到一组特别好的光线，红墙配蓝天，角楼的剪影像一尊剪纸。", image_url: "https://images.unsplash.com/photo-1508804185872-d7badad00f7d?w=200&h=200&fit=crop", location_name: "故宫博物院", location: { lat: 39.9163, lng: 116.3972 }, likes_count: 128, comments_count: 23, created_at: new Date(Date.now() - 3600e3).toISOString(), distance_meters: 963 },
          { kind: "post", id: "d2", excerpt: "「故宫里的数字格格」开放了，进去可以跟她学宫廷礼仪，她会纠正你的行礼姿势。", location_name: "东华门", location: { lat: 39.9131, lng: 116.4012 }, likes_count: 64, comments_count: 8, created_at: new Date(Date.now() - 86400e3 * 2).toISOString(), distance_meters: 1180 },
          { kind: "post", id: "d3", excerpt: "整理了一份故宫最佳拍照机位清单，附上开门和闭馆的时间规律。", location_name: "景山前街", location: { lat: 39.9251, lng: 116.3943 }, likes_count: 41, comments_count: 12, created_at: new Date(Date.now() - 86400e3 * 5).toISOString(), distance_meters: 1520 }
        ]
      };
    }
    if (kind === "attractions") {
      return {
        view: "attractions", place: "天安门", total: 4, count: 4,
        attractions: [
          { kind: "attraction", id: "a1", name: "中国国家博物馆", description: "世界上单体建筑面积最大的博物馆，位于天安门广场东侧。", attraction_type: "一级·北京·第二批", image_url: null, location: { lat: 39.9054, lng: 116.4013 }, distance_meters: 536 },
          { kind: "attraction", id: "a2", name: "国家大剧院", description: "由法国建筑师保罗·安德鲁设计，标志性的钛金属与玻璃穹顶。", attraction_type: "行业博物馆", image_url: null, location: { lat: 39.9033, lng: 116.3833 }, distance_meters: 807 }
        ],
        business_districts: [
          { kind: "attraction", id: "b1", name: "故宫博物院", description: null, attraction_type: "commercial", image_url: null, location: { lat: 39.9163, lng: 116.3972 }, distance_meters: 1079 },
          { kind: "attraction", id: "b2", name: "东城区", description: null, attraction_type: "commercial", image_url: null, location: { lat: 39.9157, lng: 116.3859 }, distance_meters: 1914 }
        ]
      };
    }
    if (kind === "campaigns") {
      return {
        view: "campaigns", total: 1, count: 1,
        campaigns: [
          { kind: "campaign", id: "c1", name: "北京百馆打卡计划", slug: "beijing-100-museums", description: "打卡北京 100 家博物馆与美术馆，集齐徽章，解锁城市文化成就。", theme_color: "#0F6E56", act_count: 100 }
        ]
      };
    }
    return {
      center: { lat: 39.9042, lng: 116.4074, radius_meters: 25000 },
      place: "北京 · 天安门（演示数据）",
      total: 4,
      digital_humans: [
        { id: "demo-1", name: "小白", description: "国家博物馆讲解员，带你云逛「古代中国」展厅，认文物如数家珍。", avatar_url: null, location_name: "中国国家博物馆", location: { lat: 39.9053, lng: 116.3976 }, distance_meters: 890, is_robot: true },
        { id: "demo-2", name: "格格", description: "紫禁城里的数字格格，最爱讲宫廷轶事，会带你去打卡故宫的隐藏角落。", avatar_url: null, location_name: "故宫博物院", location: { lat: 39.9163, lng: 116.3972 }, distance_meters: 1240, is_robot: true },
        { id: "demo-3", name: "胡同张大爷", description: "在南锣鼓巷住了四十年的数字大爷，聊鸽哨、豆汁儿和那些没拆的四合院。", avatar_url: null, location_name: "南锣鼓巷", location: { lat: 39.9371, lng: 116.4019 }, distance_meters: 3660, is_robot: true },
        { id: "demo-4", name: "环球影迷小威", description: "住在环球影城附近的影迷数字人，每日更新排队攻略和隐藏彩蛋。", avatar_url: null, location_name: "北京环球度假区", location: { lat: 39.8614, lng: 116.6845 }, distance_meters: 23400, is_robot: true }
      ]
    };
  }

  // ---------- 数据渲染（structuredContent -> DOM）----------
  function onData(params) {
    var sc = params && params.structuredContent;
    if (!sc || typeof sc !== "object") return;
    state.data = sc;
    renderView(sc);
  }

  function fmtDist(m) {
    if (m == null || isNaN(m)) return "";
    return m < 1000 ? (Math.round(m) + " 米") : ((m / 1000).toFixed(m < 10000 ? 1 : 0) + " 公里");
  }

  function subText(sc) {
    var view = sc && sc.view;
    if (view === "posts") {
      var kw = sc.keyword || "";
      return (kw ? "「" + kw + "」· " : "") + (sc.count || 0) + " 条公开帖子";
    }
    if (view === "attractions") {
      var where = sc.place || "";
      return (where ? where + " · " : "") + (sc.count || 0) + " 个景点与商圈";
    }
    if (view === "campaigns") {
      return (sc.count || 0) + " 个进行中的活动";
    }
    var c = sc.center || {};
    var place = sc.place || ((typeof c.lat === "number" && typeof c.lng === "number") ? (c.lat.toFixed(3) + ", " + c.lng.toFixed(3)) : "");
    var n = (sc.digital_humans || []).length;
    return (place ? place + " · " : "") + n + " 个公开数字人";
  }

  // ---------- v0.13.4：多形态卡片工厂 ----------
  // 服务端多个工具共用本模板，靠 structuredContent.view 分派；不认识（或缺
  // view 的旧数据）一律回退 renderDigitalHumans，保证现有链路零回归。
  function metaRow(items) {
    var meta = document.createElement("div");
    meta.className = "card-meta";
    items.forEach(function (it) {
      if (!it || !it.text) return;
      var s = document.createElement("span");
      s.className = it.cls ? "meta-item " + it.cls : "meta-item";
      if (it.icon) s.appendChild(icon(it.icon));
      var t = document.createElement("span");
      t.className = "meta-text";
      t.textContent = it.text;
      s.appendChild(t);
      meta.appendChild(s);
    });
    return meta;
  }

  function plainCard(o) {
    var c = document.createElement("button");
    c.className = "card";
    c.type = "button";
    if (o.avatarNode) c.appendChild(o.avatarNode);
    else {
      var av = document.createElement("div");
      av.className = "avatar avatar-" + (o.tone || "gray");
      av.textContent = o.glyph || "?";
      c.appendChild(av);
    }
    var body = document.createElement("div");
    body.className = "card-body";
    var nameRow = document.createElement("div");
    nameRow.className = "card-name-row";
    var nm = document.createElement("span");
    nm.className = o.titleClamp ? "card-name card-name-wrap" : "card-name";
    nm.textContent = o.title || "未命名";
    nameRow.appendChild(nm);
    if (o.badge) {
      var b = document.createElement("span");
      b.className = "badge";
      b.textContent = o.badge;
      nameRow.appendChild(b);
    }
    body.appendChild(nameRow);
    // v0.14.9：作者行（头像 + 昵称），仅帖子卡使用
    if (o.authorNode) body.appendChild(o.authorNode);
    if (o.desc) {
      var d = document.createElement("div");
      d.className = "card-desc";
      d.textContent = o.desc;
      body.appendChild(d);
    }
    if (o.meta && o.meta.length) body.appendChild(metaRow(o.meta));
    c.appendChild(body);
    if (o.onClick) c.addEventListener("click", o.onClick);
    return c;
  }

  function fmtWhen(iso) {
    if (!iso) return "";
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var d = Math.floor((Date.now() - t) / 1000);
    if (d < 60) return "刚刚";
    if (d < 3600) return Math.floor(d / 60) + " 分钟前";
    if (d < 86400) return Math.floor(d / 3600) + " 小时前";
    if (d < 86400 * 7) return Math.floor(d / 86400) + " 天前";
    var dt = new Date(t);
    return (dt.getMonth() + 1) + "月" + dt.getDate() + "日";
  }

  function mapLink(loc) {
    return function () {
      if (loc && typeof loc.lat === "number" && typeof loc.lng === "number") {
        openExternal(SITE_URL + "/map?lat=" + loc.lat + "&lng=" + loc.lng);
      } else {
        openExternal(SITE_URL + "/map");
      }
    };
  }

  // v0.14.9：作者行（帖子卡专用）。头像走 normAvatar（域名白名单已在服务端
  // 过滤过一道，这里再兜一层脏 URL）；无头像或加载失败 → 姓名首字圆块。
  function authorFallbackNode(name) {
    var d = document.createElement("div");
    d.className = "author-avatar author-avatar-fallback";
    d.textContent = initials(name);
    return d;
  }

  function authorLineNode(a) {
    if (!a || !a.display_name) return null;
    var row = document.createElement("div");
    row.className = "author-line";
    // v0.14.10：作者行可点 → 个人主页（profile_url）。
    // 卡片本身是 <button>，不能用 <a>/<button> 嵌套，故用 div + role=link
    // + stopPropagation，避免冒泡触发整卡的「打开帖子」跳转。
    if (a.profile_url) {
      row.className = "author-line author-link";
      row.setAttribute("role", "link");
      row.setAttribute("tabindex", "0");
      row.title = "查看主页";
      var goProfile = function (e) {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        openExternal(a.profile_url);
      };
      row.addEventListener("click", goProfile);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") goProfile(e);
      });
    }
    var url = normAvatar(a.avatar_url);
    if (url) {
      var img = document.createElement("img");
      img.className = "author-avatar";
      img.alt = "";
      img.loading = "lazy";
      img.src = url;
      img.onerror = function () {
        if (img.parentNode) img.parentNode.replaceChild(authorFallbackNode(a.display_name), img);
      };
      row.appendChild(img);
    } else {
      row.appendChild(authorFallbackNode(a.display_name));
    }
    var nm = document.createElement("span");
    nm.className = "author-name";
    nm.textContent = "@" + a.display_name;
    row.appendChild(nm);
    return row;
  }

  function postCardNode(p) {
    // 帖子没有标题字段，body.content 就是正文。故不造「公开帖子」这种占位标题
    // （20 张同名卡片无法区分），而是让摘要当主角：首行取摘要开头作标题行。
    var ex = p.excerpt || "（无正文）";
    var head = ex.length > 22 ? ex.slice(0, 22).trim() + "…" : ex;
    var rest = ex.length > 22 ? ex.slice(22).trim() : "";
    // v0.14.3：帖子头图缩略。image_url 为 Supabase Storage 公开桶绝对地址
    // （附近公开帖 94% 有图）。无图或加载失败 → 回退「帖」字渐变圆块，
    // 与 v0.13.x 无图时期视觉一致（onerror replaceChild，同 attractionCardNode）。
    var avatarNode = null;
    var imgUrl = normAvatar(p.image_url);
    if (imgUrl) {
      avatarNode = document.createElement("img");
      avatarNode.className = "thumb";
      avatarNode.alt = "";
      avatarNode.loading = "lazy";
      avatarNode.src = imgUrl;
      avatarNode.onerror = function () {
        var d = document.createElement("div");
        d.className = "avatar avatar-blue";
        d.textContent = "帖";
        if (avatarNode.parentNode) avatarNode.parentNode.replaceChild(d, avatarNode);
      };
    }
    return plainCard({
      avatarNode: avatarNode,
      title: head,
      titleClamp: true,
      badge: "帖子",
      tone: "blue",
      glyph: "帖",
      // v0.14.9：作者头像 + 昵称
      authorNode: authorLineNode(p.author),
      desc: rest || null,
      meta: [
        p.location_name ? { icon: ICONS.pin, text: p.location_name } : null,
        { icon: ICONS.heart, text: p.likes_count + " 赞" },
        p.comments_count ? { icon: ICONS.message, text: p.comments_count + " 评论" } : null,
        p.created_at ? { text: fmtWhen(p.created_at) } : null
      ],
      // v0.13.5：点帖子跳详情页（/posts/{id} 是公开路由，在 paywall 白名单里），
      // 而非地图深链 —— 用户点帖子的意图是「读这篇内容」，不是「看它在哪儿」。
      // 无 id 时退回地图。
      onClick: p.post_url
        ? function () { openExternal(p.post_url); }
        : mapLink(p.location),
    });
  }

  function attractionCardNode(a, isDistrict) {
    var av = null;
    if (a.image_url) {
      var norm = normAvatar(a.image_url);
      if (norm) {
        var img = document.createElement("img");
        img.className = "avatar avatar-img";
        img.alt = "";
        img.loading = "lazy";
        img.src = norm;
        img.onerror = function () {
          var d = document.createElement("div");
          d.className = "avatar avatar-green";
          d.textContent = initials(a.name);
          if (img.parentNode) img.parentNode.replaceChild(d, img);
        };
        av = img;
      }
    }
    // v0.13.4：商圈名是上游 POI 地址且质量参差（实测有「北京市东城区…中学」
    // 这种整段地址），超长时收敛显示，完整名仍留给模型。
    var shownName = a.name || (isDistrict ? "未命名商圈" : "未命名景点");
    var longName = shownName.length > 14;
    return plainCard({
      title: longName ? shownName.slice(0, 14) + "…" : shownName,
      badge: isDistrict ? "商圈" : "景点",
      avatarNode: av,
      tone: "green",
      glyph: initials(a.name),
      desc: a.description || null,
      meta: [{ icon: ICONS.pin, text: isDistrict ? "商圈" : (a.attraction_type || "景点") }, { icon: ICONS.target, text: fmtDist(a.distance_meters), cls: "dist" }],
      onClick: mapLink(a.location),
    });
  }

  function campaignCardNode(c) {
    return plainCard({
      title: c.name || "未命名活动",
      badge: "活动",
      tone: "red",
      glyph: initials(c.name),
      desc: c.description || null,
      meta: [
        { icon: ICONS.book, text: c.act_count ? c.act_count + " 个打卡点" : "暂无打卡点" },
        c.slug ? { icon: ICONS.external, text: "/" + c.slug } : null
      ],
      onClick: function () { openExternal(SITE_URL + "/campaign/" + (c.slug || "")); },
    });
  }

  // v0.14.11：卡片节点保留源数据引用，供地图点选时反向定位到列表项
  // （不用 id 匹配：四类卡片的 id 字段名不统一，直接挂对象最稳）
  function appendCard(wrap, node, item) {
    node.__ppItem = item;
    wrap.appendChild(node);
  }

  function buildCards(wrap, view, sc) {
    if (view === "posts") {
      var ps = sc.posts || [];
      ps.forEach(function (p) { appendCard(wrap, postCardNode(p), p); });
      return ps.length;
    }
    if (view === "attractions") {
      var n = 0;
      (sc.attractions || []).forEach(function (a) { appendCard(wrap, attractionCardNode(a, false), a); n++; });
      (sc.business_districts || []).forEach(function (a) { appendCard(wrap, attractionCardNode(a, true), a); n++; });
      return n;
    }
    if (view === "campaigns") {
      var cs = sc.campaigns || [];
      cs.forEach(function (c) { appendCard(wrap, campaignCardNode(c), c); });
      return cs.length;
    }
    return -1; // 未知形态
  }

  function emptyNode(title, hint) {
    var emp = el("empty");
    emp.hidden = false;
    emp.replaceChildren();
    emp.appendChild(icon(ICONS.pin));
    var t1 = document.createElement("div");
    t1.textContent = title;
    emp.appendChild(t1);
    if (hint) {
      var t2 = document.createElement("div");
      t2.style.fontSize = "12px";
      t2.style.marginTop = "2px";
      t2.textContent = hint;
      emp.appendChild(t2);
    }
    return emp;
  }

  function renderView(sc) {
    el("loading").hidden = true;
    el("sub").textContent = subText(sc);
    var wrap = el("cards");
    wrap.replaceChildren();
    el("empty").hidden = true;

    var view = sc && sc.view;
    var shown = -1;
    if (view) {
      shown = buildCards(wrap, view, sc);
      if (shown >= 0) {
        wrap.hidden = shown === 0;
        if (shown === 0) {
          var hint = view === "posts" ? "换个关键词试试" : (view === "campaigns" ? "目前还没有已发布的活动" : "换个地点或放大半径试试");
          emptyNode(view === "campaigns" ? "暂时没有已发布的活动" : "这里还没有可展示的内容", hint);
        }
        markScrollable(wrap);
        refreshMap(); // v0.14.11
        return;
      }
    }

    // 回退：旧的数字人列表形态（find_nearby，且不带 view 字段）
    wrap.hidden = true;
    var list = ((sc && sc.digital_humans) || []).slice(0, 20);
    if (!list.length) {
      emptyNode("这附近还没有公开的数字人", "换个地方试试，或到地图上探索");
      refreshMap(); // v0.14.11
      return;
    }
    list.forEach(function (dh) { appendCard(wrap, cardNode(dh), dh); });
    wrap.hidden = false;
    markScrollable(wrap);
    refreshMap(); // v0.14.11
  }

  // v0.13.5：内容超出 max-height 才给滚动区加底部留白，避免 .menu（absolute 的 80px
  // FAB）遮住末尾卡片；同时列表不滚动时零多余空白（v0.13.3 白块问题的正解）。
  // 宿主调整窗口宽度后需要重算，故绑定 resize。
  function markScrollable(wrap) {
    wrap.classList.remove("is-scrollable");
    // 强制回流后才能读到真实 scrollHeight
    void wrap.offsetHeight;
    if (wrap.scrollHeight > wrap.clientHeight + 1) wrap.classList.add("is-scrollable");
  }

  // 头像归一化：相对路径补站点前缀；协议相对补 https；加载失败回退首字母圆形
  function normAvatar(url) {
    if (!url || typeof url !== "string") return null;
    if (url.indexOf("//") === 0) return "https:" + url;
    if (url.charAt(0) === "/") return SITE_URL + url;
    return url;
  }

  function initials(name) {
    var s = (name || "").trim();
    return s ? s.charAt(0).toUpperCase() : "?";
  }

  function avatarNode(dh) {
    var url = normAvatar(dh.avatar_url);
    if (url) {
      var img = document.createElement("img");
      img.className = "avatar";
      img.alt = "";
      img.loading = "lazy";
      img.src = url;
      img.onerror = function () {
        var d = document.createElement("div");
        d.className = "avatar";
        d.textContent = initials(dh.name);
        if (img.parentNode) img.parentNode.replaceChild(d, img);
      };
      return img;
    }
    var d = document.createElement("div");
    d.className = "avatar";
    d.textContent = initials(dh.name);
    return d;
  }

  function cardNode(dh) {
    var c = document.createElement("button");
    c.className = "card";
    c.type = "button";
    c.appendChild(avatarNode(dh));
    var body = document.createElement("div");
    body.className = "card-body";
    var nameRow = document.createElement("div");
    nameRow.className = "card-name-row";
    var nm = document.createElement("span");
    nm.className = "card-name";
    nm.textContent = dh.name || "未知数字人";
    nameRow.appendChild(nm);
    if (dh.is_robot) {
      var b = document.createElement("span");
      b.className = "badge";
      b.textContent = "AI";
      nameRow.appendChild(b);
    }
    body.appendChild(nameRow);
    if (dh.description) {
      var d = document.createElement("div");
      d.className = "card-desc";
      d.textContent = dh.description;
      body.appendChild(d);
    }
    var meta = document.createElement("div");
    meta.className = "card-meta";
    if (dh.location_name) {
      var li = document.createElement("span");
      li.className = "meta-item";
      li.appendChild(icon(ICONS.pin));
      var lt = document.createElement("span");
      lt.className = "meta-text";
      lt.textContent = dh.location_name;
      li.appendChild(lt);
      meta.appendChild(li);
    }
    var dist = fmtDist(dh.distance_meters);
    if (dist) {
      var ds = document.createElement("span");
      ds.className = "dist";
      ds.textContent = dist;
      meta.appendChild(ds);
    }
    // v0.13.5：卡片现在是「点进去聊天」，加一个显式 affordance，
    // 否则用户会以为点开只是看地图（旧行为）。
    // v0.14.8：补次级入口「资料」——整卡点击仍=聊天（主 CTA），资料是次级 CTA。
    // 依据 concepts-ui-guidelines.md:63/77「单卡最多两个动作，1 主 + 1 次」，
    // 与 :101/107「列表项尽量只给一个明确 CTA」并不冲突（次级是可选项）。
    // 结构注意：.card 本身是 <button>，按钮内不能再嵌 <button>，故次级动作用
    // <span> + stopPropagation，避免冒泡触发整卡的聊天跳转。
    if (dh.chat_url || dh.detail_url) {
      var acts = document.createElement("div");
      acts.className = "card-actions";
      if (dh.detail_url) {
        var da = document.createElement("span");
        da.className = "meta-item detail-affordance";
        da.appendChild(icon(ICONS.external));
        var dt = document.createElement("span");
        dt.className = "meta-text";
        dt.textContent = "资料";
        da.appendChild(dt);
        da.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          openExternal(dh.detail_url);
        });
        acts.appendChild(da);
      }
      if (dh.chat_url) {
        var ca = document.createElement("span");
        ca.className = "meta-item chat-affordance";
        ca.appendChild(icon(ICONS.message));
        var ct = document.createElement("span");
        ct.className = "meta-text";
        ct.textContent = "聊一聊";
        ca.appendChild(ct);
        acts.appendChild(ca);
      }
      meta.appendChild(acts);
    }
    body.appendChild(meta);
    c.appendChild(body);
    // 卡片点击 -> 进入与该数字人的对话（地图深链）
    // v0.14.6：由 /chat?digital_human_id= 改为 /map?type=&id=&lat=&lng= ——
    // /chat 页对原生数字人组件错配（只渲染 OpenClaw 聊天窗，原生发消息必 400），
    // 地图深链复用页面分享机制：打开即定位 + 弹聊天窗，openclaw 机器人还会
    // 按 dh.type 自动分派对应聊天组件。
    // /map 属(app) 组、受付费墙保护 —— 未订阅用户会看到订阅页，这是既有设计，
    // 不是本组件能绕过的（闸门在 PowPow 服务端）。
    c.addEventListener("click", function () {
      var target = dh.chat_url;
      if (target) {
        openExternal(target);
        return;
      }
      var loc = dh.location || {};
      if (typeof loc.lat === "number" && typeof loc.lng === "number") {
        openExternal(SITE_URL + "/map?lat=" + loc.lat + "&lng=" + loc.lng);
      } else {
        openExternal(SITE_URL + "/map");
      }
    });
    return c;
  }

  // ---------- 外链 / 全屏 ----------
  // v0.13.12：优先级倒置——标准桥 RPC 优先，window.openai 降级为 ChatGPT 宿主兜底。
  // 依据 Intelligent UI 开发指南「渐进式增强：优先使用 MCP Apps 标准桥接方法，
  // 仅在需要 ChatGPT 特定能力时使用 window.openai」；ext-apps 2.0.3 中
  // ui/open-link（OPEN_LINK_METHOD）与 ui/request-display-mode
  // （REQUEST_DISPLAY_MODE_METHOD）均为官方标准方法，且官方示例 widget
  // （mcp_app_basics_node）只用标准桥、不碰 window.openai。
  // 目标域白名单在资源 _meta["openai/widgetCSP"].redirect_domains 声明
  // （v0.13.11 加回）。两者皆无（本地 dev 预览）则仅记录不导航。
  // v0.5.x 曾用「原生开新窗口」兜底（疑似连接器扫描杀手），已全部移除。
  function openExternal(url) {
    if (hostCaps && hostCaps.openLinks) {
      rpcRequest("ui/open-link", { url: url }, 2500)
        .then(function (r) { if (r && r.isError) windowOpenaiFallback(url); })
        .catch(function () { windowOpenaiFallback(url); });
      return;
    }
    windowOpenaiFallback(url);
  }
  function windowOpenaiFallback(url) {
    var oa = window.openai;
    if (oa && typeof oa.openExternal === "function") {
      try { oa.openExternal({ href: url }); return; } catch (e) { /* 落入 devNoNav */ }
    }
    devNoNav(url);
  }
  function devNoNav(url) {
    try { console.log("[powpow-widget] 无宿主，外链已停用:", url); } catch (e) { /* 忽略 */ }
  }

  function updateFullBtn() {
    var btn = el("btn-full");
    btn.replaceChildren();
    btn.appendChild(icon(state.fullscreen ? ICONS.shrink : ICONS.expand));
    btn.title = state.fullscreen ? "退出全屏" : "全屏查看";
  }

  function setFullscreen(on) {
    state.fullscreen = on;
    // v0.7.0：类挂到 widget 根（fragment 语义；旧代码挂 document.body 会污染宿主）
    el("app").classList.toggle("is-fullscreen", on);
    el("app").classList.toggle("dev-fullscreen", on && state.dev);
    updateFullBtn();
    // v0.14.12：两种形态都带地图，切换后一律重算（容器尺寸变了 →
    // invalidateSize + 重新 fitBounds；mstate 复用，不会二次 L.map）。
    refreshMap();
  }

  el("btn-full").addEventListener("click", function () {
    var next = state.fullscreen ? "inline" : "fullscreen";
    // v0.13.12：同 openExternal——标准桥 ui/request-display-mode 优先
    // （ext-apps 2.0.3 REQUEST_DISPLAY_MODE_METHOD，官方标准方法），
    // window.openai.requestDisplayMode 降级为 ChatGPT 宿主兜底。
    rpcRequest("ui/request-display-mode", { mode: next }, 2000)
      .then(function (r) { setFullscreen(((r && r.mode) || next) === "fullscreen"); })
      .catch(function () { windowOpenaiDisplayMode(next); });
  });
  function windowOpenaiDisplayMode(next) {
    var oa = window.openai;
    if (oa && typeof oa.requestDisplayMode === "function") {
      try {
        oa.requestDisplayMode({ mode: next });
        setFullscreen(next === "fullscreen");
        return;
      } catch (e) { /* 落入 dev 分支 */ }
    }
    if (state.dev) { setFullscreen(next === "fullscreen"); }
  }

  el("btn-open").addEventListener("click", function () {
    var sc = state.data;
    var url = SITE_URL + "/map";
    if (sc && sc.center && typeof sc.center.lat === "number" && typeof sc.center.lng === "number") {
      url = SITE_URL + "/map?lat=" + sc.center.lat + "&lng=" + sc.center.lng;
    }
    openExternal(url);
  });

  // ---------- 放射形菜单（复刻站点 LeftBottomMenu）----------
  // 扇形：半径 110px，起始角 73°，每项 -30°（i=0..4），y 轴向上为负
  function fanPos(i) {
    var ang = (73 - 30 * i) * Math.PI / 180;
    return { x: Math.round(110 * Math.cos(ang)), y: Math.round(-110 * Math.sin(ang)) };
  }
  function itemTransform(i, scale) {
    var p = fanPos(i);
    return "translate(calc(-50% + " + p.x + "px), calc(-50% + " + p.y + "px)) scale(" + scale + ")";
  }
  function toggleMenu(force) {
    var open = (force === undefined) ? !state.menuOpen : force;
    state.menuOpen = open;
    el("menu").classList.toggle("open", open);
    el("menu-overlay").classList.toggle("show", open);
    menuEls.forEach(function (it, i) {
      if (open) {
        it.style.transitionDelay = (i * 50) + "ms";
        it.style.transform = itemTransform(i, 1);
        it.style.opacity = "1";
        it.style.pointerEvents = "auto";
      } else {
        it.style.transitionDelay = "0ms";
        it.style.transform = "translate(-50%, -50%) scale(0.5)";
        it.style.opacity = "0";
        it.style.pointerEvents = "none";
      }
    });
  }
  function buildMenu() {
    var menu = el("menu");
    MENU_ITEMS.forEach(function (m, i) {
      var b = document.createElement("button");
      b.className = "menu-item";
      b.type = "button";
      b.title = m.label;
      b.setAttribute("aria-label", m.label);
      b.appendChild(icon(m.icon));
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleMenu(false);
        openExternal(SITE_URL + m.path);
      });
      b.addEventListener("mouseenter", function () {
        if (state.menuOpen) b.style.transform = itemTransform(i, 1.1);
      });
      b.addEventListener("mouseleave", function () {
        if (state.menuOpen) b.style.transform = itemTransform(i, 1);
      });
      menu.appendChild(b);
      menuEls.push(b);
    });
  }
  el("menu-btn").addEventListener("click", function () { toggleMenu(); });
  el("menu-overlay").addEventListener("click", function () { toggleMenu(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.menuOpen) toggleMenu(false);
  });

  // ---------- v0.14.11：全屏地图 ----------
  // 数据来自同一次 find_nearby / search_posts 结果（state.data），不新增工具调用。
  // 瓦片：OSM 官方唯一域名（Tile Usage Policy 要求 use exactly，CSP 已声明该域）。
  // 聚类：照搬站点 /api/map 的「zoom → 物理半径」表 + 「3 单点 + 1 聚合」部分展开。
  // 坐标系：库里是 GCJ-02 / WGS-84 混合且无 CRS 标记，本版与网页版一致——直接画，
  //   不做转换（转换会把本来正确的部分转偏；换 GCJ 瓦片则属未授权接口）。约 500m
  //   偏移是既有状态，不是本版引入。
  var TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var TILE_ATTR = "© OpenStreetMap contributors";
  var MAP_MAX_ZOOM = 19;
  var mstate = { map: null, group: null, items: [], alive: false, failed: false };

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function locOf(o) {
    var l = o && o.location;
    if (!l) return null;
    var lat = Number(l.lat), lng = Number(l.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (lat === 0 && lng === 0) return null;
    return { lat: lat, lng: lng };
  }

  // 收集所有带有效坐标的条目（四类视图共用一份结构）
  function collectMapItems(sc) {
    var out = [];
    function add(arr, kind) {
      (arr || []).forEach(function (o) {
        var ll = locOf(o);
        if (ll) out.push({ o: o, kind: kind, ll: ll });
      });
    }
    if (!sc) return out;
    add(sc.digital_humans, "dh");
    add(sc.users, "user");
    add(sc.posts, "post");
    add(sc.attractions, "attr");
    add(sc.business_districts, "district");
    add(sc.campaigns, "campaign");
    return out;
  }

  function labelOf(it) {
    var o = it.o || {};
    if (it.kind === "post") {
      var s = (o.content || "").replace(/\s+/g, " ").trim();
      return s ? (s.length > 40 ? s.slice(0, 40) + "…" : s) : "一条泡泡";
    }
    return o.name || o.display_name || "未命名";
  }

  function linkOf(it) {
    var o = it.o || {};
    if (o.chat_url) return o.chat_url;
    if (o.post_url) return o.post_url;
    if (o.detail_url) return o.detail_url;
    if (o.profile_url) return o.profile_url;
    if (it.ll) return SITE_URL + "/map?lat=" + it.ll.lat + "&lng=" + it.ll.lng;
    return SITE_URL + "/map";
  }

  function metersBetween(a, b) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var la1 = a.lat * r, la2 = b.lat * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // 与站点 calculateClusterRadius 同表（route.ts:536）
  function clusterRadiusKm(z) {
    if (z >= 18) return 0.02;
    if (z >= 16) return 0.05;
    if (z >= 14) return 0.1;
    if (z >= 12) return 0.5;
    if (z >= 10) return 1;
    if (z >= 8) return 5;
    if (z >= 6) return 50;
    if (z >= 4) return 200;
    return 800;
  }

  // 与站点 clusterMarkers 同构：贪心、以「种子点」为圆心（簇半径不漂移）、非传递闭包。
  // 刻意不复刻两个缺陷：簇 id 用 Date.now()（此处不需要 id）、顺序不稳定。
  function clusterPoints(list, radiusKm, zoom) {
    var out = [];
    if (!list.length) return out;
    if (zoom >= 17) {
      list.forEach(function (x) { out.push({ one: x }); });
      return out;
    }
    var used = [], groups = [], i, j;
    var radius = radiusKm * 1000;
    for (i = 0; i < list.length; i++) {
      if (used[i]) { continue; }
      used[i] = true;
      var seed = list[i], g = [seed];
      for (j = i + 1; j < list.length; j++) {
        if (used[j]) { continue; }
        if (metersBetween(seed.ll, list[j].ll) < radius) { g.push(list[j]); used[j] = true; }
      }
      groups.push(g);
    }
    groups.forEach(function (g) {
      if (g.length === 1) { out.push({ one: g[0] }); return; }
      // 站点同款部分展开：zoom>=15 且 <=10 个成员时，留 3 个单点 + 1 个聚合
      if (zoom >= 15 && g.length <= 10) {
        g.slice(0, 3).forEach(function (x) { out.push({ one: x }); });
        if (g.length > 3) { out.push({ many: g.slice(3) }); }
      } else {
        out.push({ many: g });
      }
    });
    return out;
  }

  function centerOf(g) {
    var lat = 0, lng = 0;
    g.forEach(function (x) { lat += x.ll.lat; lng += x.ll.lng; });
    return { lat: lat / g.length, lng: lng / g.length };
  }

  function pinIcon(it) {
    var o = it.o || {};
    var url = normAvatar(o.avatar_url || (it.kind === "post" ? o.image_url : null));
    var inner;
    if (url) {
      inner = '<img src="' + escHtml(url) + '" alt="">';
    } else {
      inner = escHtml(initials(labelOf(it)));
    }
    return window.L.divIcon({
      className: "",
      html: '<div class="mp">' + inner + "</div>",
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -22]
    });
  }

  function popupHtml(it) {
    var o = it.o || {};
    var url = normAvatar(o.avatar_url || (it.kind === "post" ? o.image_url : null));
    var head = url
      ? '<img class="mpop-av" src="' + escHtml(url) + '" alt="">'
      : '<div class="mpop-av">' + escHtml(initials(labelOf(it))) + "</div>";
    var meta = [];
    if (o.location_name) { meta.push(escHtml(o.location_name)); }
    var d = fmtDist(o.distance_meters);
    if (d) { meta.push(escHtml(d)); }
    var go = it.kind === "dh" || it.kind === "user" ? "聊一聊" : "查看";
    return '<div class="mpop">' + head +
      '<div class="mpop-b"><div class="mpop-n">' + escHtml(labelOf(it)) + "</div>" +
      (meta.length ? '<div class="mpop-m">' + meta.join(" · ") + "</div>" : "") +
      '<span class="mpop-a" data-url="' + escHtml(linkOf(it)) + '">' + go +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>' +
      "</span></div></div>";
  }

  // 点标记 → 把左侧列表滚到对应卡片（列表项的 __ppItem 在 renderView 里挂上）
  function scrollToCard(obj) {
    var nodes = el("cards").querySelectorAll(".card");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__ppItem === obj) {
        var node = nodes[i];
        try { node.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) { node.scrollIntoView(); }
        node.classList.add("card-hit");
        setTimeout(function () { node.classList.remove("card-hit"); }, 1200);
        return;
      }
    }
  }

  function markerFor(it) {
    var m = window.L.marker([it.ll.lat, it.ll.lng], { icon: pinIcon(it), title: labelOf(it) });
    m.bindPopup(popupHtml(it), { closeButton: false, minWidth: 196, maxWidth: 220, offset: [0, 2] });
    m.on("click", function () { scrollToCard(it.o); });
    m.on("popupopen", function (e) {
      var root = e.popup && e.popup.getElement();
      var btn = root && root.querySelector(".mpop-a");
      if (!btn) { return; }
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var url = btn.getAttribute("data-url");
        if (url) { openExternal(url); }
      });
    });
    return m;
  }

  function clusterMarker(g) {
    var c = centerOf(g);
    var ic = window.L.divIcon({
      className: "",
      html: '<div class="mc">' + g.length + "</div>",
      iconSize: [36, 34],
      iconAnchor: [18, 17]
    });
    var m = window.L.marker([c.lat, c.lng], { icon: ic, title: g.length + " 个" });
    m.on("click", function () {
      // 与站点一致：点聚合逐级散开
      var z = Math.min(mstate.map.getZoom() + 2, MAP_MAX_ZOOM);
      mstate.map.setView([c.lat, c.lng], z);
      drawMarkers();
    });
    return m;
  }

  function drawMarkers() {
    if (!mstate.alive) { return; }
    var z = mstate.map.getZoom();
    mstate.group.clearLayers();
    var groups = clusterPoints(mstate.items, clusterRadiusKm(z), z);
    groups.forEach(function (g) {
      if (g.one) {
        mstate.group.addLayer(markerFor(g.one));
      } else {
        mstate.group.addLayer(clusterMarker(g.many));
      }
    });
  }

  function mapUnavailable() {
    mstate.failed = true;
    if (el("split")) { el("split").classList.add("no-map"); }
  }

  function ensureMap() {
    if (mstate.alive) { return true; }
    if (!window.L || typeof window.L.map !== "function") { return false; }
    var box = el("map");
    if (!box) { return false; }
    try {
      mstate.map = window.L.map(box, {
        zoomControl: true,
        attributionControl: true,
        minZoom: 3,
        maxZoom: MAP_MAX_ZOOM,
        worldCopyJump: true
      });
      // 去掉 Leaflet 默认的「Leaflet」前缀：CIS 只允许红白灰且署名只应指向数据来源，
      // 地图右下角只保留 OSM 署名（政策要求「clearly on the map」）。
      if (mstate.map.attributionControl && mstate.map.attributionControl.setPrefix) {
        mstate.map.attributionControl.setPrefix(false);
      }
      // OSM 政策：必须显示署名；单一域名、不带 {s} 子域；不绕过缓存（不加缓存破坏参数）
      window.L.tileLayer(TILE_URL, {
        maxZoom: MAP_MAX_ZOOM,
        attribution: TILE_ATTR
      }).addTo(mstate.map);
      mstate.group = window.L.layerGroup().addTo(mstate.map);
      mstate.map.on("zoomend", drawMarkers);
      mstate.alive = true;
      return true;
    } catch (e) {
      mstate.map = null;
      mstate.alive = false;
      return false;
    }
  }

  function refreshMap() {
    mstate.items = collectMapItems(state.data);
    // 本地 dev 预览用（?demo= / 无宿主时 state.dev 为 true），线上不暴露
    if (state.dev) {
      window.__ppMap = mstate;
      window.__ppMapItems = function () {
        return mstate.items.map(function (x) { return labelOf(x) + "@" + x.ll.lat + "," + x.ll.lng; });
      };
    }
    // v0.14.12：inline 也建图（此前「state.fullscreen 为 false 时直接 return」
    // 导致对话里只有卡片）。形态切换由 setFullscreen → refreshMap 触发，
    // 靠 invalidateSize 重新量尺寸，同一份 mstate 复用，不重复建图。
    if (!mstate.items.length) { mapUnavailable(); return; }
    if (!ensureMap()) { mapUnavailable(); return; }
    el("split").classList.remove("no-map");
    // 关键：setFullscreen 刚切换 class，此刻布局尚未回流，容器尺寸仍是 0。
    // 若同步 fitBounds，Leaflet 会按 0×0 算缩放 → 直接顶到 maxZoom（实测复现：
    // 6 个点被放大到相互重叠）。放到下一帧，等尺寸就绪后再 invalidateSize + 定视野。
    requestAnimationFrame(function () {
      if (!mstate.alive) { return; }
      mstate.map.invalidateSize();
      drawMarkers();
      var pts = mstate.items.map(function (x) { return [x.ll.lat, x.ll.lng]; });
      var c = state.data && state.data.center;
      if (c && typeof c.lat === "number" && typeof c.lng === "number") { pts.push([c.lat, c.lng]); }
      try {
        if (pts.length === 1) {
          mstate.map.setView(pts[0], 15);
        } else {
          mstate.map.fitBounds(window.L.latLngBounds(pts), { padding: [30, 30], maxZoom: 15 });
        }
      } catch (e) {
        mstate.map.setView(pts[0] || [39.9042, 116.4074], 13);
      }
    });
  }

  // ---------- 启动 ----------
  buildMenu();
  updateFullBtn();
  initBridge();
  // v0.13.5：宿主调整组件宽度时 max-height:400px 的溢出状态会变，重算 FAB 留白。
  var raf = 0;
  window.addEventListener("resize", function () {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function () {
      raf = 0;
      markScrollable(el("cards"));
      // v0.14.11：地图容器尺寸变了必须重算，否则瓦片错位/留白
      if (mstate.alive) { mstate.map.invalidateSize(); }
    });
  });
  var demoParam = new URLSearchParams(window.location.search).get("demo");
  if (demoParam) {
    state.dev = true;
    renderView(demoData(demoParam === "1" ? undefined : demoParam));
  }
  setTimeout(function () {
    if (!state.data && !state.dev) {
      el("loading").hidden = true;
      var emp = el("empty");
      emp.hidden = false;
      emp.textContent = "暂无数据";
    }
  }, 8000);
})();
</script>
</body>
</html>`;

// 注入 Leaflet（用函数式 replacer：避免字符串里的 $& / $' 被当作替换模式）。
// 占位符若未命中（例如模板被改坏），对应的 <style>/<script> 为空块，不影响其余功能，
// 此时 widget 内的 window.L 不存在 → refreshMap 走 mapUnavailable()，退回单列卡片。
export const WIDGET_HTML = WIDGET_HTML_RAW
  .replace('/*__LEAFLET_CSS__*/', () => LEAFLET_CSS)
  .replace('/*__LEAFLET_JS__*/', () => LEAFLET_JS);
