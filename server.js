// B 站搜索 + 播放 一体化代理服务: 一个进程、一个端口同时提供页面与 API。
// 页面: / 首页、/search 搜索、/player 播放、/account 个人主页、/settings 设置
// 接口: /api/search /api/suggest /api/play /api/info /api/related /api/danmaku
//       /api/reply* /api/emote/panel /api/recommend /api/up/* /api/space/videos
//       /api/account/* /api/action/* /api/login/*
//
// B 站接口会校验 Referer / User-Agent,并要求匿名 buvid3 cookie,否则返回 412,
// 所以统一由服务端转发,匿名 cookie 全局共用一份并缓存。

const express = require("express");
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
};

// 视频页地址: 评论/弹幕/点赞/投币/收藏/播放心跳在网页端都发生在当前视频页,Referer 就是它
function videoPageUrl(aid) {
  return `https://www.bilibili.com/video/av${aid}`;
}

// 写操作(评论/弹幕/点赞/投币/收藏/关注/删历史)的上游请求头。
// 网页端发 POST 一定带 Origin,Referer 是操作发生时所在的页面;缺 Origin 尤其容易被上游
// 当成"不是浏览器发的",所以统一在这里补齐,调用方只管把当时那个页面地址传进来
function writeHeaders(cookie, referer) {
  return {
    ...COMMON_HEADERS,
    Origin: "https://www.bilibili.com",
    Referer: referer || COMMON_HEADERS.Referer,
    Cookie: cookie,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

const UPSTREAM_TIMEOUT_MS = 10000; // 请求 B 站上游接口的超时时间,超过就主动断开,不无限期挂起

// 上游请求统一加超时,避免对方不响应时连接和 Express 响应一直挂着
async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`请求上游接口超时(超过 ${(timeoutMs / 1000).toFixed(0)}s 未响应),请稍后重试`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 超时 -> 504 并透出具体文案;其它错误 -> 用调用方给的兜底状态码和文案
function buildErrorResponse(err, fallbackMessage, fallbackStatus) {
  const isTimeout = /超时/.test((err && err.message) || "");
  return {
    status: isTimeout ? 504 : fallbackStatus,
    message: isTimeout ? err.message : fallbackMessage,
  };
}

// 只有业务代码显式标记了 userMessage 的错误才允许把 message 透给前端,
// 其余(尤其是解析上游 HTML 拦截页抛出的报错)一律用兜底文案
function safeUpstreamMessage(err) {
  return (err && err.userMessage) || "加载失败,请稍后重试";
}

// 读取上游响应并解析成 JSON: 非 2xx 按状态码给出明确错误(412 单独识别,那是 WAF 拦截页),
// 响应体不是 JSON 时抛"不是 JSON 响应",不让含糊的解析器报错冒到前端
async function upstreamJson(r, label) {
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 60).replace(/\s+/g, " ").trim();
    throw Object.assign(new Error(`${label} 返回的不是 JSON 响应(HTTP ${r.status})`), {
      code: r.status === 412 ? 412 : -352,
      http: r.status,
      snippet,
    });
  }
  if (!r.ok) {
    throw Object.assign(new Error(`${label} 返回 HTTP ${r.status}`), {
      code: r.status === 412 ? 412 : json.code || -352,
      http: r.status,
    });
  }
  return json;
}

let cachedCookie = "";
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000; // 30 分钟刷新一次

// 把 "a=1; b=2" 解析成对象
function parseCookieString(str) {
  const out = {};
  String(str || "")
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
  return out;
}

// 把对象拼回 "a=1; b=2"
function cookieHeader(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// 取一套设备指纹 cookie。值仍然来自上游: buvid3/buvid4 走 finger/spi,首页 Set-Cookie
// 只给 buvid3(b_nut 等基础 cookie 也在这里补齐),所以两步都要走。
// _uuid 是网页端在本地生成的设备标识,上游不下发,这里按同样的格式补一个
async function fetchDeviceCookies() {
  const cookies = {};

  // 1) 显式取设备指纹 buvid3 + buvid4
  try {
    const spiRes = await fetchWithTimeout("https://api.bilibili.com/x/frontend/finger/spi", {
      headers: COMMON_HEADERS,
    });
    const spiJson = await spiRes.json();
    if (spiJson.code === 0 && spiJson.data) {
      if (spiJson.data.b_3) cookies.buvid3 = spiJson.data.b_3;
      if (spiJson.data.b_4) cookies.buvid4 = spiJson.data.b_4;
    }
  } catch (err) {
    // 拿不到指纹就退回只用首页 cookie,静默降级(每次页面加载都会走到这里,不打日志)
  }

  // 2) 再访问首页补齐 b_nut 等基础 cookie,已有的以指纹为准不覆盖
  try {
    const res = await fetchWithTimeout("https://www.bilibili.com/", {
      headers: COMMON_HEADERS,
    });
    const setCookie = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : res.headers.raw?.()["set-cookie"] || [];
    for (const c of setCookie || []) {
      const first = c.split(";")[0];
      const i = first.indexOf("=");
      if (i <= 0) continue;
      const k = first.slice(0, i);
      if (!cookies[k]) cookies[k] = first.slice(i + 1);
    }
  } catch (err) {
    // 首页 cookie 拉取失败同样静默降级,不影响后续请求带指纹 cookie
  }

  cookies._uuid = buildDeviceUuid();
  return cookies;
}

// 网页端的 _uuid: UUID v4 + 5 位数字 + "infoc" 后缀
function buildDeviceUuid() {
  const hex = "0123456789abcdef";
  const pick = (n) => Array.from({ length: n }, () => hex[Math.floor(Math.random() * 16)]).join("");
  const tail = String(Date.now() % 100000).padStart(5, "0");
  return `${pick(8)}-${pick(4)}-4${pick(3)}-8${pick(3)}-${pick(12)}${tail}infoc`;
}

// 匿名请求共用一套设备指纹,全局缓存 30 分钟
async function ensureCookie() {
  const isFresh = cachedCookie && Date.now() - cookieFetchedAt < COOKIE_TTL_MS;
  if (isFresh) return cachedCookie;

  const cookieStr = cookieHeader(await fetchDeviceCookies());
  if (cookieStr) {
    cachedCookie = cookieStr;
    cookieFetchedAt = Date.now();
  }
  return cachedCookie;
}

// 登录会话各自一套设备指纹: 匿名那套是全局共用的,几个账号都从同一台"设备"发评论,
// 在上游看来就像一台机器在批量操作。每个会话第一次用到时取一套新的,存进会话跟着
// sessions.json 一起持久化,之后这个会话的所有请求都用它
async function sessionDeviceCookies(session) {
  if (session.device) return session.device;
  // 打开一个播放页会同时打好几个接口,这里让它们共用同一次取值,
  // 否则同一个会话会同时拿到几套不同的指纹
  if (!session.devicePending) {
    session.devicePending = fetchDeviceCookies().then((device) => {
      delete session.devicePending;
      // 没拿到 buvid3 说明这次取值失败,不记进会话,下次再试
      if (!device.buvid3) return null;
      session.device = device;
      persistSessionsToDisk();
      return device;
    });
  }
  return session.devicePending;
}

// 已登录会话的完整上游 cookie: 它自己那套设备指纹 + 登录态三件套
async function sessionCookieHeader(session) {
  const device = await sessionDeviceCookies(session);
  return cookieHeader({
    ...(device || parseCookieString(await ensureCookie())),
    SESSDATA: session.sessdata,
    bili_jct: session.biliJct,
    DedeUserID: session.dedeUserId,
  });
}

/* ----------------------------- 访客会话 -----------------------------
 * 每个浏览器访客通过我们自己签发的 httpOnly cookie(app_sid)拿到一个随机 sessionId,
 * 用它把"这个人是否登录了 B 站账号"串起来:
 *   - 未登录: sessions 里没有对应登录信息,上游请求走匿名 cookie
 *   - 登录中: 扫码生成的 qrcode_key 临时挂在 sessionId 下,等轮询结果
 *   - 已登录: 保存 SESSDATA / bili_jct / DedeUserID,请求上游时优先带上
 * 已登录会话持久化到 SESSIONS_FILE,服务重启后自动恢复。
 *
 * SESSDATA 等价于 B 站账号的登录态,这里只明文存本地 JSON 文件,适合个人自用;
 * 不要提交进版本库,也不要把本服务暴露给不信任的人。
 * -------------------------------------------------------------------- */

const SESSION_COOKIE_NAME = "app_sid";
const SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 跟 B 站 SESSDATA 的默认有效期(约180天)对齐
// 会话文件路径可用 SESSIONS_FILE 覆盖(本地验证时可指向副本,不动真实登录数据)
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(__dirname, "data", "sessions.json");

// 登录态巡检节奏:
//   SESSION_SWEEP_INTERVAL_MS  定期巡检所有会话
//   SESSION_VERIFY_MIN_GAP_MS  同一会话两次主动问上游的最小间隔(前端 ?verify=1 巡检靠它限流)
//   SESSION_IDLE_TTL_MS        无登录数据的空记录(如只生成过二维码)无人访问时的回收兜底
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SESSION_VERIFY_MIN_GAP_MS = 60 * 1000;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

// 401 的两种统一文案: 已过期 = 上游作废了本地 SESSDATA(会话会被删掉),请先登录 = 本地没有登录数据
const LOGIN_EXPIRED_MESSAGE = "登录已过期,请重新登录";
const LOGIN_REQUIRED_MESSAGE = "请先登录";

// sessionId -> {
//   已登录时才有: sessdata, biliJct, dedeUserId, uname, avatar, loginAt, expiresAt,
//                 mid, sign, level, vipType, vipStatus, money
//   扫码进行中才有: pendingQrcodeKey, pendingQrcodeExpiresAt
//   巡检用: lastVerifiedAt(仅内存)
//   回收用: createdAt, lastSeenAt
// }
const sessions = new Map();

function loadSessionsFromDisk() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf-8");
    // 去掉编辑器可能写入的 BOM,否则 JSON.parse 会直接失败、丢掉全部登录会话
    const obj = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const now = Date.now();
    let restored = 0;
    let dropped = 0;
    Object.entries(obj).forEach(([sid, info]) => {
      // 加载时顺手把已经过期的登录态丢掉,避免继续拿失效 cookie 去请求上游
      if (info && info.sessdata && info.expiresAt > now) {
        sessions.set(sid, info);
        restored += 1;
      } else if (info && info.sessdata) {
        dropped += 1;
      }
    });
    console.log(`[会话] 启动恢复 ${restored} 条登录会话`);
    if (dropped) {
      console.log(`[会话] 启动丢弃 ${dropped} 条登录会话 原因=本地有效期到(LOCAL_EXPIRED)`);
      // 上面的过滤只影响内存,这里把 sessions.json 也重写一遍,过期数据才算真正删掉
      persistSessionsToDisk();
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("读取本地会话文件失败,将从空会话开始:", err.message);
    }
  }
}

let saveScheduled = false;
// 登录/登出不频繁,合并到下一个 tick 一次性写入即可,不需要引入防抖库
function persistSessionsToDisk() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    const obj = {};
    for (const [sid, info] of sessions.entries()) {
      // 只持久化"已登录"的会话,扫码中间态没必要跨重启保留
      if (info.sessdata) {
        obj[sid] = {
          sessdata: info.sessdata,
          biliJct: info.biliJct,
          dedeUserId: info.dedeUserId,
          uname: info.uname,
          avatar: info.avatar,
          loginAt: info.loginAt,
          expiresAt: info.expiresAt,
          // 个人主页资料卡要用到的这几个字段,登录成功那一刻顺手存下来,
          // 避免每次打开 /account 都重新请求 nav/account 接口
          mid: info.mid,
          sign: info.sign,
          level: info.level,
          vipType: info.vipType,
          vipStatus: info.vipStatus,
          money: info.money,
          // 这条会话自己那套设备指纹(见 sessionDeviceCookies): 重启后还是同一台"设备"
          device: info.device,
        };
      }
    }
    try {
      fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      console.error("保存会话文件失败:", err.message);
    }
  });
}

loadSessionsFromDisk();

/* --------------------- 登录态校验 / 会话自动清理 ---------------------
 * 会话只有"有效"和"不存在"两种状态,判定有效的条件: 有 sessdata 且本地 expiresAt 未到。
 * SESSDATA 是否被上游提前作废由 sweepSessions() 定期问一次 nav 决定;一旦发现失效,
 * 就地删除整条会话,并让当前请求回 401 + "登录已过期,请重新登录"。
 * -------------------------------------------------------------------- */

// 记录会话最近活跃时间,供空记录回收使用
function touchSession(session) {
  if (session) session.lastSeenAt = Date.now();
}

// 会话事件统一出口: [会话] 前缀 + 动作 + sid + 昵称 + 原因码,便于按 sid 串起一条会话的完整生命周期
function logSessionEvent(action, sid, session, reason) {
  const sidTag = sid ? ` sid=${String(sid).slice(0, 8)}` : "";
  const userTag = session && session.uname ? ` user=${session.uname}` : "";
  console.log(`[会话] ${action}${sidTag}${userTag} 原因=${reason}`);
}

// 删掉一条会话,内存和 sessions.json 一起收敛;reason 用固定原因码
function dropSession(sid, session, reason) {
  if (!sid || !sessions.has(sid)) return false;
  sessions.delete(sid);
  persistSessionsToDisk();
  logSessionEvent("移除会话", sid, session, reason);
  return true;
}

// 本地记录的有效期到了就删掉,不用问上游
function dropIfLocallyExpired(sid, session) {
  if (!session || !session.sessdata || session.expiresAt > Date.now()) return false;
  return dropSession(sid, session, "本地有效期到(LOCAL_EXPIRED)");
}

// 扫码中间态结束(本地超时或上游说二维码已失效): 清掉 pending 字段;
// 若这条记录没有任何登录数据,直接删掉
function finishQrcodeFlow(sid, session) {
  if (!session) return;
  delete session.pendingQrcodeKey;
  delete session.pendingQrcodeExpiresAt;
  if (!session.sessdata) dropSession(sid, session, "二维码超时(QR_EXPIRED)");
}

// 需要登录时的两种 401,前端只认状态码和 message
function sendLoginExpired(res) {
  res.status(401).json({ code: -101, message: LOGIN_EXPIRED_MESSAGE });
}

function sendLoginRequired(res) {
  res.status(401).json({ code: 1, message: LOGIN_REQUIRED_MESSAGE });
}

// 上游明确回 -101(账号未登录)时调用: 本地 SESSDATA 已被作废,删掉整条会话并回 401。
// 返回 true 表示响应已写出,调用方直接 return 即可
function replyIfUnauthorized(req, res, data) {
  if (!data || data.code !== -101) return false;
  dropSession(req.sessionId, getSession(req, false), "上游判定未登录(UPSTREAM_NOT_LOGIN)");
  sendLoginExpired(res);
  return true;
}

// 拿会话里的 Cookie 问一次上游 nav,确认登录态是否仍然有效。
// 只有上游明确说没登录(code -101 或 data.isLogin === false)才算失效;
// 网络错误、被风控(-352/-799/412)等问不出来的情况不动本地会话,免得误把人踢下线
async function verifySessionWithUpstream(sid, session) {
  if (!session || !session.sessdata) return false;

  const now = Date.now();
  // 刚校验过就不再问一次: 上一次的结论仍然有效(前端巡检 + 多个标签页共用这一层限流)
  if (session.lastVerifiedAt && now - session.lastVerifiedAt < SESSION_VERIFY_MIN_GAP_MS) return false;
  session.lastVerifiedAt = now;

  try {
    const cookie = await sessionCookieHeader(session);
    const r = await fetchWithTimeout("https://api.bilibili.com/x/web-interface/nav", {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });
    const json = await r.json();
    const notLoggedIn = !!json && (json.code === -101 || (json.data && json.data.isLogin === false));
    if (notLoggedIn) {
      dropSession(sid, session, "上游判定未登录(UPSTREAM_NOT_LOGIN)");
      return true;
    }
  } catch (err) {
    console.warn(`[会话] 校验失败 sid=${String(sid).slice(0, 8)} 原因=${err.message}(保留会话,下一轮再试)`);
  }
  return false;
}

// 会话巡检: 逐个处理不并发打上游,内存和 sessions.json 一起收敛。
//   1) 扫码中间态超时                       → 清 pending,无登录数据就整条删
//   2) 无登录数据的空记录超过空闲时限        → 整条删(兜底)
//   3) 有登录数据但本地有效期到了            → 整条删,不问上游
//   4) 其余问一次上游 nav,明确没登录        → 整条删
// only 用于只巡检一个会话(前端 ?verify=1),返回本次移除条数
async function sweepSessions({ only = null } = {}) {
  const now = Date.now();
  let removed = 0;

  for (const [sid, info] of [...sessions.entries()]) {
    if (only && sid !== only) continue;

    if (!info || typeof info !== "object") {
      dropSession(sid, info, "记录损坏(BAD_RECORD)");
      removed += 1;
      continue;
    }

    if (info.pendingQrcodeExpiresAt && info.pendingQrcodeExpiresAt <= now) {
      finishQrcodeFlow(sid, info);
      if (!sessions.has(sid)) removed += 1;
      continue;
    }

    if (!info.sessdata) {
      const idle = now - (info.lastSeenAt || info.createdAt || 0);
      if (!info.pendingQrcodeKey && idle > SESSION_IDLE_TTL_MS) {
        dropSession(sid, info, "空记录长期无人访问(IDLE)");
        removed += 1;
      }
      continue;
    }

    if (dropIfLocallyExpired(sid, info)) {
      removed += 1;
      continue;
    }

    try {
      if (await verifySessionWithUpstream(sid, info)) removed += 1;
    } catch (err) {
      // 单个会话校验失败不影响其它会话,交给下一轮
      console.warn(`[会话] 巡检异常 sid=${String(sid).slice(0, 8)} 原因=${err.message}`);
    }
  }

  if (removed) console.log(`[会话] 巡检完成: 移除 ${removed} 条,当前会话 ${sessions.size} 条`);
  return removed;
}

// 定时巡检: 打开着的页面靠前端 ?verify=1 发现失效,没开页面的会话由这里兜底
setInterval(() => {
  sweepSessions();
}, SESSION_SWEEP_INTERVAL_MS).unref();

// 启动后也巡检一次(等几秒避开启动瞬间的其它初始化),清掉上次进程退出前就已失效的会话
setTimeout(() => {
  sweepSessions();
}, 5000).unref();

function parseCookieHeader(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

// 给所有请求分配/延续 sessionId 并种成 httpOnly cookie;必须注册在其它路由之前
app.use(express.json());
app.use((req, res, next) => {
  let sid = parseCookieHeader(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) {
    sid = crypto.randomBytes(16).toString("hex");
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
        SESSION_MAX_AGE_MS / 1000
      )}`
    );
  }
  req.sessionId = sid;
  // 只有确实存在的会话才更新活跃时间(匿名访客不会因此被塞进 sessions 里)
  touchSession(sessions.get(sid));
  next();
});

function getSession(req, createIfMissing) {
  let session = sessions.get(req.sessionId);
  if (!session && createIfMissing) {
    const now = Date.now();
    session = { createdAt: now, lastSeenAt: now };
    sessions.set(req.sessionId, session);
  }
  return session;
}

function isLoggedIn(session) {
  return !!(session && session.sessdata && session.expiresAt > Date.now());
}

// 拼上游请求用的 Cookie: 登录态有效就带上 SESSDATA 等,
// 同时始终带上匿名 buvid3/buvid4 —— 它们是设备标识,登录状态下同样被校验
async function getUpstreamCookie(req) {
  const session = getSession(req, false);
  if (!isLoggedIn(session)) return ensureCookie();
  return sessionCookieHeader(session);
}

// 用登录 cookie 查当前账号的昵称/头像/mid/等级/大会员/硬币数,登录成功那一刻调用一次。
// nav 没有"签名"字段,额外调一次 x/member/web/account 补齐
async function fetchLoginUserInfo(session) {
  const cookie = await sessionCookieHeader(session);

  const r = await fetchWithTimeout("https://api.bilibili.com/x/web-interface/nav", {
    headers: { ...COMMON_HEADERS, Cookie: cookie },
  });
  const json = await r.json();
  if (!json.data || !json.data.isLogin) {
    // -101 = 账号未登录,说明本地 SESSDATA 已被作废;带上 code,让上层能识别出
    // "这个登录态没用了",而不是普通的接口失败
    throw Object.assign(new Error("获取用户信息失败"), { code: json.code === -101 ? -101 : -1 });
  }

  let sign = "";
  try {
    const accR = await fetchWithTimeout("https://api.bilibili.com/x/member/web/account", {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });
    const accJson = await accR.json();
    if (accJson.code === 0 && accJson.data) sign = accJson.data.sign || "";
  } catch (signErr) {
    console.warn("获取个性签名失败,忽略:", signErr.message);
  }

  return {
    uname: json.data.uname || "",
    avatar: json.data.face?.startsWith("//") ? `https:${json.data.face}` : json.data.face || "",
    mid: json.data.mid || null,
    sign,
    level: json.data.level_info?.current_level ?? null,
    vipType: json.data.vipType ?? 0,
    vipStatus: json.data.vipStatus ?? 0,
    money: json.data.money ?? 0,
  };
}

/* ----------------------------- 登录(扫码) -----------------------------
 * 标准三步: 生成二维码 -> 前端展示 -> 轮询确认。
 * 不做账号密码登录: 那条路径会触发极验滑块验证码,风控成本高。
 * -------------------------------------------------------------------- */

const QRCODE_TTL_MS = 180 * 1000; // B 站二维码本身 180 秒过期

app.get("/api/login/qrcode", async (req, res) => {
  try {
    const cookie = await ensureCookie();
    const biliRes = await fetchWithTimeout(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
      { headers: { ...COMMON_HEADERS, Cookie: cookie } }
    );
    const data = await biliRes.json();
    if (data.code !== 0 || !data.data) {
      throw new Error(`获取二维码失败: ${data.message || data.code}`);
    }

    const session = getSession(req, true);
    session.pendingQrcodeKey = data.data.qrcode_key;
    session.pendingQrcodeExpiresAt = Date.now() + QRCODE_TTL_MS;

    // 二维码在服务端生成成 base64 PNG(data URL)返回,前端只需要一个 <img>,
    // 不依赖任何前端二维码库/CDN
    const qr = await QRCode.toDataURL(data.data.url, {
      width: 220,
      margin: 2,
      errorCorrectionLevel: "M",
    });

    res.json({ code: 0, url: data.data.url, qr });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取二维码失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

app.get("/api/login/poll", async (req, res) => {
  const session = getSession(req, false);
  const qrcodeKey = session && session.pendingQrcodeKey;

  if (!qrcodeKey) {
    return res.status(400).json({ code: 1, message: "请先获取二维码" });
  }
  if (session.pendingQrcodeExpiresAt && Date.now() > session.pendingQrcodeExpiresAt) {
    finishQrcodeFlow(req.sessionId, session);
    return res.json({ status: "expired" });
  }

  try {
    const cookie = await ensureCookie();
    const url = new URL("https://passport.bilibili.com/x/passport-login/web/qrcode/poll");
    url.searchParams.set("qrcode_key", qrcodeKey);

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });
    const data = await biliRes.json();

    if (data.code !== 0 || !data.data) {
      throw new Error(`轮询登录状态失败: ${data.message || data.code}`);
    }

    const loginCode = data.data.code;
    // 86101 未扫码, 86090 已扫码待确认, 86038 二维码失效, 0 登录成功
    if (loginCode === 86101) return res.json({ status: "waiting" });
    if (loginCode === 86090) return res.json({ status: "scanned" });
    if (loginCode === 86038) {
      finishQrcodeFlow(req.sessionId, session);
      return res.json({ status: "expired" });
    }
    if (loginCode !== 0) {
      // 未知的中间状态,不当成错误处理,让前端继续轮询就行
      return res.json({ status: "waiting" });
    }

    // loginCode === 0: 登录成功,SESSDATA 等从这次响应的 Set-Cookie 里取
    const setCookie = biliRes.headers.getSetCookie
      ? biliRes.headers.getSetCookie()
      : biliRes.headers.raw?.()["set-cookie"] || [];

    const cookieMap = {};
    (setCookie || []).forEach((c) => {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx === -1) return;
      cookieMap[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });

    if (!cookieMap.SESSDATA) {
      throw new Error("登录响应中未找到 SESSDATA");
    }

    session.sessdata = cookieMap.SESSDATA;
    session.biliJct = cookieMap.bili_jct || "";
    session.dedeUserId = cookieMap.DedeUserID || "";
    session.loginAt = Date.now();
    session.expiresAt = Date.now() + SESSION_MAX_AGE_MS;
    // 重新登录成功: 视为刚刚校验过登录态,顺手清掉还没走完的扫码中间态
    session.lastVerifiedAt = Date.now();
    touchSession(session);
    delete session.pendingQrcodeKey;
    delete session.pendingQrcodeExpiresAt;

    // 顺手拿一下昵称头像,前端登录成功可以直接展示,不用再单独请求一次
    try {
      const profile = await fetchLoginUserInfo(session);
      session.uname = profile.uname;
      session.avatar = profile.avatar;
      session.mid = profile.mid;
      session.sign = profile.sign;
      session.level = profile.level;
      session.vipType = profile.vipType;
      session.vipStatus = profile.vipStatus;
      session.money = profile.money;
    } catch (profileErr) {
      console.warn("登录成功但获取用户信息失败:", profileErr.message);
    }

    persistSessionsToDisk();

    res.json({ status: "success", uname: session.uname || "", avatar: session.avatar || "", uid: session.dedeUserId || "" });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "轮询登录状态失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

app.get("/api/login/status", async (req, res) => {
  let session = getSession(req, false);
  touchSession(session);
  // 本地记录的有效期到了就直接删掉,下面统一按"未登录"回
  dropIfLocallyExpired(req.sessionId, session);

  // 前端定时巡检带 ?verify=1 时,主动问一次上游确认登录态是否仍然有效(判定失效会在这一步删掉会话)
  if ((req.query.verify || "").toString() === "1") {
    await sweepSessions({ only: req.sessionId });
  }

  // 上面两步都可能删掉这条会话,所以重新取一次
  session = getSession(req, false);
  if (!isLoggedIn(session)) {
    return res.json({ loggedIn: false });
  }

  // uid 强制转成字符串: dedeUserId 可能已被转成数字,超过 JS 安全整数上限时会失真,
  // 拿去比对"这条评论是不是我发的"就会比错人
  res.json({
    loggedIn: true,
    uname: session.uname || "",
    avatar: session.avatar || "",
    uid: session.dedeUserId == null ? "" : String(session.dedeUserId),
  });
});

app.post("/api/login/logout", (req, res) => {
  dropSession(req.sessionId, getSession(req, false), "用户主动退出(LOGOUT)");
  res.json({ code: 0 });
});

/* ----------------------------- 个人主页(资料卡 / 历史记录 / 收藏夹) -----------------------------
 * 都只需要登录 Cookie,不需要 WBI 签名,共用 getUpstreamCookie。
 * -------------------------------------------------------------------- */

// 校验登录态,没有可用登录数据就回 401,否则返回 session
function requireLogin(req, res) {
  const session = getSession(req, false);
  if (isLoggedIn(session)) return session;

  if (dropIfLocallyExpired(req.sessionId, session)) {
    sendLoginExpired(res);
    return null;
  }
  sendLoginRequired(res);
  return null;
}

// 补齐会话里缺失的资料字段(mid/sign/level 等,登录成功时已存一份,旧会话可能没有)。
// 上游说"未登录"说明 SESSDATA 已失效: 删掉整条会话,并抛带 sessionInvalid 的错误,
// 由各接口统一回 401 + "登录已过期,请重新登录"
async function ensureProfileFields(req, session) {
  if (session.mid) return session;
  try {
    const profile = await fetchLoginUserInfo(session);
    session.mid = profile.mid;
    session.sign = profile.sign;
    session.level = profile.level;
    session.vipType = profile.vipType;
    session.vipStatus = profile.vipStatus;
    session.money = profile.money;
    persistSessionsToDisk();
  } catch (err) {
    if (err.code === -101) {
      dropSession(req.sessionId, session, "上游判定未登录(UPSTREAM_NOT_LOGIN)");
      throw Object.assign(new Error(LOGIN_EXPIRED_MESSAGE), { sessionInvalid: true });
    }
    console.warn("补齐旧会话资料字段失败:", err.message);
  }
  return session;
}

// 查当前账号的硬币余额。这个接口只要 Cookie、不用 WBI,比整个 nav 便宜,
// 所以个人主页每次实时查一次 —— 会话里的 money 只在登录那一刻准确,投币/充电后不再更新
async function fetchCoinBalance(cookie) {
  const r = await fetchWithTimeout("https://account.bilibili.com/site/getCoin", {
    headers: { ...COMMON_HEADERS, Cookie: cookie },
  });
  const json = await r.json();
  if (!json || json.code !== 0) {
    throw new Error((json && json.message) || "获取硬币数失败");
  }
  // 上游在"硬币为 0"时返回的是 null,统一折成 0
  return json.data ? json.data.money ?? 0 : 0;
}

app.get("/api/account/profile", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  try {
    await ensureProfileFields(req, session);

    let following = null;
    let follower = null;
    if (session.mid) {
      const cookie = await getUpstreamCookie(req);

      // 硬币余额实时查;查失败就沿用旧值,不能因为拿不到硬币数就把整张资料卡变成错误页
      try {
        session.money = await fetchCoinBalance(cookie);
        persistSessionsToDisk();
      } catch (coinErr) {
        console.warn("获取硬币数失败,沿用会话里的旧值:", coinErr.message);
      }

      try {
        const url = new URL("https://api.bilibili.com/x/relation/stat");
        url.searchParams.set("vmid", String(session.mid));
        const r = await fetchWithTimeout(url.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } });
        const data = await r.json();
        if (data.code === 0 && data.data) {
          following = data.data.following ?? null;
          follower = data.data.follower ?? null;
        }
      } catch (statErr) {
        console.warn("获取关注/粉丝数失败,忽略:", statErr.message);
      }
    }

    res.json({
      code: 0,
      mid: session.mid || null,
      uname: session.uname || "",
      avatar: session.avatar || "",
      sign: session.sign || "",
      level: session.level ?? null,
      vipType: session.vipType ?? 0,
      vipStatus: session.vipStatus ?? 0,
      money: session.money ?? 0,
      following,
      follower,
    });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取个人资料失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

// 历史记录: 游标翻页,只保留视频类型(business === "archive")
const HISTORY_PAGE_SIZE = 20;

app.get("/api/account/history", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  try {
    const cookie = await getUpstreamCookie(req);

    const url = new URL("https://api.bilibili.com/x/web-interface/history/cursor");
    url.searchParams.set("max", (req.query.max || "0").toString());
    url.searchParams.set("view_at", (req.query.view_at || "0").toString());
    const business = (req.query.business || "").toString();
    if (business) url.searchParams.set("business", business);
    url.searchParams.set("type", "archive"); // 只要视频,直播/专栏/番剧不要
    url.searchParams.set("ps", String(HISTORY_PAGE_SIZE));

    const biliRes = await fetchWithTimeout(url.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      throw new Error(`获取历史记录失败: ${data.message || data.code}`);
    }

    const rawList = data.data?.list || [];
    // 上游已按 type=archive 过滤过一次,这里再按 business/bvid 兜底,防止混进非视频条目
    const list = rawList
      .filter((item) => item.history?.business === "archive" && item.history?.bvid)
      .map((item) => ({
        bvid: item.history.bvid,
        // aid 供删除历史使用(kid=archive_{aid});cursor 接口里 archive 条目的 oid 就是 aid
        aid: item.history.oid || 0,
        cid: item.history.cid || 0,
        page: item.history.page || 1,
        part: item.history.part || "",
        title: sanitizeTitle(item.title || ""),
        pic: item.cover?.startsWith("//") ? `https:${item.cover}` : item.cover || "",
        author: item.author_name || "",
        authorMid: item.author_mid || 0,
        duration: item.duration || 0,
        // progress: 看到第几秒,-1 = 已看完;继续观看时前端据此拼 t 参数
        progress: item.progress ?? -1,
        viewAt: item.view_at || 0,
      }));

    const cursor = data.data?.cursor || {};
    res.json({
      code: 0,
      list,
      hasMore: rawList.length > 0,
      nextCursor: {
        max: cursor.max || 0,
        view_at: cursor.view_at || 0,
        business: cursor.business || "",
      },
    });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取历史记录失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

// 校验这批收藏夹 id 是否都属于当前账号。收藏夹是账号级资源,调用方给的 id 不能直接信:
// 上游请求失败时返回 null(响应已发出),id 越权时返回 false
async function assertOwnFavorites(req, res, session, mediaIds) {
  try {
    await ensureProfileFields(req, session);
    if (!session.mid) throw new Error("获取账号信息失败");

    const cookie = await getUpstreamCookie(req);
    const url = new URL("https://api.bilibili.com/x/v3/fav/folder/created/list-all");
    url.searchParams.set("up_mid", String(session.mid));

    const r = await fetchWithTimeout(url.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } });
    const json = await r.json();
    if (replyIfUnauthorized(req, res, json)) return null;
    if (json.code !== 0) throw new Error(`获取收藏夹列表失败: ${json.message || json.code}`);

    const ownIds = new Set((json.data?.list || []).map((f) => String(f.id)));
    return mediaIds.every((id) => ownIds.has(String(id)));
  } catch (err) {
    if (err.sessionInvalid) {
      sendLoginExpired(res);
    } else {
      console.error(err);
      res.status(502).json({ code: 1, message: "获取收藏夹列表失败,请稍后重试" });
    }
    return null;
  }
}

// 收藏夹列表(只列自己创建的夹子)。带 ?rid={avid} 时上游会为每个夹子带上 fav_state
// (1=该视频在此夹子里),播放页靠它画出"选择收藏夹"面板的勾选状态
app.get("/api/account/favorites", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const rid = parseInt((req.query && req.query.rid) || "", 10);

  try {
    await ensureProfileFields(req, session);
    if (!session.mid) {
      return res.status(500).json({ code: 1, message: "缺少用户 mid,请重新登录后再试" });
    }

    const cookie = await getUpstreamCookie(req);
    const url = new URL("https://api.bilibili.com/x/v3/fav/folder/created/list-all");
    url.searchParams.set("up_mid", String(session.mid));
    // type=2 只列收视频稿件的夹子(与收藏页一致),也让上游带上 attr
    url.searchParams.set("type", "2");
    if (rid) url.searchParams.set("rid", String(rid));

    const biliRes = await fetchWithTimeout(url.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      throw new Error(`获取收藏夹列表失败: ${data.message || data.code}`);
    }

    const list = (data.data?.list || []).map((f) => ({
      id: f.id,
      title: f.title || "",
      mediaCount: f.media_count || 0,
      // 二进制位属性:bit0=私密,bit1=是否其他收藏夹(0 即默认收藏夹,默认夹子不能删)
      attr: f.attr || 0,
      // 传了 rid 时上游才会带 fav_state,没传就固定给 0(不传 rid 的调用方也不看这个字段)
      favState: f.fav_state || 0,
    }));

    res.json({ code: 0, list });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取收藏夹列表失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 新建 / 编辑 / 删除收藏夹 -----------------------------
 * 都是"写"操作,直接打到 B 站:
 *   - 新建: x/v3/fav/folder/add,title + privacy + csrf
 *   - 编辑: x/v3/fav/folder/edit,media_id + title + privacy + csrf
 *   - 删除: x/v3/fav/folder/del,media_ids + csrf
 * 默认收藏夹(attr bit1 为 0)上游不允许删,前端也不给删除入口(但仍可以改名字)。
 * -------------------------------------------------------------------- */

app.post("/api/account/favorites/create", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const body = req.body || {};
  const title = (body.title || "").toString().trim();
  // privacy: 0=公开 1=私密,其余值一律当公开
  const privacy = parseInt(body.privacy || "", 10) === 1 ? "1" : "0";

  if (!title) return res.status(400).json({ code: 1, message: "请填写收藏夹名称" });
  if (title.length > 40) return res.status(400).json({ code: 1, message: "收藏夹名称不能超过 40 个字" });

  try {
    const cookie = await getUpstreamCookie(req);
    const params = new URLSearchParams({
      title,
      privacy,
      csrf: session.biliJct || "",
    });

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v3/fav/folder/add", {
      method: "POST",
      headers: writeHeaders(cookie, "https://www.bilibili.com/account/fav"),
      body: params.toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.json({ code: data.code, message: data.message || "新建收藏夹失败" });
    }
    // id 给前端用于本地插入新夹子,省一次列表请求
    res.json({ code: 0, id: data.data?.id || null });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "新建收藏夹失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

app.post("/api/account/favorites/edit", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const body = req.body || {};
  const mediaId = (body.mediaId || "").toString().trim();
  const title = (body.title || "").toString().trim();
  const privacy = parseInt(body.privacy || "", 10) === 1 ? "1" : "0";

  if (!mediaId) return res.status(400).json({ code: 1, message: "缺少收藏夹 id" });
  if (!title) return res.status(400).json({ code: 1, message: "请填写收藏夹名称" });
  if (title.length > 40) return res.status(400).json({ code: 1, message: "收藏夹名称不能超过 40 个字" });

  try {
    // 同删除:改的是账号级资源,先确认这个夹子属于当前账号
    const own = await assertOwnFavorites(req, res, session, [mediaId]);
    if (own === null) return;
    if (!own) {
      return res.status(400).json({ code: 1, message: "收藏夹不存在或不属于当前账号" });
    }

    const cookie = await getUpstreamCookie(req);
    const params = new URLSearchParams({
      media_id: mediaId,
      title,
      privacy,
      csrf: session.biliJct || "",
    });

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v3/fav/folder/edit", {
      method: "POST",
      headers: writeHeaders(cookie, "https://www.bilibili.com/account/fav"),
      body: params.toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.json({ code: data.code, message: data.message || "保存收藏夹失败" });
    }
    res.json({ code: 0 });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "保存收藏夹失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

app.post("/api/account/favorites/delete", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const mediaId = ((req.body && req.body.mediaId) || "").toString().trim();
  if (!mediaId) return res.status(400).json({ code: 1, message: "缺少收藏夹 id" });

  try {
    // 同移动/复制:删的是账号级资源,先确认这个夹子属于当前账号
    const own = await assertOwnFavorites(req, res, session, [mediaId]);
    if (own === null) return;
    if (!own) {
      return res.status(400).json({ code: 1, message: "收藏夹不存在或不属于当前账号" });
    }

    const cookie = await getUpstreamCookie(req);
    const params = new URLSearchParams({
      media_ids: mediaId,
      csrf: session.biliJct || "",
    });

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v3/fav/folder/del", {
      method: "POST",
      headers: writeHeaders(cookie, "https://www.bilibili.com/account/fav"),
      body: params.toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.json({ code: data.code, message: data.message || "删除收藏夹失败" });
    }
    res.json({ code: 0 });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "删除收藏夹失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

// 某个收藏夹里的视频(分页)
const FAVORITES_PAGE_SIZE = 20;

app.get("/api/account/favorites/:mediaId", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const mediaId = (req.params.mediaId || "").toString().trim();
  const pn = parseInt(req.query.pn, 10) || 1;

  if (!mediaId) {
    return res.status(400).json({ code: 1, message: "缺少收藏夹 id" });
  }

  try {
    const cookie = await getUpstreamCookie(req);
    const url = new URL("https://api.bilibili.com/x/v3/fav/resource/list");
    url.searchParams.set("media_id", mediaId);
    url.searchParams.set("pn", String(pn));
    url.searchParams.set("ps", String(FAVORITES_PAGE_SIZE));
    url.searchParams.set("platform", "web");

    const biliRes = await fetchWithTimeout(url.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      throw new Error(`获取收藏夹内容失败: ${data.message || data.code}`);
    }

    const list = (data.data?.medias || []).map((m) => ({
      bvid: m.bvid || "",
      // aid 供取消收藏使用(上游 fav/resource/deal 收 avid)。type=2 的条目 m.id 就是 avid;
      // 番剧/课程等条目的 id 不是 avid,给 0 让前端不显示取消按钮
      aid: m.type === 2 ? m.id || 0 : 0,
      // 内容类型,移动/复制要拼 resources={id}:{type}
      type: m.type || 0,
      title: sanitizeTitle(m.title || ""),
      pic: m.cover?.startsWith("//") ? `https:${m.cover}` : m.cover || "",
      author: m.upper?.name || "",
      // 点作者名要跳 /account?mid=,只给名字跳不了
      authorMid: m.upper?.mid || 0,
      pubdate: m.pubtime || 0,
      // 收藏时间:卡片上显示"收藏于 xxx",上游对番剧/课程等条目可能不给,前端据此退化成只显示 UP 名
      favTime: m.fav_time || 0,
      duration: m.duration || 0,
      play: m.cnt_info?.play,
      danmaku: m.cnt_info?.danmaku,
      // attr !== 0 表示视频已失效(被删除/下架),前端据此禁用点击
      valid: (m.attr || 0) === 0,
    }));

    res.json({
      code: 0,
      title: data.data?.info?.title || "",
      mediaCount: data.data?.info?.media_count || 0,
      page: pn,
      hasMore: !!data.data?.has_more,
      list,
    });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取收藏夹内容失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 删除历史记录 / 取消收藏 / 移动复制收藏 -----------------------------
 * 都是"写"操作,直接打到 B 站,不做任何本地记录。
 *   - 删除单条历史: x/v2/history/delete,kid=archive_{aid} + csrf
 *   - 取消收藏:     x/v3/fav/resource/deal,rid={aid}&type=2&del_media_ids={收藏夹id}
 *                   + csrf + WBI 签名
 *   - 移动/复制:    x/v3/fav/resource/{move|copy},src_media_id/tar_media_id/mid/resources
 *                   + csrf + WBI 签名
 * csrf 用登录时存下来的 bili_jct。
 * -------------------------------------------------------------------- */

app.post("/api/account/history/delete", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const aid = parseInt((req.body && req.body.aid) || "", 10);
  if (!aid) return res.status(400).json({ code: 1, message: "缺少 aid 参数" });

  try {
    const cookie = await getUpstreamCookie(req);
    const body = new URLSearchParams({
      kid: `archive_${aid}`,
      csrf: session.biliJct || "",
    });

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v2/history/delete", {
      method: "POST",
      headers: writeHeaders(cookie, "https://www.bilibili.com/account/history"),
      body: body.toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      // 业务失败(没登录/csrf 过期等)如实回一句,前端弹提示
      return res.json({ code: data.code, message: data.message || "删除失败" });
    }
    res.json({ code: 0 });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "删除历史记录失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

app.post("/api/account/favorites/remove", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const aid = parseInt((req.body && req.body.aid) || "", 10);
  const mediaId = ((req.body && req.body.mediaId) || "").toString().trim();
  if (!aid) return res.status(400).json({ code: 1, message: "缺少 aid 参数" });
  if (!mediaId) return res.status(400).json({ code: 1, message: "缺少收藏夹 id" });

  try {
    const cookie = await getUpstreamCookie(req);
    // add_media_ids 留空、del_media_ids 填当前收藏夹 = 只把这个视频从该夹子里移出
    const signedParams = await signWbiParams({
      rid: String(aid),
      type: "2",
      add_media_ids: "",
      del_media_ids: mediaId,
      csrf: session.biliJct || "",
      platform: "web",
    });

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v3/fav/resource/deal", {
      method: "POST",
      headers: writeHeaders(cookie, videoPageUrl(aid)),
      body: new URLSearchParams(signedParams).toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.json({ code: data.code, message: data.message || "取消收藏失败" });
    }
    res.json({ code: 0, data: data.data ?? null });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "取消收藏失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

// 收藏夹之间移动/复制一条内容。两个上游接口参数完全相同,只有路径不同:
// x/v3/fav/resource/{move|copy},收 src_media_id/tar_media_id/mid/resources({内容id}:{内容类型})
// + csrf + WBI 签名。type=2 是视频,非 2 的条目(番剧/课程)上游不收,这里直接挡掉。
app.post("/api/account/favorites/transfer", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const body = req.body || {};
  // 源条目 id:与其它写接口一样叫 aid(视频就是 avid),不是收藏夹 id
  const aid = parseInt(body.aid || "", 10);
  const type = parseInt(body.type || "", 10) || 2;
  const srcMediaId = (body.mediaId || "").toString().trim();
  const tarMediaId = (body.targetMediaId || "").toString().trim();
  // 只认这两个值,别的一律当请求错误
  const action = body.action === "copy" ? "copy" : body.action === "move" ? "move" : "";

  if (!aid) return res.status(400).json({ code: 1, message: "缺少 aid 参数" });
  if (!srcMediaId || !tarMediaId) return res.status(400).json({ code: 1, message: "缺少收藏夹 id" });
  if (!action) return res.status(400).json({ code: 1, message: "缺少操作类型" });
  if (srcMediaId === tarMediaId) {
    return res.status(400).json({ code: 1, message: "不能移动到原收藏夹" });
  }
  if (type !== 2) {
    return res.status(400).json({ code: 1, message: "该类型的内容暂不支持移动/复制" });
  }

  try {
    const own = await assertOwnFavorites(req, res, session, [srcMediaId, tarMediaId]);
    if (own === null) return;
    if (!own) {
      return res.status(400).json({ code: 1, message: "收藏夹不存在或不属于当前账号" });
    }

    const cookie = await getUpstreamCookie(req);
    const signedParams = await signWbiParams({
      src_media_id: srcMediaId,
      tar_media_id: tarMediaId,
      mid: String(session.mid),
      resources: `${aid}:${type}`,
      platform: "web",
      csrf: session.biliJct || "",
    });

    const biliRes = await fetchWithTimeout(`https://api.bilibili.com/x/v3/fav/resource/${action}`, {
      method: "POST",
      headers: writeHeaders(cookie, "https://www.bilibili.com/account/fav"),
      body: new URLSearchParams(signedParams).toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.json({ code: data.code, message: data.message || (action === "move" ? "移动失败" : "复制失败") });
    }
    res.json({ code: 0 });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "操作失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});
/* ----------------------------- 关注列表 / 粉丝列表 -----------------------------
 * 靠可选的 ?mid= 区分: 不带 mid 看自己的列表(/account),带 mid 看别人的(/account?mid=xxx)。
 * 看别人的列表同样要求登录态,对方设了隐私时上游回 22115/22118。
 *   - followings(关注列表): 只需要登录 Cookie
 *   - followers(粉丝列表): 需要 WBI 签名,裸调会返回 -352
 * 列表项的 attribute 表示"当前登录用户是否关注了这个人"(0=未关注 2=已关注 6=互关,
 * 其余如拉黑一律当作未关注),两个列表都靠它决定按钮上的"已关注/+ 关注"。
 * -------------------------------------------------------------------- */
const RELATION_PAGE_SIZE = 20;

// 要查谁的列表:带 ?mid= 就是别人,不带就是自己
function resolveRelationMid(req, session) {
  const mid = parseInt((req.query && req.query.mid) || "", 10);
  return mid > 0 ? mid : session.mid;
}

// 对方的列表被隐私设置挡住时上游给这两个码,其附带的文案是给用户看的有效信息,
// 如实透给前端;其余错误码(风控、未登录等)一律用兜底文案
//   22115 = 关注列表不可见   22118 = 粉丝列表不可见
const RELATION_PRIVACY_CODES = new Set([22115, 22118]);
function relationErrorText(code, message, fallback) {
  if (RELATION_PRIVACY_CODES.has(code)) return message || "对方设置了隐私,无法查看";
  return fallback;
}

function mapRelationUser(u) {
  return {
    mid: u.mid,
    name: u.uname || "",
    avatar: u.face?.startsWith("//") ? `https:${u.face}` : u.face || "",
    sign: u.sign || "",
    isFollowing: u.attribute === 2 || u.attribute === 6,
  };
}

app.get("/api/account/followings", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const pn = parseInt(req.query.pn, 10) || 1;

  try {
    await ensureProfileFields(req, session);
    const vmid = resolveRelationMid(req, session);
    if (!vmid) {
      return res.status(500).json({ code: 1, message: "缺少用户 mid,请重新登录后再试" });
    }

    const cookie = await getUpstreamCookie(req);
    const url = new URL("https://api.bilibili.com/x/relation/followings");
    url.searchParams.set("vmid", String(vmid));
    url.searchParams.set("pn", String(pn));
    url.searchParams.set("ps", String(RELATION_PAGE_SIZE));
    url.searchParams.set("order", "desc");

    const biliRes = await fetchWithTimeout(url.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.status(502).json({
        code: 1,
        message: relationErrorText(data.code, data.message, "获取关注列表失败,请稍后重试"),
      });
    }

    // attribute 是"当前登录用户和这个人的关系": 看自己的关注列表时必然是 2/6,
    // 看别人的关注列表时可能是 0 —— 别人关注了谁不代表我也关注了谁
    const list = (data.data?.list || []).map(mapRelationUser);
    const total = data.data?.total;

    res.json({
      code: 0,
      list,
      hasMore: typeof total === "number" ? pn * RELATION_PAGE_SIZE < total : list.length === RELATION_PAGE_SIZE,
    });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取关注列表失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

app.get("/api/account/followers", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const pn = parseInt(req.query.pn, 10) || 1;

  try {
    await ensureProfileFields(req, session);
    const vmid = resolveRelationMid(req, session);
    if (!vmid) {
      return res.status(500).json({ code: 1, message: "缺少用户 mid,请重新登录后再试" });
    }

    const cookie = await getUpstreamCookie(req);
    const signedParams = await signWbiParams({
      vmid: String(vmid),
      pn: String(pn),
      ps: String(RELATION_PAGE_SIZE),
      order: "desc",
    });
    const url = new URL("https://api.bilibili.com/x/relation/followers");
    Object.entries(signedParams).forEach(([k, v]) => url.searchParams.set(k, v));

    const biliRes = await fetchWithTimeout(url.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.status(502).json({
        code: 1,
        message: relationErrorText(data.code, data.message, "获取粉丝列表失败,请稍后重试"),
      });
    }

    const list = (data.data?.list || []).map(mapRelationUser);
    const total = data.data?.total;

    res.json({
      code: 0,
      list,
      hasMore: typeof total === "number" ? pn * RELATION_PAGE_SIZE < total : list.length === RELATION_PAGE_SIZE,
    });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取粉丝列表失败,请稍后重试", 500);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- WBI 签名 -----------------------------
 * 部分接口需要带 w_rid/wts 签名: 从 nav 接口拿 img_key/sub_key,按固定表重排拼出
 * 32 位混淆 key,再对"排序后的参数 + 混淆 key"取 md5。
 * -------------------------------------------------------------------- */

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

let wbiKeysCache = null;
let wbiKeysFetchedAt = 0;
const WBI_KEYS_TTL_MS = 60 * 60 * 1000; // 官方 key 大约每天变一次,缓存 1 小时足够

async function getWbiKeys() {
  const isFresh = wbiKeysCache && Date.now() - wbiKeysFetchedAt < WBI_KEYS_TTL_MS;
  if (isFresh) return wbiKeysCache;

  const cookie = await ensureCookie();
  const r = await fetchWithTimeout("https://api.bilibili.com/x/web-interface/nav", {
    headers: { ...COMMON_HEADERS, Cookie: cookie },
  });
  const json = await r.json();
  const imgUrl = json.data?.wbi_img?.img_url || "";
  const subUrl = json.data?.wbi_img?.sub_url || "";
  const imgKey = imgUrl.substring(imgUrl.lastIndexOf("/") + 1, imgUrl.lastIndexOf("."));
  const subKey = subUrl.substring(subUrl.lastIndexOf("/") + 1, subUrl.lastIndexOf("."));

  if (!imgKey || !subKey) throw new Error("获取 WBI 签名密钥失败");

  wbiKeysCache = { imgKey, subKey };
  wbiKeysFetchedAt = Date.now();
  return wbiKeysCache;
}

function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  let key = "";
  for (const idx of MIXIN_KEY_ENC_TAB) key += raw[idx] || "";
  return key.slice(0, 32);
}

/* ------------------------- space 系列接口的额外风控参数 -------------------------
 * x/space/wbi/acc/info、x/space/wbi/arc/search 除了 WBI 签名之外,还会校验一组
 * 设备指纹参数 dm_img_*,缺了就返回 -352 或被 WAF 挡成 412。这四个值就是网页端上报的内容:
 *   dm_img_list      鼠标轨迹(空数组即可)
 *   dm_img_str       base64 的 WebGL 版本串
 *   dm_cover_img_str base64 的显卡型号串
 *   dm_img_inter     交互统计
 * 另外 platform / web_location 是来源标记,order_avoided 让排序走"未被风控降级"的分支。
 * -------------------------------------------------------------------- */
const SPACE_DM_PARAMS = {
  dm_img_list: "[]",
  dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
  dm_cover_img_str:
    "QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKEludGVsKQ",
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  platform: "web",
  web_location: "1550101",
};

// space 系列接口的带签名请求: 自动补设备指纹参数、带 space Referer。
// 被 WAF 拦下(典型是 412 的 HTML 页面)时退避重试,412 立即放弃(重试只会延长封锁),
// 其余失败按 600ms/1200ms 退避。拿不到就是拿不到,由上层把原因如实告诉前端
async function fetchSpaceSigned(url, params, cookie, retries = 2) {
  const signedParams = await signWbiParams({ ...SPACE_DM_PARAMS, ...params });
  const target = new URL(url);
  Object.entries(signedParams).forEach(([k, v]) => target.searchParams.set(k, v));

  const headers = {
    ...COMMON_HEADERS,
    // space 系列接口对 Referer 更敏感,补成该 UP 的空间页
    Referer: `https://space.bilibili.com/${params.mid || ""}/`,
    Cookie: cookie,
  };

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(600 * attempt);

    try {
      const r = await fetchWithTimeout(target.toString(), { headers });
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch {
        // 非 JSON: 被 WAF 拦下(典型是 412 的 HTML 拦截页)。412 是明确的限流信号,
        // 重试只会让封锁更久,立刻跳出;真实状态码挂在 err.http 上供上层区分
        lastErr = Object.assign(new Error(`请求被 B 站拦截(HTTP ${r.status})`), {
          code: r.status === 412 ? 412 : -352,
          http: r.status,
        });
        if (r.status === 412) break;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 把 space 系列接口的错误码翻译成人话: 风控相关的 -352/-799/412 合并成同一句,
// 不暴露上游错误码,也不提示具体等待时长(上游限流窗口不固定)
function spaceErrorText(code, fallback) {
  switch (code) {
    case -101:
      return "请先登录 B 站账号";
    case -352:
    case -799:
    case 412:
      return "加载失败,请稍后重试";
    case -404:
      return "该用户不存在";
    default:
      return fallback || "加载失败,请稍后重试";
  }
}

// 给参数对象加上 wts/w_rid 签名,返回新对象(不修改传入的原对象)
async function signWbiParams(params) {
  const { imgKey, subKey } = await getWbiKeys();
  const mixinKey = getMixinKey(imgKey, subKey);

  const wts = Math.floor(Date.now() / 1000);
  const signedParams = { ...params, wts };

  const query = Object.keys(signedParams)
    .sort()
    .map((key) => {
      // 官方算法要求先把值里的 ! ' ( ) * 这几个字符过滤掉,再做 urlencode
      const value = String(signedParams[key]).replace(/[!'()*]/g, "");
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join("&");

  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");

  return { ...signedParams, w_rid: wRid };
}

/* ----------------------------- 搜索接口 ----------------------------- */

// 标题字段统一在这里处理: 上游标题里唯一有用的 HTML 是搜索接口的关键词高亮
// <em class="keyword">…</em>,其余内容整体转义,结果可直接拼进 innerHTML。
// 用占位符保住成对的高亮标签,是因为直接删标签会吃掉正文(如 "i<j>k" 变成 "i k"),
// 而残留的裸 "<" 会被浏览器当标签开头,把后面的 DOM 一起吞掉
function sanitizeTitle(raw) {
  if (!raw) return "";

  const EM_OPEN = "\u0000O\u0000";
  const EM_CLOSE = "\u0000C\u0000";

  const escaped = String(raw)
    .replace(/<em class="keyword">/g, EM_OPEN)
    .replace(/<\/em>/g, EM_CLOSE)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 上游偶尔只给半截 <em class="keyword">(没有配对的 </em>): 还原成真标签等于把没闭合的
  // 标签塞给前端,照样会吞掉后面的 </div>,所以不配对时连高亮一起当普通文本转义
  if (escaped.split(EM_OPEN).length !== escaped.split(EM_CLOSE).length) {
    return escaped
      .replace(/\u0000O\u0000/g, "&lt;em&gt;")
      .replace(/\u0000C\u0000/g, "&lt;/em&gt;");
  }

  return escaped
    .replace(/\u0000O\u0000/g, '<em class="keyword">')
    .replace(/\u0000C\u0000/g, "</em>");
}

// B 站支持的排序方式,order 为空字符串时表示默认的"综合排序"
const VALID_ORDERS = new Set(["", "totalrank", "click", "pubdate", "dm", "stow", "scores"]);

const SEARCH_TYPES = new Set(["video", "user"]);

// 用户搜索的排序与分类,取值为上游定义的枚举(空字符串表示默认排序)
const VALID_USER_ORDERS = new Set(["", "0", "fans", "level"]);
// 全部用户 / UP 主用户 / 普通用户 / 认证用户
const VALID_USER_TYPES = new Set(["0", "1", "2", "3"]);

// 一次搜索里最多同时查几个 UP 主的关注状态,避免 20 条结果同时打上游
const FOLLOW_STATE_CONCURRENCY = 8;

/* ----------------------------- 弹幕解析辅助 -----------------------------
 * 弹幕 p 属性: 出现时间,模式,字号,颜色,发送时间戳,弹幕池,发送者hash,rowid
 * 模式: 1/2/3 滚动, 4 底部, 5 顶部, 6 逆向滚动, 7 精确定位, 8 脚本弹幕;
 * 这里只做基础展示,7/8 也统一按滚动处理。
 * -------------------------------------------------------------------- */

const DANMAKU_MODE_MAP = { 1: 0, 2: 0, 3: 0, 4: 2, 5: 1, 6: 0, 7: 0, 8: 0 };
const DANMAKU_MAX_COUNT = 6000; // 避免弹幕过多导致前端卡顿,超出时按间隔抽样

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseDanmakuXml(xml) {
  const list = [];
  const regex = /<d p="([^"]+)">([\s\S]*?)<\/d>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const attrs = match[1].split(",");
    const text = decodeXmlEntities(match[2]).trim();
    if (!text) continue;

    const time = parseFloat(attrs[0]) || 0;
    const biliMode = parseInt(attrs[1], 10) || 1;
    const colorDec = parseInt(attrs[3], 10);
    const color = "#" + (Number.isFinite(colorDec) ? colorDec : 0xffffff).toString(16).padStart(6, "0");
    const mode = DANMAKU_MODE_MAP[biliMode] ?? 0;

    list.push({ text, time, color, mode });
  }

  list.sort((a, b) => a.time - b.time);

  if (list.length <= DANMAKU_MAX_COUNT) return list;

  // 数量过多时按固定间隔抽样,尽量保留整体时间分布
  const step = list.length / DANMAKU_MAX_COUNT;
  const sampled = [];
  for (let i = 0; i < DANMAKU_MAX_COUNT; i++) {
    sampled.push(list[Math.floor(i * step)]);
  }
  return sampled;
}

/* ----------------------------- 搜索接口 -----------------------------
 * search_type=video 搜索视频,search_type=user 搜索用户,两者共用上游同一个
 * x/web-interface/search/type。两者的排序参数不是一套: 视频用 order=totalrank/click/...,
 * 用户用 order=0/fans/level 配 order_sort(0 由高到低,1 由低到高),user_type 则是
 * 用户搜索的分类筛选。登录时额外补一批"是否已关注",供结果里的关注按钮用。
 * -------------------------------------------------------------------- */
app.get("/api/search", async (req, res) => {
  const keyword = (req.query.keyword || "").toString().trim();
  const page = parseInt(req.query.page, 10) || 1;
  let type = (req.query.type || "").toString().trim();
  if (!SEARCH_TYPES.has(type)) type = "video";

  // 排序方式,非法值一律回退成默认排序
  let order = (req.query.order || "").toString().trim();
  if (!VALID_ORDERS.has(order)) order = "";

  let userOrder = (req.query.userOrder || "").toString().trim();
  if (!VALID_USER_ORDERS.has(userOrder)) userOrder = "";

  let orderSort = (req.query.orderSort || "").toString().trim();
  if (orderSort !== "0" && orderSort !== "1") orderSort = "0";

  let userType = (req.query.userType || "").toString().trim();
  if (!VALID_USER_TYPES.has(userType)) userType = "1";

  if (!keyword) {
    return res.status(400).json({ error: "缺少 keyword 参数" });
  }

  try {
    const cookie = await getUpstreamCookie(req);

    const url = new URL(
      "https://api.bilibili.com/x/web-interface/search/type"
    );
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("search_type", type === "user" ? "bili_user" : "video");
    url.searchParams.set("page", String(page));
    if (type === "user") {
      url.searchParams.set("user_type", userType);
      if (userOrder) {
        url.searchParams.set("order", userOrder);
        url.searchParams.set("order_sort", orderSort);
      }
    } else if (order) {
      url.searchParams.set("order", order);
    }

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: {
        ...COMMON_HEADERS,
        Cookie: cookie,
      },
    });

    const data = await biliRes.json();

    if (data.code !== 0) {
      return res
        .status(502)
        .json({ error: `B 站接口返回错误: ${data.message || data.code}` });
    }

    const raw = data.data?.result || [];
    let list;

    if (type === "user") {
      const session = getSession(req, false);
      const selfMid = isLoggedIn(session) ? session.mid : null;
      const followStates = await fetchFollowStates(
        req,
        raw.map((item) => item.mid),
        selfMid
      );

      list = raw.map((item) => ({
        mid: item.mid,
        name: sanitizeTitle(item.uname),
        sign: sanitizeTitle(item.usign),
        avatar: item.upic?.startsWith("//") ? `https:${item.upic}` : item.upic,
        fans: item.fans,
        videos: item.videos,
        level: item.level,
        verify: item.official_verify?.desc || "",
        isSelf: !!(selfMid && String(selfMid) === String(item.mid)),
        isFollowing: followStates.get(String(item.mid)) || false,
      }));
    } else {
      list = raw.map((item) => ({
        bvid: item.bvid,
        title: sanitizeTitle(item.title),
        author: item.author,
        authorMid: item.mid || 0,
        pic: item.pic?.startsWith("//") ? `https:${item.pic}` : item.pic,
        play: item.play,
        danmaku: item.video_review,
        duration: item.duration,
        pubdate: item.pubdate,
        description: item.description,
      }));
    }

    res.json({
      type,
      total: data.data?.numResults || 0,
      totalPages: data.data?.numPages || 1,
      page,
      list,
    });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "代理请求失败,请稍后重试", 500);
    res.status(status).json({ error: message });
  }
});

/* ----------------------------- 搜索建议接口 -----------------------------
 * 数据源: s.search.bilibili.com/main/suggest,输入框联想词,最多 10 条,
 * 按相关程度与热度排序。该接口在 s.search 子域下,不需要 WBI 签名,
 * 但同样校验 Referer 与匿名 cookie,所以必须由服务端转发。
 * 上游返回的 name 含官方高亮标签,只透传 value/name 两个字段,
 * 前端只认 <em class="suggest_high_light">,其余标签一律过滤。
 * 返回结构: { code: 0, list: [{ value, name }] }。
 * -------------------------------------------------------------------- */

// 上游对超长输入没有意义,限长避免把无意义的超长 query 原样打到上游
const SUGGEST_MAX_TERM_LENGTH = 100;
// JSONP 包裹形如 callback({...}); 用于兜底剥离
const SUGGEST_JSONP_RE = /^[A-Za-z_$][\w$]*\(([\s\S]*)\);?\s*$/;

app.get("/api/suggest", async (req, res) => {
  const term = (req.query.term || "").toString().trim().slice(0, SUGGEST_MAX_TERM_LENGTH);
  if (!term) return res.status(400).json({ code: 1, message: "缺少 term 参数" });

  try {
    const cookie = await getUpstreamCookie(req);

    const params = new URLSearchParams({
      term,
      main_ver: "v1",
      highlight: "",
      func: "suggest",
      suggest_type: "accurate",
      sub_type: "tag",
      tag_num: "10",
      // 官方前端每次都会带一个随机数,跟着带上更接近真实网页请求
      rnd: Math.random().toString(),
      spmid: "333.1007",
    });

    const biliRes = await fetchWithTimeout(
      `https://s.search.bilibili.com/main/suggest?${params.toString()}`,
      {
        headers: {
          ...COMMON_HEADERS,
          // 这个子域对来源更敏感,Referer 指回搜索页
          Referer: "https://search.bilibili.com/",
          Cookie: cookie,
        },
      }
    );

    const text = await biliRes.text();

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      const matched = SUGGEST_JSONP_RE.exec(text.trim());
      if (!matched) {
        // 被 WAF 挡下时会返回 HTML 拦截页,这里当作上游异常处理
        throw Object.assign(new Error("搜索建议接口返回的不是 JSON"), { userMessage: "搜索建议加载失败" });
      }
      data = JSON.parse(matched[1]);
    }

    if (data.code !== 0) {
      return res.status(502).json({
        code: data.code,
        message: "搜索建议加载失败",
      });
    }

    const tags = (data.result && data.result.tag) || [];
    const list = (Array.isArray(tags) ? tags : [])
      .map((item) => ({
        value: String(item?.value || "").trim(),
        name: String(item?.name || ""),
      }))
      .filter((item) => item.value);

    res.json({ code: 0, list });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "搜索建议加载失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 相关视频推荐接口 -----------------------------
 * 数据源: x/web-interface/archive/related,按传入的 bvid/aid 返回 B 站官方计算的
 * 相关视频列表(非个性化,不需要登录/WBI),播放页用它填充"相关推荐"。
 * -------------------------------------------------------------------- */

app.get("/api/related", async (req, res) => {
  const bvid = (req.query.bv || "").toString().trim();
  const aidRaw = (req.query.av || "").toString().trim();
  const aid = aidRaw ? parseInt(aidRaw, 10) : 0;

  if (!bvid && !aid) {
    return res.status(400).json({ error: "缺少 bv 或 av 参数" });
  }

  try {
    const cookie = await getUpstreamCookie(req);

    const url = new URL("https://api.bilibili.com/x/web-interface/archive/related");
    if (bvid) url.searchParams.set("bvid", bvid);
    if (aid) url.searchParams.set("aid", String(aid));

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });

    const data = await biliRes.json();

    if (data.code !== 0) {
      return res
        .status(502)
        .json({ error: `B 站接口返回错误: ${data.message || data.code}` });
    }

    const list = (data.data || []).map((item) => ({
      bvid: item.bvid,
      title: sanitizeTitle(item.title),
      author: item.owner?.name,
      authorMid: item.owner?.mid || 0,
      pic: item.pic?.startsWith("//") ? `https:${item.pic}` : item.pic,
      play: item.stat?.view,
      danmaku: item.stat?.danmaku,
      duration: item.duration,
      pubdate: item.pubdate,
      description: item.desc,
    }));

    res.json({ list });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取相关推荐失败,请稍后重试", 500);
    res.status(status).json({ error: message });
  }
});

/* ----------------------------- 弹幕接口 -----------------------------
 * 数据源: 传统弹幕 XML 接口 x/v1/dm/list.so,匿名可访问。
 * 只需要 cid(/api/play 返回结果里已带)。
 * 弹幕量极大的视频可能拿不到全量,且超出 DANMAKU_MAX_COUNT 时会抽样,避免前端渲染卡顿。
 * -------------------------------------------------------------------- */

app.get("/api/danmaku", async (req, res) => {
  const cid = (req.query.cid || "").toString().trim();

  if (!cid) {
    return res.status(400).json({ error: "缺少 cid 参数" });
  }

  try {
    const cookie = await getUpstreamCookie(req);
    const url = `https://api.bilibili.com/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`;

    const biliRes = await fetchWithTimeout(url, {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });
    const xml = await biliRes.text();
    const list = parseDanmakuXml(xml);

    res.json({ total: list.length, list });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取弹幕失败,请稍后重试", 500);
    res.status(status).json({ error: message });
  }
});

/* ----------------------------- 评论接口 -----------------------------
 * 数据源: x/v2/reply/wbi/main,需要 WBI 签名,匿名/登录都能调。
 * 相比老的 x/v2/reply,新接口没有缓存延迟,刚发出的评论能立刻出现在列表里。
 * 参数映射(实测得出): mode=3 → 按热度(前端 sort=2,默认);mode=2 → 按时间(sort=0)
 * 翻页用游标: 第一页 next=0,之后原样回传上一页的 cursor.next
 * (热度序 next 是页码,时间序 next 是偏移量)。
 * seek_rpid 传自己刚发的评论 rpid,上游会把它插到第一页最前面。
 * 该接口按数字 av 号查询(type=1 时 oid 必须是 aid),前端需先取 /api/info 的 aid。
 * 新接口报错时退回老的 pn 分页,响应里带 fallback: true。
 * -------------------------------------------------------------------- */

const COMMENT_PAGE_SIZE = 20;
const VALID_COMMENT_SORTS = new Set(["0", "2"]); // 0 = 按时间, 2 = 按热度(默认)
const COMMENT_MODE_BY_SORT = { "2": "3", "0": "2" };
const COMMENT_WEB_LOCATION = "1315875"; // 官网评论区请求里的来源标记,一起带上更稳

// 上游一条评论 → 前端要的字段,主评论和楼层回复共用(main 多一个 rcount)。
// liked 取 item.action: 0=没点过 1=已点赞 2=已点踩,只有登录态下才有值。
// 昵称/正文原样透传,由前端 escapeHtml 转义;不能走 sanitizeTitle 的标题清洗规则,
// 评论里贴代码时孤立的 "<" 会被当标签开头,冲垮后面的 DOM 结构

// 评论文本/图片地址里的 HTML 实体还原: 新接口给原始字符,老接口(兜底、楼层回复、
// 发评论回包)给的是 "&#34;" "&lt;" 这类实体,不还原就会被前端 escapeHtml 再转义一次,
// 页面上显示成乱码,图片地址里的 "&amp;" 还会把查询参数拼坏
const HTML_ENTITY_NAMES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeHtmlEntities(raw) {
  return String(raw == null ? "" : raw).replace(
    /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (whole, body) => {
      if (body[0] === "#") {
        const isHex = body[1] === "x" || body[1] === "X";
        const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        // 非法码点(越界/解析失败)原样保留,别把内容吃掉
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
        return String.fromCodePoint(code);
      }
      const named = HTML_ENTITY_NAMES[body.toLowerCase()];
      return named === undefined ? whole : named;
    }
  );
}

// 图片地址统一成绝对 https: 上游常给 "//i0.hdslb.com/..." 甚至 http:// 的地址,
// 原样塞进 <img src> 会被 https 页面的混合内容策略拦掉
function normalizeImgUrl(raw) {
  const s = decodeHtmlEntities(raw).trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  return s.replace(/^http:\/\//i, "https://");
}

// 评论正文里的表情(表情转义符 → 图片): 上游把用到的表情放在 content.emote,
// key 是正文里的占位符(形如 "[doge]"),值为 { text, url, meta.size };
// 个别新结构是 content.emoji 数组,两种都兼容。动图表情只有 gif_url 是全动态的,优先取。
// 返回 { 表情名: { url, size } },表情名去掉方括号,size 取 meta.size(1=小 2=大)
function mapReplyEmoji(content) {
  const out = {};
  const put = (rawName, url, gifUrl, size) => {
    const name = decodeHtmlEntities(rawName).replace(/^\[|\]$/g, "");
    const src = normalizeImgUrl(gifUrl || url);
    if (!name || !src || out[name]) return;
    out[name] = { url: src, size: size === 2 ? 2 : 1 };
  };

  for (const e of content?.emoji || []) {
    put(e?.emoji_name || e?.text, e?.url, e?.gif_url, e?.meta?.size);
  }
  const emote = content?.emote;
  if (emote && typeof emote === "object") {
    for (const [key, e] of Object.entries(emote)) {
      put(e?.text || key, e?.url, e?.gif_url, e?.meta?.size);
    }
  }
  return out;
}

// 评论附图: content.pictures,元素为 { img_src, img_width, img_height, img_size }。
// 宽高一起带上,前端可给 <img> 写 width/height 占位,图片未加载完时不会跳一下
function mapReplyPictures(content) {
  return (content?.pictures || [])
    .map((p) => ({
      src: normalizeImgUrl(p?.img_src),
      width: Number(p?.img_width) || 0,
      height: Number(p?.img_height) || 0,
    }))
    .filter((p) => p.src);
}

// 评论正文里 @ 到的人: content.members 是被 @ 用户的 member 对象数组。
// 只留 mid/uname: 前端用 uname 把正文里的 "@昵称" 标蓝,mid 留给后续"点名字看主页"
function mapReplyMembers(content) {
  return (content?.members || [])
    .map((m) => ({ mid: String(m?.mid ?? ""), uname: decodeHtmlEntities(m?.uname || "") }))
    .filter((m) => m.mid && m.uname);
}

// 置顶评论: 新接口放在 data.top 下的 upper/admin/vote,老接口放在 data.upper.top,
// 三者互斥,取到哪个算哪个
function pickTopReply(data) {
  return data?.top?.upper || data?.top?.admin || data?.top?.vote || data?.upper?.top || null;
}

function mapComment(item) {
  const content = item.content || {};
  return {
    rpid: item.rpid,
    mid: item.member?.mid || 0,
    // 昵称/正文先还原实体,统一成纯文本,由前端 escapeHtml 负责转义
    uname: decodeHtmlEntities(item.member?.uname || ""),
    avatar: normalizeImgUrl(item.member?.avatar),
    message: decodeHtmlEntities(content.message || ""),
    // 表情占位符 + 附图 + @ 到的人,交给前端 renderCommentContent 渲染
    emoji: mapReplyEmoji(content),
    pictures: mapReplyPictures(content),
    members: mapReplyMembers(content),
    like: item.like || 0,
    liked: item.action === 1,
    rcount: item.rcount || 0,
    ctime: item.ctime || 0,
  };
}

app.get("/api/reply", async (req, res) => {
  const oidRaw = (req.query.oid || "").toString().trim();
  const oid = oidRaw ? parseInt(oidRaw, 10) : 0;
  const pn = parseInt(req.query.pn, 10) || 1; // 只在退回老接口时用
  const next = parseInt(req.query.next, 10) || 0; // 新接口游标,第一页传 0
  const seekRpid = (req.query.seek_rpid || "").toString().trim();

  let sort = (req.query.sort || "").toString().trim();
  if (!VALID_COMMENT_SORTS.has(sort)) sort = "2";

  if (!oid) {
    return res.status(400).json({ error: "缺少 oid 参数(需要数字 av 号,可从 /api/info 的 aid 字段获取)" });
  }

  const cookie = await getUpstreamCookie(req);

  // 主路径: 官网同款新接口。报错/被风控才往下走老接口兜底。
  try {
    const params = {
      oid: String(oid),
      type: "1",
      mode: COMMENT_MODE_BY_SORT[sort],
      next: String(next),
      ps: String(COMMENT_PAGE_SIZE),
      web_location: COMMENT_WEB_LOCATION,
    };
    // 只在自己刚发过评论、且是第一页时带上,让那条评论稳定出现在最前面
    if (seekRpid && next === 0) params.seek_rpid = seekRpid;

    const signed = await signWbiParams(params);
    const url = new URL("https://api.bilibili.com/x/v2/reply/wbi/main");
    for (const [key, value] of Object.entries(signed)) url.searchParams.set(key, String(value));

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });

    const data = await biliRes.json();

    if (data.code === 0) {
      const cursor = data.data?.cursor || {};
      // 置顶评论只在第一页给(后面几页重复带同一条没意义)
      const topItem = next === 0 ? pickTopReply(data.data) : null;
      return res.json({
        total: cursor.all_count || 0,
        next: typeof cursor.next === "number" ? cursor.next : 0,
        isEnd: !!cursor.is_end,
        fallback: false,
        top: topItem ? mapComment(topItem) : null,
        list: (data.data?.replies || []).map(mapComment),
      });
    }
    console.warn(`新评论接口返回错误,退回旧接口: ${data.code} ${data.message || ""}`);
  } catch (err) {
    console.warn(`新评论接口调用失败,退回旧接口: ${err.message}`);
  }

  // 兜底路径: 老接口。列表有缓存延迟,但至少能保证评论区打得开。
  try {
    const url = new URL("https://api.bilibili.com/x/v2/reply");
    url.searchParams.set("type", "1"); // 1 = 视频
    url.searchParams.set("oid", String(oid));
    url.searchParams.set("pn", String(pn));
    url.searchParams.set("ps", String(COMMENT_PAGE_SIZE));
    url.searchParams.set("sort", sort);

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });

    const data = await biliRes.json();

    if (data.code !== 0) {
      return res
        .status(502)
        .json({ error: `B 站接口返回错误: ${data.message || data.code}` });
    }

    // replies 在没有评论或被风控时可能是 null,统一兜底成空数组
    const list = (data.data?.replies || []).map(mapComment);
    const total = data.data?.page?.count || 0;
    // 置顶评论同样只在第一页给
    const topItem = pn === 1 ? pickTopReply(data.data) : null;

    res.json({
      total,
      next: 0,
      isEnd: list.length < COMMENT_PAGE_SIZE || pn * COMMENT_PAGE_SIZE >= total,
      fallback: true,
      top: topItem ? mapComment(topItem) : null,
      list,
    });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取评论失败,请稍后重试", 500);
    res.status(status).json({ error: message });
  }
});

/* ------------------------- 评论楼层回复(子评论)接口 -------------------------
 * 数据源: x/v2/reply/reply,匿名可访问。root 传楼层根评论的 rpid
 * (即 /api/reply 返回列表里每条评论的 rpid)。评论区默认收起回复,点"展开"后按页加载。
 * -------------------------------------------------------------------- */

const SUB_REPLY_PAGE_SIZE = 10;

app.get("/api/reply/replies", async (req, res) => {
  const oidRaw = (req.query.oid || "").toString().trim();
  const oid = oidRaw ? parseInt(oidRaw, 10) : 0;
  const rootRaw = (req.query.root || "").toString().trim();
  const root = rootRaw ? parseInt(rootRaw, 10) : 0;
  const pn = parseInt(req.query.pn, 10) || 1;

  if (!oid || !root) {
    return res
      .status(400)
      .json({ error: "缺少 oid 或 root 参数(root 为楼层评论的 rpid,可从 /api/reply 返回列表获取)" });
  }

  try {
    const cookie = await getUpstreamCookie(req);

    const url = new URL("https://api.bilibili.com/x/v2/reply/reply");
    url.searchParams.set("type", "1"); // 1 = 视频
    url.searchParams.set("oid", String(oid));
    url.searchParams.set("root", String(root));
    url.searchParams.set("pn", String(pn));
    url.searchParams.set("ps", String(SUB_REPLY_PAGE_SIZE));

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });

    const data = await biliRes.json();

    if (data.code !== 0) {
      return res
        .status(502)
        .json({ error: `B 站接口返回错误: ${data.message || data.code}` });
    }

    // replies 在没有回复或被风控时可能是 null,统一兜底成空数组
    const list = (data.data?.replies || []).map(mapComment);

    res.json({
      total: data.data?.page?.count || 0,
      page: data.data?.page?.num || pn,
      pageSize: data.data?.page?.size || SUB_REPLY_PAGE_SIZE,
      list,
    });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取楼层回复失败,请稍后重试", 500);
    res.status(status).json({ error: message });
  }
});

/* ------------------------- 发表评论 / 评论点赞 -------------------------
 *   - 发评论: x/v2/reply/add    参数 oid={aid}&type=1&message=...&csrf=...
 *             @ 提及另外带 at_name_to_mid={"昵称":mid}(见 buildReplyAtMap);
 *             回复某条评论时加 root/parent(都填被回复那条主评论的 rpid;
 *             回复楼中楼时 root 填楼层根评论、parent 填被回复的子评论)
 *   - 点赞:   x/v2/reply/action 参数 oid&type=1&rpid&action(1=点赞 0=取消)&csrf
 * 都需要登录 Cookie + CSRF,不需要 WBI。发成功后把上游返回的那条评论映射回前端,
 * 前端可直接插进列表,不用整页重拉。
 * -------------------------------------------------------------------- */

const REPLY_MAX_LENGTH = 1000;
const REPLY_MAX_PICTURES = 9; // 和网页端一致: 一条评论最多 9 张图
const REPLY_MAX_MEMBERS = 20; // @ 提及的人上限,只为挡脏数据

// 评论附图的参数格式: pictures 是 JSON 数组,元素字段与 content.pictures 的对象一一对应
// (img_src/img_width/img_height/img_size)。只认这些字段,顺带挡掉空地址/超量等脏数据
function buildReplyPictures(raw) {
  if (!Array.isArray(raw)) return null;
  const list = raw
    .map((p) => ({
      img_src: normalizeImgUrl(p?.src),
      img_width: parseInt(p?.width, 10) || 0,
      img_height: parseInt(p?.height, 10) || 0,
      img_size: Number(p?.size) || 0,
    }))
    .filter((p) => p.img_src)
    .slice(0, REPLY_MAX_PICTURES);
  return list.length ? JSON.stringify(list) : null;
}

// 评论里的 @ 提及: at_name_to_mid 是 {"昵称": mid} 的 JSON(键名不带 @)。
// 只发正文上游不认,必须带这张表才会在 content.members 里回填
function buildReplyAtMap(raw) {
  if (!Array.isArray(raw)) return null;
  const map = {};
  for (const item of raw.slice(0, REPLY_MAX_MEMBERS)) {
    const mid = parseInt(item?.mid, 10);
    const uname = (item?.uname || "").toString().trim();
    if (mid && uname) map[uname] = mid;
  }
  return Object.keys(map).length ? JSON.stringify(map) : null;
}

app.post("/api/reply/add", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const oid = parseInt((req.body && req.body.oid) || "", 10);
  const message = ((req.body && req.body.message) || "").toString().trim();
  const root = ((req.body && req.body.root) || "").toString().trim();
  const parent = ((req.body && req.body.parent) || "").toString().trim() || root;
  const pictures = buildReplyPictures(req.body && req.body.pictures);
  const atMap = buildReplyAtMap(req.body && req.body.atMentions);

  if (!oid) return res.status(400).json({ code: 1, message: "缺少 oid 参数" });
  // 只发图不写字是允许的,所以有图时不要求正文非空
  if (!message && !pictures) return res.status(400).json({ code: 1, message: "评论内容不能为空" });
  if (message.length > REPLY_MAX_LENGTH) {
    return res.status(400).json({ code: 1, message: `评论最多 ${REPLY_MAX_LENGTH} 个字` });
  }

  try {
    const cookie = await getUpstreamCookie(req);
    const body = new URLSearchParams({
      oid: String(oid),
      type: "1",
      message,
      plat: "1", // 和网页端一样标一下来源平台
      csrf: session.biliJct || "",
    });
    // 有 root 就是"回复某条评论",没有就是发一条新的主评论
    if (root) {
      body.set("root", root);
      body.set("parent", parent);
    }
    if (pictures) body.set("pictures", pictures);
    // 正文里 @ 到的人要靠这张表,上游才会在 content.members 里回填
    if (atMap) body.set("at_name_to_mid", atMap);

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v2/reply/add", {
      method: "POST",
      headers: writeHeaders(cookie, videoPageUrl(oid)),
      body: body.toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      // 业务失败(未登录/CSRF 过期/被风控/内容不合规)把上游那句话透出去,前端直接展示
      return res.json({ code: data.code, message: data.message || "发送失败" });
    }

    res.json({
      code: 0,
      // 上游通常在 data.reply 里回带刚发出去的那条;没有就只能让前端自己重拉。
      // rpid 单独给一份: 前端要拿它当 seek_rpid 用,把这条评论顶到列表最前面。
      rpid: data.data?.rpid ? String(data.data.rpid) : "",
      reply: data.data?.reply ? mapComment(data.data.reply) : null,
    });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "发送失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

app.post("/api/reply/like", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const oid = parseInt((req.body && req.body.oid) || "", 10);
  const rpid = ((req.body && req.body.rpid) || "").toString().trim();
  const like = !!(req.body && req.body.like);

  if (!oid) return res.status(400).json({ code: 1, message: "缺少 oid 参数" });
  if (!rpid) return res.status(400).json({ code: 1, message: "缺少 rpid 参数" });

  try {
    const cookie = await getUpstreamCookie(req);
    const body = new URLSearchParams({
      oid: String(oid),
      type: "1",
      rpid,
      action: like ? "1" : "0", // 1=点赞 0=取消
      csrf: session.biliJct || "",
    });

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v2/reply/action", {
      method: "POST",
      headers: writeHeaders(cookie, videoPageUrl(oid)),
      body: body.toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.json({ code: data.code, message: data.message || (like ? "点赞失败" : "取消点赞失败") });
    }
    res.json({ code: 0 });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "评论点赞失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- @ 提及候选列表 -----------------------------
 * 数据源: x/polymer/web-dynamic/v1/mention/search,即评论框/动态输入框里打 "@" 的联想接口。
 * 必须带登录 Cookie: 匿名调用直接回 -101。上游按分组返回("最近联系"/"我的关注"/"其他"),
 * 这里拍平成一个列表: 分组名带给前端当小标题,followed 标出关注的人。
 * 不带 keyword 时上游回的就是"最近联系"+"我的关注",即面板打开时的初始候选。
 * -------------------------------------------------------------------- */

app.get("/api/reply/at", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const keyword = ((req.query && req.query.keyword) || "").toString().trim();

  try {
    const cookie = await getUpstreamCookie(req);
    const url = new URL("https://api.bilibili.com/x/polymer/web-dynamic/v1/mention/search");
    if (keyword) url.searchParams.set("keyword", keyword);

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });
    const data = await upstreamJson(biliRes, "@ 搜索接口");

    if (replyIfUnauthorized(req, res, data)) return;
    if (data.code !== 0) {
      return res.status(502).json({ code: 1, message: `@ 搜索失败: ${data.message || data.code}` });
    }

    const list = [];
    for (const group of data.data?.groups || []) {
      for (const it of group.items || []) {
        const uid = ((it && it.uid) || "").toString().trim();
        const name = decodeHtmlEntities(it?.name || "");
        if (!uid || !name) continue;
        list.push({
          mid: uid,
          name,
          avatar: normalizeImgUrl(it?.face),
          fans: it?.fans || 0,
          // official_verify_type: 0 个人认证 1 机构认证 -1 无
          verify: Number(it?.official_verify_type) > -1,
          followed: group.group_type === 2, // 2 = 我的关注
          group: group.group_name || "",
        });
      }
    }

    res.json({ code: 0, list });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "@ 搜索失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 评论附图上传 -----------------------------
 * 数据源: x/dynamic/feed/draw/upload_bfs,即传动态图/评论图用的接口,
 * 返回图片地址 + 宽高 + 大小(KB)。前端把图片二进制原样 POST 过来(Content-Type 即文件类型),
 * 这里不做二次编码,直接用 FormData 转给上游;体积上限由 express.raw 的 limit 兜住。
 * -------------------------------------------------------------------- */

const REPLY_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"];
const REPLY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

app.post(
  "/api/reply/upload",
  express.raw({ type: REPLY_IMAGE_TYPES, limit: REPLY_IMAGE_MAX_BYTES }),
  async (req, res) => {
    const session = requireLogin(req, res);
    if (!session) return;

    const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!REPLY_IMAGE_TYPES.includes(contentType)) {
      return res.status(400).json({ code: 1, message: "只支持 jpg / png / gif 图片" });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ code: 1, message: "没有读到图片内容" });
    }

    try {
      const cookie = await getUpstreamCookie(req);
      const fd = new FormData();
      fd.append("file_up", new Blob([req.body], { type: contentType }), "image");
      fd.append("category", "daily");
      fd.append("biz", "new_dyn");
      fd.append("csrf", session.biliJct || "");

      const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs", {
        method: "POST",
        // Referer/Origin 用动态页: 该接口的防盗链按动态场景校验
        headers: {
          "User-Agent": COMMON_HEADERS["User-Agent"],
          Referer: "https://t.bilibili.com/",
          Origin: "https://t.bilibili.com",
          Cookie: cookie,
        },
        body: fd,
      });
      const data = await upstreamJson(biliRes, "图片上传接口");

      if (replyIfUnauthorized(req, res, data)) return;
      if (data.code !== 0) {
        return res.json({ code: data.code, message: data.message || "图片上传失败" });
      }

      const imgUrl = normalizeImgUrl(data.data?.image_url || data.data?.img_url);
      if (!imgUrl) return res.status(502).json({ code: 1, message: "图片上传失败: 上游未返回图片地址" });

      res.json({
        code: 0,
        url: imgUrl,
        width: Number(data.data?.image_width) || 0,
        height: Number(data.data?.image_height) || 0,
        // img_size 上游给的就是 KB;缺字段时按字节数折算一个近似值
        size: Number(data.data?.img_size) || Math.round(req.body.length / 1024),
      });
    } catch (err) {
      console.error(err);
      const { status, message } = buildErrorResponse(err, "图片上传失败,请稍后重试", 502);
      res.status(status).json({ code: 1, message });
    }
  }
);

/* --------------------------- 删除自己的评论 ---------------------------
 * 数据源: x/v2/reply/del(路径是 /del,不是 /delete)。
 * 参数: oid={aid}&type=1&rpid={评论id}&csrf=...,楼中楼回复再带上 root={楼层根评论id}。
 * 上游只允许删自己发的评论,删别人的会返回业务错误,这里原样透出去。
 * -------------------------------------------------------------------- */

app.post("/api/reply/del", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const oid = parseInt((req.body && req.body.oid) || "", 10);
  const rpid = ((req.body && req.body.rpid) || "").toString().trim();
  const root = ((req.body && req.body.root) || "").toString().trim();

  if (!oid) return res.status(400).json({ code: 1, message: "缺少 oid 参数" });
  if (!rpid) return res.status(400).json({ code: 1, message: "缺少 rpid 参数" });

  try {
    const cookie = await getUpstreamCookie(req);
    const body = new URLSearchParams({
      oid: String(oid),
      type: "1",
      rpid,
      csrf: session.biliJct || "",
    });
    // 删楼中楼回复要给上游楼层根评论;删主评论时 root 就是自己,不用重复带
    if (root && root !== rpid) body.set("root", root);

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v2/reply/del", {
      method: "POST",
      headers: writeHeaders(cookie, videoPageUrl(oid)),
      body: body.toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.json({ code: data.code, message: data.message || "删除失败" });
    }
    res.json({ code: 0 });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "删除评论失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 评论表情面板 -----------------------------
 * 数据源: x/emote/user/panel/web,business=reply。带登录 Cookie 才能拿到该账号的
 * 会员/已购买表情包,所以要求登录。
 * url 非空 = 图片表情;url 为空 = 颜文字包(其 url 字段就是那段字符,前端按纯文本渲染)。
 * size 是包的表情尺寸(1 小 2 大),前端据此决定一行放几个。
 * -------------------------------------------------------------------- */

app.get("/api/emote/panel", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  try {
    const cookie = await getUpstreamCookie(req);
    const url = new URL("https://api.bilibili.com/x/emote/user/panel/web");
    url.searchParams.set("business", "reply");

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });
    const data = await upstreamJson(biliRes, "表情面板接口");

    if (replyIfUnauthorized(req, res, data)) return;
    if (data.code !== 0) {
      return res.status(502).json({ error: `B 站接口返回错误: ${data.message || data.code}` });
    }

    // 包名/表情名先还原实体(上游偶尔给 &quot; 这类转义);
    // no_access 表示这个账号用不了(会员过期等),发出去会被上游拒,直接不展示
    // 动图表情的 url 是静态首帧,优先取 gif_url
    const packages = (data.data?.packages || [])
      .map((p) => ({
        name: decodeHtmlEntities(p?.text || ""),
        icon: normalizeImgUrl(p?.url),
        size: p?.meta?.size === 2 ? 2 : 1,
        emotes: (p?.emote || [])
          .filter((e) => e?.text && !e?.flags?.no_access)
          .map((e) => {
            const img = normalizeImgUrl(e.gif_url || e.url);
            // 颜文字包的表情 url 就是那段字符本身(不是图片地址),置空让前端按文本处理
            return {
              text: decodeHtmlEntities(e.text),
              url: /^https:\/\//.test(img) ? img : "",
              size: e?.meta?.size === 2 ? 2 : 1,
            };
          }),
      }))
      .filter((p) => p.emotes.length);

    res.json({ packages });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取表情列表失败,请稍后重试", 502);
    res.status(status).json({ error: message });
  }
});

/* ----------------------------- 发送弹幕 -----------------------------
 * 数据源: x/v2/dm/post。参数 type=1&oid={cid}&msg=...&progress={毫秒}&color={十进制}
 *       &fontsize=25&pool=0&mode={1滚动 4底部 5顶部}&rnd={随机数}&csrf=...,
 * bvid 一起带上方便上游定位视频。该接口需要 WBI 签名,先签名再发,否则容易被当成非浏览器请求。
 * 弹幕公开可见,这里只做非空 + 长度校验,其余交给上游判断。
 * -------------------------------------------------------------------- */

const DANMAKU_MAX_LENGTH = 100;
// 前端用插件语义(0滚动/1顶部/2底部),这里翻成上游取值
const DANMAKU_POOL_MODE = { 0: 1, 1: 5, 2: 4 };

app.post("/api/danmaku/send", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const body = req.body || {};
  const cid = parseInt(body.cid || "", 10);
  const msg = (body.msg || "").toString().trim();
  const bvid = (body.bvid || "").toString().trim();
  const progress = Math.max(0, parseInt(body.progress, 10) || 0); // 毫秒
  const color = parseInt(body.color, 10);
  const mode = DANMAKU_POOL_MODE[parseInt(body.mode, 10)] || 1;

  if (!cid) return res.status(400).json({ code: 1, message: "缺少 cid 参数" });
  if (!msg) return res.status(400).json({ code: 1, message: "弹幕内容不能为空" });
  if (msg.length > DANMAKU_MAX_LENGTH) {
    return res.status(400).json({ code: 1, message: `弹幕最多 ${DANMAKU_MAX_LENGTH} 个字` });
  }

  try {
    const cookie = await getUpstreamCookie(req);
    const signedParams = await signWbiParams({
      type: "1",
      oid: String(cid),
      msg,
      ...(bvid ? { bvid } : {}),
      progress: String(progress),
      color: String(Number.isFinite(color) ? color : 16777215), // 默认白色
      fontsize: "25",
      pool: "0",
      mode: String(mode),
      rnd: String(Math.floor(Date.now() / 1000)),
      csrf: session.biliJct || "",
    });

    const biliRes = await fetchWithTimeout("https://api.bilibili.com/x/v2/dm/post", {
      method: "POST",
      headers: writeHeaders(cookie, bvid ? `https://www.bilibili.com/video/${bvid}` : ""),
      body: new URLSearchParams(signedParams).toString(),
    });
    const data = await biliRes.json();

    if (replyIfUnauthorized(req, res, data)) return;

    if (data.code !== 0) {
      return res.json({ code: data.code, message: data.message || "弹幕发送失败" });
    }
    res.json({ code: 0, data: data.data ?? null });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "弹幕发送失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 首页推荐接口 -----------------------------
 * 未登录: 全站热门榜 x/web-interface/popular(非个性化,匿名可访问)。
 * 已登录: 优先个性化推荐 x/web-interface/wbi/index/top/feed/rcmd(需登录 cookie + WBI 签名),
 * 失败时静默回退到热门榜,不让"换一批"直接报错。
 * 个性化接口真正校验 w_rid/wts,参数(口味新鲜度、刷新轮次等)才会被采纳。
 * "换一批" = 每次实时向上游要新内容,不做服务端缓存/去重。
 * -------------------------------------------------------------------- */

const RECOMMEND_PAGE_SIZE = 20;
const RECOMMEND_MAX_PAGE = 20; // 热门榜实际可用页数有限，随机范围内取，避免取到空页

// 已登录时的个性化推荐流,"换一批"靠每次随机的 fresh_idx 让上游尽量返回不同内容
async function fetchPersonalizedRecommend(req) {
  const cookie = await getUpstreamCookie(req);

  const params = await signWbiParams({
    y_num: 4,
    fresh_type: 3,
    feed_version: "V8",
    fresh_idx_1h: Math.floor(Math.random() * 1000) + 1,
    fetch_row: 1,
    fresh_idx: Math.floor(Math.random() * 1000) + 1,
    brush: 1,
    homepage_ver: 1,
    ps: RECOMMEND_PAGE_SIZE,
  });

  const url = new URL("https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const biliRes = await fetchWithTimeout(url.toString(), {
    headers: { ...COMMON_HEADERS, Cookie: cookie },
  });
  const data = await biliRes.json();

  if (data.code !== 0) {
    throw new Error(`个性化推荐接口返回错误: ${data.message || data.code}`);
  }

  return (data.data?.item || [])
    .filter((item) => item.goto === "av") // 过滤掉广告位/横幅等非视频卡片
    .map((item) => ({
      bvid: item.bvid,
      title: sanitizeTitle(item.title),
      author: item.owner?.name,
      authorMid: item.owner?.mid || 0,
      pic: item.pic?.startsWith("//") ? `https:${item.pic}` : item.pic,
      play: item.stat?.view,
      danmaku: item.stat?.danmaku,
      duration: item.duration,
      pubdate: item.pubdate,
      description: item.desc,
    }));
}

app.get("/api/recommend", async (req, res) => {
  try {
    const session = getSession(req, false);

    if (isLoggedIn(session)) {
      try {
        const list = await fetchPersonalizedRecommend(req);
        return res.json({ personalized: true, list });
      } catch (err) {
        console.warn("个性化推荐加载失败,回退到热门榜:", err.message);
      }
    }

    const cookie = await getUpstreamCookie(req);

    let pn = parseInt(req.query.pn, 10);
    if (!pn || pn < 1) {
      pn = Math.floor(Math.random() * RECOMMEND_MAX_PAGE) + 1;
    }

    const url = new URL("https://api.bilibili.com/x/web-interface/popular");
    url.searchParams.set("pn", String(pn));
    url.searchParams.set("ps", String(RECOMMEND_PAGE_SIZE));

    const biliRes = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });

    const data = await biliRes.json();

    if (data.code !== 0) {
      return res
        .status(502)
        .json({ error: `B 站接口返回错误: ${data.message || data.code}` });
    }

    const list = (data.data?.list || []).map((item) => ({
      bvid: item.bvid,
      title: sanitizeTitle(item.title),
      author: item.owner?.name,
      authorMid: item.owner?.mid || 0,
      pic: item.pic?.startsWith("//") ? `https:${item.pic}` : item.pic,
      play: item.stat?.view,
      danmaku: item.stat?.danmaku,
      duration: item.duration,
      pubdate: item.pubdate,
      description: item.desc,
    }));

    res.json({ personalized: false, pn, list });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "获取推荐失败,请稍后重试", 500);
    res.status(status).json({ error: message });
  }
});

// 清晰度 qn 代码 -> 面板上的短标签: 上游 accept_description 是整句(如 "高清 1080P60"),
// 塞进设置面板太长,所以按 qn 再给一份短标签,表里没有的冷门代码回退用上游 description
const QUALITY_SHORT_LABELS = {
  6: "240P",
  16: "360P",
  32: "480P",
  64: "720P",
  74: "720P60",
  80: "1080P",
  100: "智能修复",
  112: "1080P+",
  116: "1080P60",
  120: "4K",
  125: "HDR",
  126: "杜比视界",
  127: "8K",
  129: "HDR Vivid",
};

// qn 代码 -> 短标签;上游 description 数组与 accept_quality 下标一一对应
function buildQualityLabels(acceptQuality, acceptDescription) {
  const labels = new Map();
  const qualities = Array.isArray(acceptQuality) ? acceptQuality : [];
  const descriptions = Array.isArray(acceptDescription) ? acceptDescription : [];
  qualities.forEach((qn, index) => {
    const id = Number(qn);
    if (!Number.isFinite(id)) return;
    const fromUpstream = typeof descriptions[index] === "string" ? descriptions[index].trim() : "";
    labels.set(id, QUALITY_SHORT_LABELS[id] || fromUpstream || `${id}P`);
  });
  return labels;
}


/* ----------------------------- 播放解析接口 -----------------------------
 * 取流流程: 先走 DASH(fnval=16),拿不到可用视频流时才补一发 durl(fnval=0),
 * durl 单文件 mp4 作为前端降级用的 fallbackUrl。
 * 取流参数: qn 默认 80(1080P) / type=mp4 / platform=html5 / high_quality=1 / fourk=1。
 * cid 必须由调用方先通过 /api/info 拿到再传进来,避免重复请求同一个上游接口。
 * -------------------------------------------------------------------- */
async function fetchPlayUrl({ aid, bvid, cid, qn, cookie }) {
  const base = new URL("https://api.bilibili.com/x/player/playurl");
  base.searchParams.set("avid", String(aid || ""));
  base.searchParams.set("bvid", bvid || "");
  base.searchParams.set("cid", String(cid));
  base.searchParams.set("qn", String(qn || 80));
  base.searchParams.set("type", "mp4");
  base.searchParams.set("otype", "json");
  base.searchParams.set("fnver", "0");
  base.searchParams.set("fourk", "1");
  base.searchParams.set("platform", "html5");
  base.searchParams.set("high_quality", "1");

  const dashUrl = new URL(base.toString());
  dashUrl.searchParams.set("fnval", "16");
  const dashRes = await fetchWithTimeout(dashUrl.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } })
    .then((r) => r.json())
    .catch(() => null);
  const dashData = dashRes && dashRes.code === 0 ? dashRes.data : null;

  let dash = null;
  if (dashData?.dash?.video?.length) {
    // qn 是清晰度选择的结果: DASH 通常一次性返回已授权的所有清晰度,
    // 这里挑对应那一路,找不到就退回第一路(最高画质)
    const wanted = qn ? dashData.dash.video.find((v) => Number(v.id) === Number(qn)) : null;
    const video = wanted || dashData.dash.video[0];
    const audio = dashData.dash.audio?.[0];
    dash = {
      video: video.baseUrl || video.base_url,
      audio: audio ? audio.baseUrl || audio.base_url : null,
      videoId: video.id,
      audioId: audio ? audio.id : null,
    };
  }

  let durlData = null;
  let fallbackUrl = "";
  if (!dash) {
    const durlUrl = new URL(base.toString());
    durlUrl.searchParams.set("fnval", "0");
    const durlRes = await fetchWithTimeout(durlUrl.toString(), { headers: { ...COMMON_HEADERS, Cookie: cookie } })
      .then((r) => r.json())
      .catch(() => null);
    durlData = durlRes && durlRes.code === 0 ? durlRes.data : null;
    if (durlData?.durl?.length) fallbackUrl = durlData.durl[0].url;
  }

  if (!dash && !fallbackUrl) {
    throw Object.assign(new Error("未获取到可播放的直链"), {
      userMessage: "未获取到可播放的直链,该视频可能已被删除或需要登录",
    });
  }

  const qualitySource = dashData || durlData || {};
  const acceptQuality = Array.isArray(qualitySource.accept_quality) ? qualitySource.accept_quality : [];
  const acceptDescription = Array.isArray(qualitySource.accept_description) ? qualitySource.accept_description : [];
  const labels = buildQualityLabels(acceptQuality, acceptDescription);
  const currentQuality = dash ? dash.videoId : qualitySource.quality;

  return {
    quality: currentQuality,
    accept_quality: acceptQuality,
    accept_description: acceptDescription,
    // 给设置面板用的档位清单: 上游 accept_quality 与 accept_description 按下标一一对应,
    // 这里合成 { id, label },前端直接照着渲染
    qualities: acceptQuality.map((id, index) => ({
      id: Number(id),
      label: labels.get(Number(id)) || (acceptDescription[index] || `${id}P`),
    })),
    dash,
    fallbackUrl,
  };
}

app.get("/api/play", async (req, res) => {
  const bvid = (req.query.bv || "").toString().trim();
  const aid = parseInt((req.query.av || "").toString().trim(), 10) || 0;
  // cid 由调用方先通过 /api/info 拿到再传进来
  const cid = parseInt((req.query.cid || "").toString().trim(), 10) || 0;
  const page = parseInt(req.query.p, 10) || 1;
  // 未指定 qn 时用 80(1080P)
  const qn = parseInt(req.query.qn, 10) || 80;

  if (!bvid && !aid) {
    return res.status(400).json({ code: 1, message: "缺少 bv 或 av 参数" });
  }
  if (!cid) {
    return res
      .status(400)
      .json({ code: 1, message: "缺少 cid 参数,请先调用 /api/info 获取该分P的 cid" });
  }

  try {
    const cookie = await getUpstreamCookie(req);
    const play = await fetchPlayUrl({ aid, bvid, cid, qn, cookie });
    res.json({ code: 0, cid, aid, bvid, page, ...play });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, safeUpstreamMessage(err), 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 视频信息接口 ----------------------------- */

app.get("/api/info", async (req, res) => {
  const bvid = (req.query.bv || "").toString().trim();
  const aidRaw = (req.query.av || "").toString().trim();
  const aid = aidRaw ? parseInt(aidRaw, 10) : 0;

  if (!bvid && !aid) {
    return res.status(400).json({ code: 1, message: "缺少 bv 或 av 参数" });
  }

  try {
    const cookie = await getUpstreamCookie(req);
    const url = new URL("https://api.bilibili.com/x/web-interface/view");
    if (bvid) url.searchParams.set("bvid", bvid);
    if (aid) url.searchParams.set("aid", String(aid));

    const r = await fetchWithTimeout(url.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: cookie },
    });
    const json = await r.json();

    if (json.code !== 0 || !json.data) {
      throw Object.assign(new Error(`获取视频信息失败: ${json.message || json.code}`), {
        userMessage: `获取视频信息失败: ${json.message || json.code}`,
      });
    }

    const pages = (json.data.pages || []).map((p, idx) => ({
      page: idx + 1,
      part: p.part || `第 ${idx + 1} P`,
      // 带上 cid,前端可据此并行请求 /api/play 和 /api/danmaku,不用等 /api/play 返回
      cid: p.cid,
    }));

    const pic = json.data.pic?.startsWith("//") ? `https:${json.data.pic}` : json.data.pic;

    res.json({
      code: 0,
      title: json.data.title || "",
      desc: json.data.desc || "",
      pages,
      pic: pic || "",
      author: json.data.owner?.name || "",
      // 关注/取关等操作都要靠 mid,只拿名字不够
      ownerMid: json.data.owner?.mid || null,
      duration: json.data.duration || 0,
      play: json.data.stat?.view ?? null,
      danmaku: json.data.stat?.danmaku ?? null,
      pubdate: json.data.pubdate ?? null,
      // 互动按钮的数据;转发是纯前端复制链接,不需要这里的数据
      like: json.data.stat?.like ?? null,
      coin: json.data.stat?.coin ?? null,
      favorite: json.data.stat?.favorite ?? null,
      share: json.data.stat?.share ?? null,
      // 评论接口需要数字 av 号作为 oid,不能直接传 bvid
      aid: json.data.aid || null,
    });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, safeUpstreamMessage(err), 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 播放页作者信息卡:UP 主信息 + 关注/取关 -----------------------------
 * 头像/昵称/签名走 x/space/wbi/acc/info,需要 WBI 签名,同时补 dm_img_* 设备指纹
 * (只带 mid 会被上游判 -352)。真被风控拦死时退一步用 web-interface/card,
 * 它风控宽松得多,但只保证用户名/头像/签名可用。
 * 是否已关注用 x/relation?fid= 查(只需登录 Cookie);未登录或查自己时跳过。
 * -------------------------------------------------------------------- */
async function fetchSpaceProfile(mid, cookie) {
  try {
    const json = await fetchSpaceSigned(
      "https://api.bilibili.com/x/space/wbi/acc/info",
      { mid: String(mid) },
      cookie
    );
    if (json.code === 0 && json.data) {
      return {
        mid: json.data.mid || mid,
        name: json.data.name || "",
        face: json.data.face || "",
        sign: json.data.sign || "",
      };
    }
    // 用户不存在时不必再回退,直接把 -404 抛给调用方
    if (json.code === -404) {
      throw Object.assign(new Error(spaceErrorText(-404)), { code: -404 });
    }
  } catch (err) {
    if (err.code === -404) throw err;
    // acc/info 被风控是常态,静默走下面的 card 兜底
  }

  // 兜底:card 接口风控宽松,但只保证用户名/头像/签名
  const cardUrl = new URL("https://api.bilibili.com/x/web-interface/card");
  cardUrl.searchParams.set("mid", String(mid));
  cardUrl.searchParams.set("photo", "false");
  const cardRes = await fetchWithTimeout(cardUrl.toString(), {
    headers: { ...COMMON_HEADERS, Cookie: cookie },
  });
  const cardJson = await upstreamJson(cardRes, "web-interface/card");
  if (cardJson.code !== 0 || !cardJson.data?.card) {
    throw Object.assign(new Error(spaceErrorText(cardJson.code, cardJson.message)), {
      code: cardJson.code,
    });
  }
  const card = cardJson.data.card;
  return {
    mid: Number(card.mid) || mid,
    name: card.name || "",
    face: card.face || "",
    sign: card.sign || "",
  };
}

// 批量查"当前账号是否已关注"这批 mid(播放页作者卡、搜索结果里的 UP 主共用)。
// 上游没有批量接口(x/relation/summaries 已下线),只能逐个 x/relation?fid=;
// 未登录时上游一律回 -101,所以整批跳过。查不到按未关注处理,不报错也不刷日志
async function fetchFollowStates(req, mids, selfMid) {
  const states = new Map();
  if (!isLoggedIn(getSession(req, false))) return states;

  const cookie = await getUpstreamCookie(req);

  const checkOne = async (mid) => {
    if (!mid || String(mid) === String(selfMid)) return;
    try {
      const relUrl = new URL("https://api.bilibili.com/x/relation");
      relUrl.searchParams.set("fid", String(mid));
      const relRes = await fetchWithTimeout(relUrl.toString(), {
        headers: { ...COMMON_HEADERS, Cookie: cookie },
      });
      const relJson = await upstreamJson(relRes, "x/relation");
      // attribute: 0=未关注 2=已关注 6=互相关注,其余(拉黑等)一律当作未关注
      if (relJson.code === 0 && relJson.data) {
        states.set(String(mid), relJson.data.attribute === 2 || relJson.data.attribute === 6);
      }
    } catch (relErr) {
      // 查不到就按"未关注"展示,不打扰用户也不刷日志
    }
  };

  const queue = [...mids];
  const workers = Array.from({ length: Math.min(FOLLOW_STATE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      await checkOne(queue.shift());
    }
  });
  await Promise.all(workers);

  return states;
}

// 关注数/粉丝数: 公开接口,查询失败不影响主体信息返回(前端显示 '-')
async function fetchRelationStats(req, mid) {
  try {
    const statUrl = new URL("https://api.bilibili.com/x/relation/stat");
    statUrl.searchParams.set("vmid", String(mid));
    const statRes = await fetchWithTimeout(statUrl.toString(), {
      headers: { ...COMMON_HEADERS, Cookie: await getUpstreamCookie(req) },
    });
    const statJson = await upstreamJson(statRes, "x/relation/stat");
    if (statJson.code === 0 && statJson.data) {
      return {
        following: statJson.data.following ?? null,
        follower: statJson.data.follower ?? null,
      };
    }
  } catch (statErr) {
    // 拿不到就显示 '-',不打扰用户也不刷日志
  }
  return { following: null, follower: null };
}

app.get("/api/up/info", async (req, res) => {
  const mid = parseInt((req.query && req.query.mid) || "", 10);
  if (!mid) return res.status(400).json({ code: 1, message: "缺少 mid 参数" });

  try {
    // 三个请求彼此独立,并发发出,总耗时取最慢的那个。
    // 资料卡是主数据,失败即整体失败;关注状态和粉丝数各自内部已吞掉错误
    const session = getSession(req, false);
    const selfMid = isLoggedIn(session) ? session.mid : null;
    const isSelf = !!(selfMid && String(selfMid) === String(mid));

    const profilePromise = fetchSpaceProfile(mid, await getUpstreamCookie(req));
    const statsPromise = fetchRelationStats(req, mid);
    const [info, followStates, stats] = await Promise.all([
      profilePromise,
      fetchFollowStates(req, [mid], selfMid),
      statsPromise,
    ]);
    const isFollowing = followStates.get(String(mid)) || false;
    const { following, follower } = stats;

    const face = info.face?.startsWith("//") ? `https:${info.face}` : info.face || "";

    res.json({
      code: 0,
      mid,
      name: info.name || "",
      avatar: face,
      sign: info.sign || "",
      isSelf,
      isFollowing,
      following,
      follower,
    });
  } catch (err) {
    // 只有"该用户不存在"和上游彻底不可用两种情况,给前端一句简短提示即可
    const { status, message } = buildErrorResponse(
      err,
      spaceErrorText(err.code, err.message) || "加载失败,请稍后重试",
      502
    );
    res.status(status).json({ code: 1, message });
  }
});

app.post("/api/up/follow", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const mid = parseInt((req.body && req.body.mid) || "", 10);
  const follow = !!(req.body && req.body.follow);
  if (!mid) return res.status(400).json({ code: 1, message: "缺少 mid 参数" });

  try {
    const cookie = await getUpstreamCookie(req);
    const params = new URLSearchParams({
      fid: String(mid),
      act: follow ? "1" : "2",
      re_src: "11",
      csrf: session.biliJct,
    });
    const r = await fetchWithTimeout("https://api.bilibili.com/x/relation/modify", {
      method: "POST",
      headers: writeHeaders(cookie, `https://space.bilibili.com/${mid}`),
      body: params.toString(),
    });
    const json = await r.json();
    if (replyIfUnauthorized(req, res, json)) return;
    if (json.code !== 0) {
      return res.json({ code: json.code, message: json.message || (follow ? "关注失败" : "取消关注失败") });
    }
    res.json({ code: 0 });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(
      err,
      follow ? "关注请求失败,请稍后重试" : "取消关注请求失败,请稍后重试",
      502
    );
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 用户空间:投稿列表 -----------------------------
 * 主数据源 x/space/wbi/arc/search,需要 WBI 签名,公开接口匿名可查。
 * 字段对齐 /api/search 的 list 结构(bvid/title/author/authorMid/pic/play/danmaku/
 * duration/pubdate/description),前端可复用现成的视频卡片渲染函数。
 * -------------------------------------------------------------------- */
const SPACE_VIDEOS_PAGE_SIZE = 30;
const VALID_SPACE_ORDERS = new Set(["pubdate", "click", "stow"]);

// 上游两个接口的时长格式不同: arc/search 的 length 是 "mm:ss" 字符串,
// recArchivesByKeywords 的 duration 是秒数,统一换算成秒,前端只处理一种形态
function toSeconds(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const str = String(raw == null ? "" : raw).trim();
  if (!str) return 0;
  if (!str.includes(":")) return parseInt(str, 10) || 0;
  const p = str.split(":").map((x) => parseInt(x, 10) || 0);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
}

// 两个上游的字段名不同,用取值函数把差异收在一处:
// arc/search: length="13:05",play/video_review/mid/created 齐全
// recArchivesByKeywords: duration=秒数,没有 author/mid/play/video_review,
//                        播放量在 stat.view、作者 mid 在 upMid、作者名要靠调用方补
function mapSpaceVideo(item, mid, pick) {
  const seconds = toSeconds(pick.duration(item));
  const pic = pick.pic(item);
  return {
    bvid: item.bvid,
    title: sanitizeTitle(item.title),
    author: pick.author(item),
    authorMid: pick.authorMid(item) || mid,
    pic: pic && String(pic).startsWith("//") ? `https:${pic}` : pic || "",
    play: pick.play(item),
    danmaku: pick.danmaku(item),
    duration: seconds, // 老字段保留成秒数
    durationSeconds: seconds,
    pubdate: pick.pubdate(item) || 0,
    description: pick.description(item) || "",
  };
}

const ARC_SEARCH_FIELDS = {
  duration: (v) => v.length,
  pic: (v) => v.pic,
  author: (v) => v.author || "",
  authorMid: (v) => v.mid,
  play: (v) => v.play,
  danmaku: (v) => v.video_review,
  pubdate: (v) => v.created,
  description: (v) => v.description,
};

const REC_ARCHIVE_FIELDS = {
  duration: (v) => v.duration,
  pic: (v) => v.pic,
  author: () => "", // 兜底接口不带作者名,前端用资料卡昵称补
  authorMid: (v) => v.mid || v.upMid,
  play: (v) => v.play ?? v.stat?.view ?? null,
  danmaku: (v) => v.video_review ?? v.stat?.danmaku ?? null,
  pubdate: (v) => v.pubdate || v.created || v.ctime,
  description: (v) => v.description || v.desc,
};

/* ----------------------------- 用户空间:投稿列表 -----------------------------
 * 主数据源 x/space/wbi/arc/search 风控很严(-352 / 412 都很常见),所以再挂一层兜底:
 * x/series/recArchivesByKeywords。兜底接口只要 Referer、不需要 WBI 签名,风控宽松得多,
 * 代价是不支持排序和翻页,只能拿到最近 50 条,所以只在第一页兜底。
 * -------------------------------------------------------------------- */
app.get("/api/space/videos", async (req, res) => {
  const mid = parseInt((req.query && req.query.mid) || "", 10);
  if (!mid) return res.status(400).json({ code: 1, message: "缺少 mid 参数" });

  const pn = parseInt(req.query.pn, 10) || 1;

  let order = (req.query.order || "").toString().trim();
  if (!VALID_SPACE_ORDERS.has(order)) order = "pubdate";

  const cookie = await getUpstreamCookie(req);

  // 优先 arc/search(带排序和分页)。被风控时不打断流程,改走下面的兜底
  try {
    // tid/keyword/order_avoided 是网页端固定会带的参数,少一个都可能被判成风控请求
    const data = await fetchSpaceSigned(
      "https://api.bilibili.com/x/space/wbi/arc/search",
      { mid: String(mid), pn: String(pn), ps: String(SPACE_VIDEOS_PAGE_SIZE), order, tid: "0", keyword: "", order_avoided: "true" },
      cookie
    );

    if (data.code === 0) {
      const list = (data.data?.list?.vlist || []).map((v) => mapSpaceVideo(v, mid, ARC_SEARCH_FIELDS));
      const total = data.data?.page?.count;
      return res.json({
        code: 0,
        total: total || 0,
        page: pn,
        list,
        hasMore: typeof total === "number" ? pn * SPACE_VIDEOS_PAGE_SIZE < total : list.length === SPACE_VIDEOS_PAGE_SIZE,
      });
    }
    // 用户不存在,兜底也没意义
    if (data.code === -404) return res.status(502).json({ code: 1, message: spaceErrorText(-404) });
  } catch (err) {
    if (err.code === -404) return res.status(502).json({ code: 1, message: spaceErrorText(-404) });
  }

  // 兜底:recArchivesByKeywords 不支持排序和翻页,所以只在第一页兜底
  if (pn === 1) {
    try {
      const url = new URL("https://api.bilibili.com/x/series/recArchivesByKeywords");
      url.searchParams.set("mid", String(mid));
      url.searchParams.set("keywords", "");
      url.searchParams.set("ps", "50");
      const r = await fetchWithTimeout(url.toString(), {
        headers: { ...COMMON_HEADERS, Referer: `https://space.bilibili.com/${mid}/`, Cookie: cookie },
      });
      const j = await upstreamJson(r, "series/recArchivesByKeywords");
      if (j.code === 0 && Array.isArray(j.data?.archives)) {
        const list = j.data.archives.map((v) => mapSpaceVideo(v, mid, REC_ARCHIVE_FIELDS));
        // fallback 告诉前端收起"加载更多": 这批只有最近 50 条,不支持翻页
        return res.json({ code: 0, total: list.length, page: 1, list, hasMore: false, fallback: true });
      }
    } catch (err) {
      // 兜底也失败,落到下面统一报错
    }
  }

  // 两条路都不通,返回统一的失败文案(细节不回传前端)
  res.status(502).json({ code: 1, message: spaceErrorText(-352) });
});

/* ----------------------------- 互动:点赞/投币/收藏 -----------------------------
 * 播放器下方的点赞/投币/收藏对应真实 B 站接口,转发按钮只是复制链接,纯前端实现。
 * like/add 参数是"切换到的目标状态"(true=点赞/收藏,false=取消)。
 * 收藏由播放页的"选择收藏夹"面板勾选后一次提交:
 *   - 勾选状态来自 GET /api/account/favorites?rid={aid}
 *   - 前端算出 addMediaIds / delMediaIds,这里合并成一次 fav/resource/deal
 *     (add_media_ids / del_media_ids 都支持逗号分隔的多个收藏夹)
 *   - 从所有夹子移出即取消收藏
 * 都需要登录 Cookie + CSRF(bili_jct),收藏额外需要 WBI 签名。
 * -------------------------------------------------------------------- */

app.post("/api/action/like", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const aid = parseInt((req.body && req.body.aid) || "", 10);
  const like = !!(req.body && req.body.like);
  if (!aid) return res.status(400).json({ code: 1, message: "缺少 aid 参数" });

  try {
    const cookie = await getUpstreamCookie(req);
    const params = new URLSearchParams({
      aid: String(aid),
      like: like ? "1" : "2",
      csrf: session.biliJct,
    });
    const r = await fetchWithTimeout("https://api.bilibili.com/x/web-interface/archive/like", {
      method: "POST",
      headers: writeHeaders(cookie, videoPageUrl(aid)),
      body: params.toString(),
    });
    const json = await r.json();
    if (replyIfUnauthorized(req, res, json)) return;
    if (json.code !== 0) {
      return res.json({ code: json.code, message: json.message || "点赞失败" });
    }
    res.json({ code: 0 });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "点赞请求失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

app.post("/api/action/coin", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const aid = parseInt((req.body && req.body.aid) || "", 10);
  const count = parseInt((req.body && req.body.count) || "1", 10);
  if (!aid) return res.status(400).json({ code: 1, message: "缺少 aid 参数" });
  if (count !== 1 && count !== 2) {
    return res.status(400).json({ code: 1, message: "投币数量只能是 1 或 2" });
  }

  try {
    const cookie = await getUpstreamCookie(req);
    const params = new URLSearchParams({
      aid: String(aid),
      multiply: String(count),
      cross_domain: "true",
      csrf: session.biliJct,
    });
    const r = await fetchWithTimeout("https://api.bilibili.com/x/web-interface/coin/add", {
      method: "POST",
      headers: writeHeaders(cookie, videoPageUrl(aid)),
      body: params.toString(),
    });
    const json = await r.json();
    if (replyIfUnauthorized(req, res, json)) return;
    if (json.code !== 0) {
      return res.json({ code: json.code, message: json.message || "投币失败" });
    }
    res.json({ code: 0 });
  } catch (err) {
    console.error(err);
    const { status, message } = buildErrorResponse(err, "投币请求失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

// 收藏夹 id 列表: 只收数字 id,去重后拼成 deal 要的逗号串
function joinMediaIds(value) {
  const ids = Array.isArray(value) ? value : [value];
  const seen = new Set();
  ids.forEach((id) => {
    const text = String(id ?? "").trim();
    if (/^\d+$/.test(text)) seen.add(text);
  });
  return [...seen].join(",");
}

app.post("/api/action/favorite", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const body = req.body || {};
  const aid = parseInt(body.aid || "", 10);
  if (!aid) return res.status(400).json({ code: 1, message: "缺少 aid 参数" });

  const addMediaIds = joinMediaIds(body.addMediaIds);
  const delMediaIds = joinMediaIds(body.delMediaIds);
  if (!addMediaIds && !delMediaIds) {
    return res.status(400).json({ code: 1, message: "收藏夹没有变化" });
  }
  // 同一个夹子不能既加又删,否则上游行为不确定
  if (addMediaIds && delMediaIds) {
    const addSet = new Set(addMediaIds.split(","));
    if (delMediaIds.split(",").some((id) => addSet.has(id))) {
      return res.status(400).json({ code: 1, message: "同一个收藏夹不能同时加入和移出" });
    }
  }

  try {
    // 前端给的是收藏夹 id,这里回查一次"自己创建的收藏夹"做校验,
    // 避免把不属于自己的 id 拼进 deal(收藏是账号级操作,不该由请求体说了算)
    const own = await assertOwnFavorites(req, res, session, [...addMediaIds.split(","), ...delMediaIds.split(",")]);
    if (own === null) return;
    if (!own) {
      return res.status(400).json({ code: 1, message: "收藏夹不存在或不属于当前账号" });
    }

    const cookie = await getUpstreamCookie(req);
    const signedParams = await signWbiParams({
      rid: String(aid),
      type: "2",
      add_media_ids: addMediaIds,
      del_media_ids: delMediaIds,
      csrf: session.biliJct || "",
      platform: "web",
    });

    const r = await fetchWithTimeout("https://api.bilibili.com/x/v3/fav/resource/deal", {
      method: "POST",
      headers: writeHeaders(cookie, videoPageUrl(aid)),
      body: new URLSearchParams(signedParams).toString(),
    });
    const json = await r.json();
    if (replyIfUnauthorized(req, res, json)) return;
    if (json.code !== 0) {
      return res.json({ code: json.code, message: json.message || "收藏失败" });
    }
    // favorited 是改动后的状态:加了夹子就是已收藏,只从夹子里移出就是取消收藏
    res.json({ code: 0, favorited: !!addMediaIds });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "收藏请求失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 播放心跳: 新增历史记录 + 同步播放进度 -----------------------------
 * 真实 URL 是 x/report/web/heartbeat。B 站没有单独的"添加历史记录"接口,心跳就是写入点:
 * 第一次上报把视频写进登录账号的历史列表,之后每次上报更新 played_time(看到第几秒),
 * 换设备登录同一账号时"继续播放"就能跳到上次的位置。
 * 未登录时没有账号可写,直接 401,前端静默跳过。
 * -------------------------------------------------------------------- */
app.post("/api/action/heartbeat", async (req, res) => {
  const session = requireLogin(req, res);
  if (!session) return;

  const aid = parseInt((req.body && req.body.aid) || "", 10);
  const cid = parseInt((req.body && req.body.cid) || "", 10);
  const playedTime = Math.max(0, parseInt((req.body && req.body.playedTime) || "0", 10));
  if (!aid || !cid) return res.status(400).json({ code: 1, message: "缺少 aid/cid 参数" });

  try {
    await ensureProfileFields(req, session);
    const cookie = await getUpstreamCookie(req);
    const nowSec = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      aid: String(aid),
      cid: String(cid),
      mid: String(session.mid || ""),
      csrf: session.biliJct,
      played_time: String(playedTime),
      realtime: String(playedTime),
      start_ts: String(nowSec - playedTime),
      type: "3",
      dt: "2",
      play_type: "1",
    });
    const r = await fetchWithTimeout("https://api.bilibili.com/x/report/web/heartbeat", {
      method: "POST",
      headers: writeHeaders(cookie, videoPageUrl(aid)),
      body: params.toString(),
    });
    const json = await r.json();
    if (replyIfUnauthorized(req, res, json)) return;
    if (json.code !== 0) {
      return res.json({ code: json.code, message: json.message || "上报播放进度失败" });
    }
    res.json({ code: 0 });
  } catch (err) {
    if (err.sessionInvalid) return sendLoginExpired(res);
    console.error(err);
    const { status, message } = buildErrorResponse(err, "上报播放进度失败,请稍后重试", 502);
    res.status(status).json({ code: 1, message });
  }
});

/* ----------------------------- 互动:查询当前账号是否已点赞/投币/收藏 -----------------------------
 * 播放页打开视频时反查真实状态,用于同步按钮高亮。
 * 未登录时没有"个人状态"可言,直接返回默认值(全部 false/0)。
 * 三个上游接口都只要 Cookie。
 * -------------------------------------------------------------------- */
app.get("/api/action/status", async (req, res) => {
  const aid = parseInt((req.query && req.query.aid) || "", 10);
  if (!aid) return res.status(400).json({ code: 1, message: "缺少 aid 参数" });

  const session = getSession(req, false);
  if (!isLoggedIn(session)) {
    return res.json({ code: 0, liked: false, coinCount: 0, favorited: false });
  }

  try {
    const cookie = await getUpstreamCookie(req);

    const [likeJson, coinJson, favJson] = await Promise.all([
      fetchWithTimeout(`https://api.bilibili.com/x/web-interface/archive/has/like?aid=${aid}`, {
        headers: { ...COMMON_HEADERS, Cookie: cookie },
      }).then((r) => r.json()),
      fetchWithTimeout(`https://api.bilibili.com/x/web-interface/archive/coins?aid=${aid}`, {
        headers: { ...COMMON_HEADERS, Cookie: cookie },
      }).then((r) => r.json()),
      fetchWithTimeout(`https://api.bilibili.com/x/v2/fav/video/favoured?aid=${aid}`, {
        headers: { ...COMMON_HEADERS, Cookie: cookie },
      }).then((r) => r.json()),
    ]);

    // 只要有一个接口明确回 -101,就说明本地 SESSDATA 已被作废:
    // 删掉整条会话并回 401,让前端切回未登录状态,而不是安静地显示成"未点赞/未收藏"
    if ([likeJson, coinJson, favJson].some((j) => j && j.code === -101)) {
      dropSession(req.sessionId, session, "上游判定未登录(UPSTREAM_NOT_LOGIN)");
      return sendLoginExpired(res);
    }

    res.json({
      code: 0,
      liked: likeJson.code === 0 ? !!likeJson.data : false,
      coinCount: coinJson.code === 0 ? coinJson.data?.multiply || 0 : 0,
      favorited: favJson.code === 0 ? !!favJson.data?.favoured : false,
    });
  } catch (err) {
    console.error(err);
    // 查状态失败不影响播放,前端按默认(未点/未收藏)展示即可
    res.json({ code: 0, liked: false, coinCount: 0, favorited: false });
  }
});

/* ----------------------------- 静态页面路由 ----------------------------- */
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/search", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "search.html"));
});

app.get("/player", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "player.html"));
});

app.get("/account", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "account.html"));
});

app.get("/settings", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"));
});

app.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
  console.log(`  首页: http://localhost:${PORT}/`);
  console.log(`  搜索结果页: http://localhost:${PORT}/search`);
  console.log(`  播放页: http://localhost:${PORT}/player`);
  console.log(`  个人主页: http://localhost:${PORT}/account`);
  console.log(`  设置页: http://localhost:${PORT}/settings`);
});
