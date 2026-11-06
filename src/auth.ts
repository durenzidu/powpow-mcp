// ============================================================
// OAuth 2.1 资源服务器侧（PowPow 作为 protected resource）
//
// 本文件只负责「客户端 → PowPow」这一段，即 MCP 授权规范的 Resource Server 角色。
// 授权服务器（Authorization Server）用 Supabase Auth 的 OAuth 2.1 server
// （项目里已用 Management API 脚本开启，见 mcp_request_logs 同批记录）。
//
// 为什么不自己写授权服务器（2026-10-13 实测后的决策）：
//  - SDK v2 已自带元数据与 401 challenge 的全部实现，见下方 import。
//  - Supabase discovery 实测字段全部满足 ChatGPT 要求（token_endpoint_auth
//    _methods_supported 含 none、code_challenge 含 S256、有 registration_endpoint）。
//  - 自己写要额外实现 CIMD/DCR，而 CIMD 是否被 ChatGPT 选中至今无法在无梯子
//    环境实测；Supabase 走 DCR 是确定可用的路径。
//
// 隔离：MCP_OAUTH 开关（默认关）。关掉时本文件的所有路由都不存在、
// 门禁不生效，对现有 8 个只读工具零影响。灰度/回滚只需改 secret。
//
// ------------------------------------------------------------
// v0.14.2 适配记录（2026-10-17，相对 backup 分支 v0.14.1 的变更）：
//  ① resource/metadata URL 动态推导：v0.14.1 硬编码对外宣称 Supabase 直连地址，
//     用户在 ChatGPT 填的却是 global.powpow.online/api/mcp（Vercel 反代）。
//     现按 X-Forwarded-Host 动态推导外部入口，Vercel 入口下 metadata/challenge
//     全程留在我们域名（SIWC 批复后 consent 页同域也更顺）；头缺失时回退
//     Supabase 直连地址（v0.14.1 实证可用路径）。
//  ② parseBearer「只解析不验签」的欠账已还：verifyAccessToken 用 JWKS
//     （ES256）真验签 + iss/exp 校验。aud 宽容不强校验——Supabase OAuth
//     token 的 aud 形态（是否回写 resource 参数）未实测确认，强校验可能
//     误杀；claims 全量进审计日志，形态确认后再收紧。
//  ③ 新增 authenticate()：token sub（auth.users.id）→ 查 auth_users_link
//     桥接表 → PowPow users.id。service-role 查询（RLS 全开 + users 表
//     forced 的现实下，「用户 token + RLS」路线不可行——PowPow 用户本身
//     不在 Supabase Auth 里，这是 v0.14.1 已实证的结论）。
//  ④ 401 门禁（requireBearerAuth）：MCP_OAUTH=true 时，非 metadata 路由的
//     MCP 请求无有效 token 一律 401 + WWW-Authenticate。这是「应用内登录」
//     的触发机制——用户添加连接器即走 OAuth（= 登录 PowPow），授权后恢复。
//     代价：现有匿名形态的连接器首次调用会收 401 并触发授权流（设计意图）。
//  ⑤ 不恢复 v0.14.0 的 securitySchemes 声明：该字段是 v0.13.6 ChatGPT
//     创建校验失败的并列嫌疑（v0.13.10-13.12 全程无它且创建通过）。
//     连接器级授权走 401 路径已够；工具级 linking UI（三半机制）待
//     OAuth 全流程跑通后单变量增量验证再加。
// ============================================================

import {
  buildOAuthProtectedResourceMetadata,
  bearerAuthChallengeResponse,
  OAuthError,
  OAuthErrorCode,
} from 'npm:@modelcontextprotocol/server@^2.0.0';
import { createRemoteJWKSet, jwtVerify } from 'npm:jose@^6.2.3';
import { createClient } from 'npm:@supabase/supabase-js@2';

const PROJECT_REF = 'xhahsqbaohraqrdhtvay.supabase.co';
const FN_SLUG = 'mcp-server';

// 授权服务器 = Supabase Auth 的 OAuth 2.1 server。
// 实测 discovery（2026-10-13）：
//   issuer                = https://<ref>.supabase.co/auth/v1
//   authorization_endpoint= .../auth/v1/oauth/authorize
//   token_endpoint        = .../auth/v1/oauth/token
//   registration_endpoint = .../auth/v1/oauth/clients/register
//   token_endpoint_auth_methods_supported = [client_secret_basic, client_secret_post, none]← 含 none ✅
//   code_challenge_methods_supported      = [S256, plain]                              ← 含 S256 ✅
export const AUTH_SERVER_URL = `https://${PROJECT_REF}/auth/v1`;
export const ISSUER = AUTH_SERVER_URL;

// JWKS（ES256 公钥集）。createRemoteJWKSet 自带缓存 + cooldown，
// Edge Runtime 内按实例缓存，避免每请求拉取。
const JWKS = createRemoteJWKSet(new URL(`${AUTH_SERVER_URL}/.well-known/jwks.json`));

// 数据面：平台注入的 SUPABASE_URL 是内网地址（kong），可直连查表。
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// 我们申请的 scope。Supabase 只认它自己那组（openid/profile/email/phone/offline_access），
// 自定义 scope（如 posts:write）不会被它接受，所以先只用标准 scope；
// 「发帖权限」这类业务授权留给资源服务器侧按 token 里的 user_id 判定。
export const SCOPES_SUPPORTED = ['openid', 'profile', 'email'];

export const MCP_OAUTH_ENABLED =
  (Deno.env.get('MCP_OAUTH') ?? '').toLowerCase() === 'true';

// 对外宣称的外部入口 origin（v0.14.2 secret 方案，见下面 externalOrigin 注释）。
// 空 → 走 X-Forwarded-Host 兜底 → 再回退 Supabase 直连地址。
const MCP_EXTERNAL_ORIGIN = Deno.env.get('MCP_EXTERNAL_ORIGIN') ?? '';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name',
};

/**
 * 授权服务器元数据（RFC 8414）。
 *
 * 这份文档我们【如实转发】Supabase discovery 的真实值，不擅自增删字段——
 * 尤其不能自行加 client_id_metadata_document_supported：Supabase 不实现 CIMD，
 * 谎报会让 ChatGPT 选了 CIMD 路径后彻底卡死（它会拿 URL 当 client_id 来交换 token）。
 */
const OAUTH_METADATA = {
  issuer: AUTH_SERVER_URL,
  authorization_endpoint: `${AUTH_SERVER_URL}/oauth/authorize`,
  token_endpoint: `${AUTH_SERVER_URL}/oauth/token`,
  registration_endpoint: `${AUTH_SERVER_URL}/oauth/clients/register`,
  jwks_uri: `${AUTH_SERVER_URL}/.well-known/jwks.json`,
  userinfo_endpoint: `${AUTH_SERVER_URL}/oauth/userinfo`,
  scopes_supported: SCOPES_SUPPORTED,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  response_modes_supported: ['query'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  code_challenge_methods_supported: ['S256'],
  subject_types_supported: ['public'],
  // Supabase 实测发布的是 ES256 公钥（JWKS: alg=ES256, crv=P-256, kty=EC）
  id_token_signing_alg_values_supported: ['ES256'],
  claims_supported: ['sub', 'aud', 'iss', 'exp', 'iat', 'email', 'email_verified'],
} as const;

// ============================================================
// 外部入口动态推导（v0.14.2 新增）
//
// 两个可达入口：
//  ① Vercel 反代：https://global.powpow.online/api/mcp（用户在 ChatGPT 填的）
//  ② Supabase 直连：https://<ref>.supabase.co/functions/v1/mcp-server
//
// 域名来源优先级（v0.14.2 三次实测收敛）：
//  ① MCP_EXTERNAL_ORIGIN secret——v0.14.2 最终方案。实测 Supabase 网关会
//     丢弃客户端 X-Forwarded-Host（直连接手动带头也无效），反代出站请求
//     的 Host 恒为 supabase.co，网关看到的即是自身域名，无从回补外部域名。
//     secret 显式声明，零网关依赖，改域名只需 secrets set + redeploy。
//  ② X-Forwarded-Host 头——兜底（本地调试/将来网关行为变化）。反代侧
//     src/lib/mcp-proxy.ts 已显式透传，但目前到不了函数。
//  ③ 回退 Supabase 直连地址（v0.14.1 实证可用路径，功能成立域名不对）。
// ============================================================

/** 外部入口 origin（https://global.powpow.online 或 Supabase 直连 origin）。 */
export function externalOrigin(req: Request): string {
  if (MCP_EXTERNAL_ORIGIN) return MCP_EXTERNAL_ORIGIN.replace(/\/+$/, '');
  const fwdHost = req.headers.get('x-forwarded-host');
  if (fwdHost) {
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    return `${proto}://${fwdHost}`;
  }
  return `https://${PROJECT_REF}`;
}

/**
 * 外部视角的 metadata 文档 URL（WWW-Authenticate 里给客户端的值）。
 * Vercel 入口 → https://global.powpow.online/api/mcp/.well-known/oauth-protected-resource
 * 直连续   → https://<ref>.supabase.co/functions/v1/mcp-server/.well-known/oauth-protected-resource
 */
export function metadataUrlFor(req: Request): string {
  if (MCP_EXTERNAL_ORIGIN || req.headers.get('x-forwarded-host')) {
    return `${externalOrigin(req)}/api/mcp/.well-known/oauth-protected-resource`;
  }
  return `https://${PROJECT_REF}/functions/v1/${FN_SLUG}/.well-known/oauth-protected-resource`;
}

/**
 * 外部视角的 resource 标识（RFC 9728 文档的 resource 字段，也是 token aud 的期望值）。
 */
export function resourceUrlFor(req: Request): string {
  if (MCP_EXTERNAL_ORIGIN || req.headers.get('x-forwarded-host')) {
    return `${externalOrigin(req)}/api/mcp`;
  }
  return `https://${PROJECT_REF}/functions/v1/${FN_SLUG}`;
}

// 🔴🔴 Supabase Edge Function 的 req.url 不含 `/functions/v1` 前缀——
// 日志实测：外部请求 /functions/v1/mcp-server/.well-known/x，函数里看到的
// pathname 是 `/mcp-server/.well-known/x`（平台把前缀剥掉了）。
// 而 SDK 的 oauthMetadataResponse 是**纯字符串相等**匹配
// （protectedResourceMetadataPath(options.resourceServerUrl) === reqPath），
// 于是：
//   resourceServerUrl 用完整 URL  → 期望 /.well-known/oauth-protected-resource/functions/v1/mcp-server
//   函数实际看到/收到的→ /mcp-server/.well-known/...
// 两者永远不等 → 永远返回 undefined → 请求落到 MCP handler → 405 Method not allowed。
// 这是本次 405 的根因，不是代码逻辑错，是平台改写了 URL。
//
// 解法：resourceServerUrl 传【函数视角】的 URL，让 SDK 算出的期望路径与实际一致；
// 而 RFC 9728 文档里的 resource 字段仍对外宣称完整可达地址（ChatGPT 会把它
// 原样回传成 authorize/token 请求的 resource 参数）。
const RESOURCE_URL_AS_SEEN_BY_FUNCTION = `https://${PROJECT_REF}/${FN_SLUG}`;

/**
 * 处理 OAuth 相关路由。返回 null 表示「不是 OAuth 的事，交给 MCP handler」。
 *
 * 【为什么不直接用 SDK 的 oauthMetadataResponse】两条原因，都实测过：
 *  1. Supabase 把 `/functions/v1` 前缀从 req.url 里剥掉了（见上面注释），
 *     而 SDK 是纯字符串相等匹配 → 永远不命中。
 *  2. SDK 只认 `/.well-known/oauth-authorization-server` 这一个固定根路径，
 *     同样对不上实际的 `/mcp-server/.well-known/oauth-authorization-server`。
 * 所以这里自己匹配路径，但**文档内容仍由 SDK 的 buildOAuthProtectedResourceMetadata
 * 生成**（含 issuer HTTPS 校验等），不重复造轮子。
 */
export function handleOAuthRoutes(req: Request): Response | null {
  if (!MCP_OAUTH_ENABLED) return null;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const p = new URL(req.url).pathname;

  // RFC 9728：受保护资源元数据。
  // 接受两种写法（带不带 function slug 段），都指向同一份文档。
  const prmPaths = [
    // 函数实际看到的是带 /mcp-server 前缀的形态（Supabase 只剥 /functions/v1）
    `/${FN_SLUG}/.well-known/oauth-protected-resource/${FN_SLUG}`,
    `/${FN_SLUG}/.well-known/oauth-protected-resource/functions/v1/${FN_SLUG}`,
    `/${FN_SLUG}/.well-known/oauth-protected-resource`,
    // 无前缀形态（本地调试 / 将来不走 functions/v1 时）
    `/.well-known/oauth-protected-resource/${FN_SLUG}`,
    `/.well-known/oauth-protected-resource/functions/v1/${FN_SLUG}`,
    '/.well-known/oauth-protected-resource',
  ];
  if (prmPaths.includes(p)) {
    const meta = buildOAuthProtectedResourceMetadata({
      oauthMetadata: OAUTH_METADATA as unknown as Parameters<
        typeof buildOAuthProtectedResourceMetadata
      >[0]['oauthMetadata'],
      // 用函数视角的 URL，SDK 才不会因 Supabase 剥前缀而算错路径
      resourceServerUrl: new URL(RESOURCE_URL_AS_SEEN_BY_FUNCTION),
      scopesSupported: SCOPES_SUPPORTED,
      resourceName: 'PowPow',
      serviceDocumentationUrl: new URL('https://www.powpow.online'),
    });
    // resource 标识对外宣称【当前入口的完整可达地址】——ChatGPT 会把它原样
    // 回传成 authorize/token 的 resource 参数，也是 token aud 的期望值。
    return json({ ...meta, resource: resourceUrlFor(req) });
  }

  // RFC 8414：授权服务器元数据（原样转发我们声明的 Supabase 配置）。
  if (
    p === '/.well-known/oauth-authorization-server' ||
    p === `/${FN_SLUG}/.well-known/oauth-authorization-server`
  ) {
    return json(OAUTH_METADATA);
  }

  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/**
 * 构造「需要登录」的 challenge，供工具处理器挂在 _meta["mcp/www_authenticate"] 上。
 *
 * 官方 build-auth.md「Triggering authentication UI」：tool-level OAuth 需要
 * securitySchemes 元数据 + 运行时错误带 www_authenticate 两半俱全（当前版本
 * 不加 securitySchemes——v0.13.6 创建校验嫌疑，故此半暂缺，仅连接器级
 * 401 路径生效；跑通后再单变量增量补）。
 */
export function wwwAuthenticate(req: Request, error: string, description: string): string {
  return (
    `Bearer error="${error}", error_description="${description}", ` +
    `resource_metadata="${metadataUrlFor(req)}"`
  );
}

/** 工具处理器里「未登录」的标准返回体。 */
export function authRequiredResult(
  req: Request,
  description = '需要连接 PowPow 账号后才能执行此操作。',
) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: description }],
    _meta: { 'mcp/www_authenticate': [wwwAuthenticate(req, 'invalid_token', description)] },
  };
}

/**
 * 解析 Authorization: Bearer <token>（只解析，不验签）。
 * 验签走 verifyAccessToken；这里保留给需要原始 token 字符串的场景。
 */
export interface ParsedBearer {
  token: string;
  claims: Record<string, unknown> | null;
}

export function parseBearer(req: Request): ParsedBearer | null {
  const raw = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  // 结构化 JWT 解 payload；不是合法 JWT 时 claims 为 null（交给调用方决定是否放行）
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = atob(padded);
      return { token, claims: JSON.parse(json) };
    } catch {
      return { token, claims: null };
    }
  }
  return { token, claims: null };
}

/**
 * 真验签：JWKS（ES256）+ iss + exp（v0.14.2 还上 v0.14.0 的欠账）。
 *
 * aud 不强校验：Supabase OAuth server 对 RFC 8707 resource 参数的支持情况
 * 未实测（可能不回写 aud）。iss + ES256 签名 + exp 已足够定位「这是我们
 * 的授权服务器签发的未过期 token」；claims 全量进审计日志，aud 形态确认
 * 后再收紧（见 ROADMAP 需求 C）。
 *
 * @returns 验签通过返回 { sub, claims }；否则 null
 */
export async function verifyAccessToken(
  req: Request,
): Promise<{ sub: string; claims: Record<string, unknown> } | null> {
  const bearer = parseBearer(req);
  if (!bearer) return null;
  try {
    const { payload } = await jwtVerify(bearer.token, JWKS, {
      issuer: ISSUER,
      algorithms: ['ES256'],
    });
    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!sub) return null;
    return { sub, claims: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * 桥接查询：Supabase auth.users.id（token sub）→ PowPow users.id。
 *
 * 表 auth_users_link（2026-10-13 建，RLS 已开、仅 service_role 可读）：
 *   powpow_user_id ↔ supabase_auth_id，另存 shadow_email/token 缓存
 *   （token 缓存供 Vercel 侧 consent 流程用，Edge 侧只读映射列）。
 *
 * 为什么必须 service-role：public.users 是 RLS forced 的自建表，PowPow
 * 用户不在 auth.users 里，「用户 token + RLS」路线无映射可依（v0.14.1 实证）。
 */
export async function resolvePowpowUserId(supabaseAuthId: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const { data, error } = await adminClient()
      .from('auth_users_link')
      .select('powpow_user_id')
      .eq('supabase_auth_id', supabaseAuthId)
      .limit(1);
    if (error || !data?.length) return null;
    return data[0].powpow_user_id as string;
  } catch {
    return null;
  }
}

export interface AuthenticatedUser {
  /** PowPow 自建 users.id（工具执行身份） */
  powpowUserId: string;
  /** Supabase auth.users.id（token sub，日志/审计用） */
  supabaseAuthId: string;
  claims: Record<string, unknown>;
}

/** service-role 管理客户端（Edge 平台默认注入 SUPABASE_SERVICE_ROLE_KEY）。
 *  v0.17.0：改为导出，供 index.ts 的公开只读工具（get_user_profile /
 *  search_users）复用——public.users 是 RLS forced 表，anon key 读不到。 */
export function adminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface PowpowProfile {
  username: string;
  nickname: string | null;
  avatar_url: string | null;
  badges: number | null;
  subscription_tier: string | null;
  subscription_status: string | null;
}

/**
 * 读 PowPow 账号基本信息（whoami 工具用）。
 * public.users 是 RLS forced 表，anon key 读不到——必须 service-role
 * （v0.14.2 决策：工具执行身份 = service-role + 代码强制 user_id 过滤）。
 */
export async function fetchPowpowProfile(
  powpowUserId: string,
): Promise<PowpowProfile | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const { data, error } = await adminClient()
      .from('users')
      .select('username, nickname, avatar_url, badges, subscription_tier, subscription_status')
      .eq('id', powpowUserId)
      .limit(1);
    if (error || !data?.length) return null;
    return data[0] as PowpowProfile;
  } catch {
    return null;
  }
}

/**
 * 完整鉴权：验签 + 桥接解析。任一步失败返回 null。
 */
export async function authenticate(req: Request): Promise<AuthenticatedUser | null> {
  const verified = await verifyAccessToken(req);
  if (!verified) return null;
  const powpowUserId = await resolvePowpowUserId(verified.sub);
  if (!powpowUserId) return null;
  return { powpowUserId, supabaseAuthId: verified.sub, claims: verified.claims };
}

/**
 * 连接器级门禁说明（v0.14.2）：
 * MCP_OAUTH=true 时，非 metadata 路由的 MCP 请求无有效 token → 401 +
 * WWW-Authenticate（unauthorizedHttp）。该门禁在 index.ts 的 Deno.serve
 * 入口内联执行（与 per-request 身份计算复用同一次 authenticate 结果），
 * 不单独导出函数。
 *
 * 语义影响：现有匿名形态的连接器首次调用会收到 401 并触发授权流——
 * 这正是「应用内登录」的设计意图（添加连接器 = 登录 PowPow）。
 */

/** 供 index.ts 复用：未登录时统一的 HTTP 层 challenge（401 + WWW-Authenticate）。 */
export function unauthorizedHttp(req: Request): Response {
  return bearerAuthChallengeResponse(
    new OAuthError(OAuthErrorCode.InvalidToken, 'missing or invalid access token'),
    { resourceMetadataUrl: metadataUrlFor(req) },
  );
}
