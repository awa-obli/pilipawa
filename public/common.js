/* 全站公共脚本:顶部边栏的搜索历史下拉 + 实时搜索建议。
   四个页面原本各留一份,这里只维护一份;新页面照抄顶部边栏的 HTML 后引入本文件即可。

   引入位置必须排在页面自己的 <script> 之前 —— 页面脚本会直接调用这里的
   addHistory / showHistoryDropdown / hideHistoryDropdown。
   依赖的 DOM(#searchForm / #keyword / #historyDropdown / .search-wrap)都在顶部边栏里。 */

const historyDropdown = document.getElementById('historyDropdown');

// 本文件自带的属性转义:不依赖页面上的 escapeAttr(account 页那份对空值行为不同)
function attrEscape(str) {
  return String(str).replace(/"/g, '&quot;');
}

/* ----------------------------- 搜索历史 (localStorage) ----------------------------- */

const HISTORY_KEY = 'bili_search_history';
const HISTORY_MAX = 10;

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (err) {
    // localStorage 不可用(如隐私模式)时静默忽略
  }
}

function addHistory(keyword) {
  keyword = keyword.trim();
  if (!keyword) return;
  let list = getHistory().filter((k) => k !== keyword);
  list.unshift(keyword);
  if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
  saveHistory(list);
}

function removeHistory(keyword) {
  saveHistory(getHistory().filter((k) => k !== keyword));
  renderHistory();
}

function clearHistory() {
  saveHistory([]);
  renderHistory();
}


function renderHistory() {
  const list = getHistory();

  if (!list.length) {
    historyDropdown.innerHTML = `<div class="history-empty">暂无搜索记录</div>`;
    return;
  }

  const items = list.map((kw) => `
    <div class="history-item" data-keyword="${attrEscape(kw)}">
      <span class="history-text">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/>
          <path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        <span>${kw}</span>
      </span>
      <button type="button" class="history-remove" data-remove="${attrEscape(kw)}" title="删除">×</button>
    </div>
  `).join('');

  historyDropdown.innerHTML = `
    <div class="history-header">
      <span>搜索历史</span>
      <button type="button" class="history-clear" id="historyClearBtn">清空</button>
    </div>
    ${items}
  `;
}

/* 上面几个函数负责搜索历史的存储与渲染;下拉框的展现与交互(含实时搜索建议)
 * 由本文件后面的"搜索框下拉"部分统一接管 */

function showHistoryDropdown() {
  renderHistory();
  historyDropdown.classList.add('show');
}

// 收起下拉框要连"正在加载..."占位一起清掉,所以交给本文件后半部分的 close()
function hideHistoryDropdown() {
  if (window.BiliSuggest) window.BiliSuggest.close();
  else historyDropdown.classList.remove('show');
}

historyDropdown.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('[data-remove]');
  if (removeBtn) {
    e.stopPropagation();
    removeHistory(removeBtn.dataset.remove);
    return;
  }

  const clearBtn = e.target.closest('#historyClearBtn');
  if (clearBtn) {
    clearHistory();
    return;
  }
});

/* -----------------------------------------------------------------------------
 * 搜索框下拉: 最近搜索历史 + 实时搜索建议
 * -----------------------------------------------------------------------------
 * 数据来源: B 站官方搜索建议接口 s.search.bilibili.com/main/suggest?term=xxx,
 * 最多返回 10 条,按相关程度与热度排序。该接口校验 Referer 与匿名 buvid3 cookie,
 * 浏览器直连会被 412 挡下,所以统一走服务端 /api/suggest 转发。
 *
 * 下拉框内容按输入框状态切换:
 *   输入框为空 + 聚焦 -> 最近搜索历史(由上面的 localStorage 逻辑渲染)
 *   输入框有内容      -> 实时搜索建议,命中的关键词红色高亮
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  const form = document.getElementById('searchForm');
  const input = document.getElementById('keyword') || document.getElementById('searchInput');
  const dropdown = document.getElementById('historyDropdown');
  const wrap = document.querySelector('.search-wrap');

  if (!form || !input || !dropdown || !wrap) return;

  // 输入停止多久后才真正请求,避免每敲一个字都打接口
  const DEBOUNCE_MS = 180;
  // 上游偶尔回成 JSONP 包裹,那样就不是合法 JSON,这里剥一层兜底
  const JSONP_WRAP_RE = /^[A-Za-z_$][\w$]*\(([\s\S]*)\);?\s*$/;

  let items = [];
  let activeIndex = -1;
  let debounceTimer = null;
  let lastTerm = null;
  let requestSeq = 0;
  let abortController = null;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 上游 name 字段自带 <em class="suggest_high_light">关键词</em>。
  // 只认这一种标签: 先摘出来占位、把其余标签全部去掉(防注入),最后再还原高亮标签
  function highlight(raw, fallback) {
    const source = raw == null ? '' : String(raw);
    if (!source) return escapeHtml(fallback || '');

    const marked = source
      .replace(/<em class="suggest_high_light">/g, '\u0000O\u0000')
      .replace(/<\/em>/g, '\u0000C\u0000');

    const plain = escapeHtml(marked.replace(/<[^>]+>/g, ''));

    return plain
      .replace(/\u0000O\u0000/g, '<em class="suggest-high-light">')
      .replace(/\u0000C\u0000/g, '</em>');
  }

  function renderList(list) {
    items = list.slice();
    activeIndex = -1;
    dropdown.innerHTML = list
      .map(
        (item, index) => `
      <div class="history-item suggest-item" data-index="${index}" data-value="${escapeHtml(item.value)}">
        <span class="history-text">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.7"/>
            <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
          <span>${highlight(item.name, item.value)}</span>
        </span>
      </div>`
      )
      .join('');
    dropdown.classList.add('show');
  }

  function renderStatus(text) {
    items = [];
    activeIndex = -1;
    dropdown.innerHTML = `<div class="history-empty">${escapeHtml(text)}</div>`;
    dropdown.classList.add('show');
  }

  function hide() {
    dropdown.classList.remove('show');
    dropdown.innerHTML = '';
    items = [];
    activeIndex = -1;
    // 必须同步清掉 lastTerm,否则"输入 aaa -> 清空 -> 再输入 aaa"时,
    // update() 里的 term === lastTerm 早退会让第二次不发请求
    lastTerm = null;
    clearTimeout(debounceTimer);
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  function setActive(index) {
    const nodes = dropdown.querySelectorAll('.suggest-item');
    nodes.forEach((n, i) => n.classList.toggle('active', i === index));
    activeIndex = index;
    if (nodes[index]) nodes[index].scrollIntoView({ block: 'nearest' });
  }

  async function fetchSuggest(term) {
    if (abortController) abortController.abort();
    abortController = new AbortController();
    const seq = ++requestSeq;

    try {
      const res = await fetch(`/api/suggest?term=${encodeURIComponent(term)}`, {
        signal: abortController.signal,
      });
      const text = await res.text();

      // 请求已被更新的输入取代(或已取消): 丢弃,防止旧结果覆盖新结果
      if (seq !== requestSeq) return;
      if (!res.ok) {
        renderStatus('搜索建议加载失败');
        return;
      }

      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        const matched = JSONP_WRAP_RE.exec(text.trim());
        if (matched) {
          try {
            data = JSON.parse(matched[1]);
          } catch {
            data = null;
          }
        }
      }

      // /api/suggest 返回结构是 { code, list: [{ value, name }] }
      const tags = data && Array.isArray(data.list) ? data.list : [];
      const list = tags
        .map((t) => ({
          value: String(t && t.value != null ? t.value : '').trim(),
          name: t && t.name != null ? String(t.name) : '',
        }))
        .filter((t) => t.value);

      if (!list.length) {
        renderStatus('没有相关的搜索建议');
        return;
      }
      renderList(list);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (seq !== requestSeq) return;
      renderStatus('网络异常,建议加载失败');
    }
  }

  function scheduleSuggest(term) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchSuggest(term), DEBOUNCE_MS);
  }

  function commit(value) {
    const keyword = String(value || '').trim();
    if (!keyword) return;
    input.value = keyword;
    hide();
    // 记入 localStorage 搜索历史(上面的 addHistory)
    try {
      addHistory(keyword);
    } catch {
      // 记历史失败不影响搜索本身
    }
    // 沿用页面原有的表单 submit 路径,保证与手动提交行为一致
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }

  function cancelPending() {
    clearTimeout(debounceTimer);
    lastTerm = null;
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  }

  // 输入框为空显示搜索历史,有内容显示实时建议
  function update() {
    const term = input.value.trim();

    if (!term) {
      cancelPending();
      items = [];
      activeIndex = -1;
      // 必须显式展开下拉框: renderHistory() 只负责填内容,加 show 类是这里的事
      try {
        showHistoryDropdown();
      } catch {
        hide();
      }
      return;
    }

    if (term === lastTerm) return;
    lastTerm = term;
    renderStatus('正在加载...');
    scheduleSuggest(term);
  }

  input.addEventListener('input', update);

  // 补全由 input 事件驱动,聚焦时不再直接调 showHistoryDropdown,
  // 否则空输入框下方会先闪一下历史再被建议替换
  input.addEventListener('focus', update);

  input.addEventListener('keydown', (e) => {
    const shown = dropdown.classList.contains('show') && items.length > 0;

    if (e.key === 'ArrowDown' && shown) {
      e.preventDefault();
      setActive(activeIndex + 1 >= items.length ? 0 : activeIndex + 1);
      return;
    }

    if (e.key === 'ArrowUp' && shown) {
      e.preventDefault();
      setActive(activeIndex - 1 < 0 ? items.length - 1 : activeIndex - 1);
      return;
    }

    if (e.key === 'Escape') {
      hide();
      return;
    }

    if (e.key === 'Enter' && shown && activeIndex >= 0) {
      e.preventDefault();
      commit(items[activeIndex].value);
    }
  });

  // 用 mousedown 而不是 click: click 会先让输入框失焦,下拉框已被点击外部的关闭逻辑收掉,
  // 点在建议项上不会有反应。
  // 下拉框里有两类可点内容,取值字段不同,都要接管:
  //   实时建议 -> .suggest-item + data-value
  //   搜索历史 -> .history-item[data-keyword]
  dropdown.addEventListener('mousedown', (e) => {
    // "× 删除"和"清空"归页面自己的 click 监听处理,这里不能抢:
    // 既不能 preventDefault(按钮会点不动),也不能当成选中历史去提交搜索
    if (e.target.closest('.history-remove') || e.target.closest('#historyClearBtn')) return;

    const suggestItem = e.target.closest('.suggest-item');
    if (suggestItem) {
      e.preventDefault();
      commit(suggestItem.dataset.value);
      return;
    }

    const historyItem = e.target.closest('.history-item[data-keyword]');
    if (historyItem) {
      e.preventDefault();
      commit(historyItem.dataset.keyword);
    }
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) hide();
  });

  // hideHistoryDropdown() 的入口: 收起时要连"正在加载..."占位一起清掉,不能只摘掉 show 类
  window.BiliSuggest = { close: hide };
})();

/* ----------------------------- 登录(扫码登录 B 站账号) -----------------------------
 * 页面可以定义下面这些钩子(定义了才会被调用),把各页不同的部分挂进来:
 *   onLoginStateChanged(state)       renderLoginSlot 开头 —— 记录页面自己的登录态
 *   onUnauthorized(message, silent)  handleUnauthorized 切完状态之后
 *   afterLoginSuccess(data)          扫码登录成功之后
 *   showToast(text, durationMs)      轻提示,各页自己实现(元素与样式不同)
 * -------------------------------------------------------------------- */

const LOGIN_POLL_INTERVAL_MS = 2000;
// 登录态巡检: 每分钟问一次服务器上游登录态是否有效,失效则把右上角从头像切回"登录"按钮
const LOGIN_WATCH_INTERVAL_MS = 60000;
let loginPollTimer = null;
let loginWatchTimer = null;
// 当前浏览器是否已登录 B 站账号。由 renderLoginSlot 维护,页面上的按钮守卫会读它
let isUserLoggedIn = false;

function renderLoginSlot(state) {
  // 登录态的唯一出处:各页的按钮守卫与顶栏浮层都读这个变量,
  // 不能只靠实现了 onLoginStateChanged 的页面去更新它
  isUserLoggedIn = !!(state && state.loggedIn);
  // 顶栏浮层跟着登录态走:刚登录、换号、退出都要丢掉旧数据
  if (window.NavPanels) window.NavPanels.syncLoginState();
  if (typeof onLoginStateChanged === 'function') onLoginStateChanged(state);

  const slot = document.getElementById('loginSlot');
  if (!slot) return;

  if (state && state.loggedIn) {
    const safeName = (state.uname || '').replace(/"/g, '&quot;');
    slot.innerHTML = `
      <a class="user-chip" href="/account" title="个人主页">
        <img class="user-avatar" src="${state.avatar || ''}" referrerpolicy="no-referrer" alt="" onerror="this.style.visibility='hidden'" />
        <span class="user-name" title="${safeName}">${state.uname || ''}</span>
      </a>
    `;
  } else {
    slot.innerHTML = `<button class="login-btn" type="button" onclick="openLoginModal()">登录</button>`;
  }
}

/* 401 的统一处理: 服务端回 401 说明登录态已不可用,立刻切回未登录状态,不用等下一次巡检。
 * code -101 是"刚发现登录过期",提示服务端给的 message;code 1(请先登录)只切状态。
 * silent = true 表示只切状态不提示,用于后台轮询。 */
function handleUnauthorized(message, silent) {
  renderLoginSlot({ loggedIn: false });
  if (typeof onUnauthorized === 'function') onUnauthorized(message, silent);
  if (silent || !message) return;
  if (typeof showToast === 'function') showToast(message, 4000);
}

async function refreshLoginStatus(options) {
  const verify = options && options.verify ? '?verify=1' : '';
  try {
    const res = await fetch(`/api/login/status${verify}`);
    const data = await res.json();
    if (data.loggedIn) {
      renderLoginSlot(data);
      return;
    }
    // 服务端查不到有效登录态: 之前是登录态就走一遍"登录失效"的处理(各页可挂 onUnauthorized),
    // 否则安静切回未登录 —— 用户可能本来就没登录过
    if (isUserLoggedIn) {
      handleUnauthorized(null, true);
      return;
    }
    renderLoginSlot(data);
  } catch (err) {
    console.warn('获取登录状态失败:', err);
  }
}

/* 401 统一拦截: 尽早发现登录态失效并切回未登录状态,后台轮询静默处理 */
const rawFetch = window.fetch.bind(window);
window.fetch = async function (...args) {
  const res = await rawFetch(...args);
  if (res.status === 401) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const background = url.includes('/api/login/status');
    res
      .clone()
      .json()
      .then((data) => handleUnauthorized(data && data.code === -101 ? data.message : null, background))
      .catch(() => handleUnauthorized(null, background));
  }
  return res;
};

// 页面切到后台时不巡检
function startLoginWatch() {
  if (loginWatchTimer) return;
  loginWatchTimer = setInterval(() => {
    if (document.hidden) return;
    refreshLoginStatus({ verify: true });
  }, LOGIN_WATCH_INTERVAL_MS);
}

function openLoginModal() {
  document.getElementById('loginModalMask').style.display = 'flex';
  startLoginFlow();
}

function closeLoginModal() {
  document.getElementById('loginModalMask').style.display = 'none';
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

document.getElementById('loginModalMask').addEventListener('click', (e) => {
  if (e.target.id === 'loginModalMask') closeLoginModal();
});

async function startLoginFlow() {
  const mask = document.getElementById('loginQrcodeMask');
  const maskText = document.getElementById('loginQrcodeMaskText');
  const refreshBtn = document.getElementById('loginRefreshBtn');

  mask.style.display = 'none';
  refreshBtn.style.display = 'none';
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }

  try {
    const res = await fetch('/api/login/qrcode');
    const data = await res.json();
    if (data.code !== 0 || !data.url || !data.qr) {
      throw new Error(data.message || '获取二维码失败');
    }

    // 二维码由服务端生成成 base64 PNG 返回,这里只负责显示,不依赖前端库/CDN
    document.getElementById('loginQrcodeImg').src = data.qr;

    loginPollTimer = setInterval(pollLoginStatus, LOGIN_POLL_INTERVAL_MS);
  } catch (err) {
    mask.style.display = 'flex';
    maskText.textContent = err.message || '获取二维码失败,请重试';
    refreshBtn.style.display = 'inline-block';
  }
}

async function pollLoginStatus() {
  const mask = document.getElementById('loginQrcodeMask');
  const maskText = document.getElementById('loginQrcodeMaskText');
  const refreshBtn = document.getElementById('loginRefreshBtn');

  try {
    const res = await fetch('/api/login/poll');
    const data = await res.json();

    if (data.status === 'scanned') {
      mask.style.display = 'flex';
      refreshBtn.style.display = 'none';
      maskText.textContent = '已扫码,请在手机上确认登录';
      return;
    }
    if (data.status === 'expired') {
      clearInterval(loginPollTimer);
      loginPollTimer = null;
      mask.style.display = 'flex';
      maskText.textContent = '二维码已过期';
      refreshBtn.style.display = 'inline-block';
      return;
    }
    if (data.status === 'success') {
      clearInterval(loginPollTimer);
      loginPollTimer = null;
      renderLoginSlot({ loggedIn: true, uname: data.uname, avatar: data.avatar, uid: data.uid });
      closeLoginModal();
      // 登录成功后的页面级刷新,由各页的 afterLoginSuccess 接管
      if (typeof afterLoginSuccess === 'function') afterLoginSuccess(data);
      return;
    }
    // 尚未扫码,继续轮询,不改界面
    mask.style.display = 'none';
  } catch (err) {
    console.warn('轮询登录状态失败:', err);
  }
}

/* ----------------------------- 顶栏入口的悬停浮层 -----------------------------
 * 历史记录 / 收藏夹 / 动态按钮悬停(或键盘聚焦)时展开面板,把接口第一页整页列出来,点条目进播放页。
 * 动态那颗只列"投稿视频"(上游 type=video 分类):其余动态没有封面,画不成下面这种行。
 * 数据只在首次展开时拉,成功后缓存在内存里;失败不缓存,收起后再悬停会重试。
 * 未登录也能展开,面板里给一句"登录后可查看…"和登录入口,点了开扫码登录弹窗。
 * -------------------------------------------------------------------- */

(function () {
  const OPEN_DELAY_MS = 120;
  // 鼠标从按钮挪到面板要越过 8px 空隙,收起晚一点才不会误关
  const CLOSE_DELAY_MS = 180;

  const ENTRIES = [
    {
      type: 'history',
      btnId: 'navHistoryBtn',
      headText: '历史记录',
      moreText: '查看全部历史',
      moreHref: '/account?tab=history',
      emptyText: '暂无观看历史',
    },
    {
      type: 'favorites',
      btnId: 'navFavBtn',
      headText: '收藏夹',
      moreText: '查看全部收藏夹',
      moreHref: '/account?tab=favorites',
      emptyText: '这个收藏夹还是空的',
    },
    {
      // 只放投稿视频:动态流里图文/纯文字没有封面,画不成下面这种行
      type: 'videos',
      btnId: 'navDynamicBtn',
      headText: '动态',
      moreText: '查看全部动态',
      moreHref: '/dynamic',
      emptyText: '关注的 UP 主最近没投稿',
    },
  ];

  let ignoreFocusOpen = false;

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 标题在服务端过了一遍 sanitizeTitle(只会残留成对的 <em class="keyword">),可以直插;
  // 进 title 属性时先去标签再转义
  function textOf(html) {
    return String(html == null ? '' : html).replace(/<[^>]*>/g, '');
  }

  // 时长:接口给秒数,但历史上也有 "mm:ss" 字符串,统一换算成秒
  function parseSeconds(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const str = String(value == null ? '' : value).trim();
    if (!str) return 0;
    if (!str.includes(':')) return parseInt(str, 10) || 0;
    const parts = str.split(':').map((p) => parseInt(p, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  function fmtDuration(value) {
    const total = parseSeconds(value);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtCount(num) {
    const n = Number(num) || 0;
    if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
    return String(n);
  }

  // 收藏时间:同年只给月-日,跨年再带年份(与个人主页的收藏夹卡片一致)
  function fmtFavTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return '';
    const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return d.getFullYear() === new Date().getFullYear() ? date : `${d.getFullYear()}-${date}`;
  }

  function playerHref(bvid, page, seek) {
    const params = new URLSearchParams();
    params.set('bv', bvid);
    if (page && page > 1) params.set('p', String(page));
    if (seek && seek > 0) params.set('t', String(seek));
    return `/player?${params.toString()}`;
  }

  function rowHTML(type, item) {
    // 失效收藏(被删/下架)不给 href,点了不跳
    const invalid = type === 'favorites' && item.valid === false;
    const total = parseSeconds(item.duration);
    let pct = null;
    let seenText = '';
    // 观看进度只有历史记录有;动态视频与收藏夹都只显示总时长
    if (type === 'history') {
      if (item.progress < 0) {
        pct = 100;
        seenText = '已看完';
      } else if (item.progress > 0) {
        pct = total > 0 ? Math.min(100, (item.progress / total) * 100) : null;
        seenText = pct != null ? `看到 ${Math.round(pct)}%` : `看到 ${fmtDuration(item.progress)}`;
      }
    }
    // 时长角标:看过一点的历史显示"上次到哪 / 总时长",其余只显示总时长
    const durationText = type === 'history' && item.progress > 0
      ? `${fmtDuration(item.progress)} / ${fmtDuration(total)}`
      : fmtDuration(total);
    const meta = (type === 'history'
      ? [item.author, seenText]
      : type === 'videos'
        ? [item.author, item.pubTime]
        : [item.author, item.favTime ? `收藏于 ${fmtFavTime(item.favTime)}` : '', invalid ? '视频已失效' : '']
    ).filter(Boolean).join(' · ');
    const href = playerHref(item.bvid, item.page, type === 'history' && item.progress > 0 ? item.progress : 0);

    return `
      <a class="nav-panel-row"${invalid ? '' : ` href="${esc(href)}"`} title="${esc(textOf(item.title))}">
        <span class="nav-panel-thumb">
          <img src="${esc(item.pic)}" loading="lazy" alt="" referrerpolicy="no-referrer" onerror="this.style.opacity=0" />
          <span class="nav-panel-dur">${durationText}</span>
          ${pct != null ? `<span class="nav-panel-track"><span style="width:${pct.toFixed(1)}%"></span></span>` : ''}
        </span>
        <span class="nav-panel-info">
          <span class="nav-panel-title">${item.title || ''}</span>
          ${meta ? `<span class="nav-panel-meta">${esc(meta)}</span>` : ''}
        </span>
      </a>
    `;
  }

  function render(entry, loggedIn) {
    entry.headTitle.textContent = entry.type === 'favorites' ? (entry.folderName || entry.headText) : entry.headText;
    entry.headCount.textContent = entry.type === 'favorites' && entry.folderCount
      ? `共 ${fmtCount(entry.folderCount)} 个`
      : '';

    // 未登录:列表位置换成一句提示 + 登录入口,"查看全部"也收起(那页同样看不了)
    entry.prompt.style.display = loggedIn ? 'none' : 'flex';
    entry.foot.style.visibility = loggedIn ? '' : 'hidden';
    if (!loggedIn) {
      entry.promptText.textContent = entry.type === 'history'
        ? '登录后可查看历史记录'
        : entry.type === 'videos'
          ? '登录后可查看关注动态'
          : '登录后可查看收藏夹';
      entry.listBox.innerHTML = '';
      return;
    }

    if (entry.loading && !entry.list.length) {
      entry.listBox.innerHTML = `<div class="nav-panel-empty">正在加载...</div>`;
    } else if (entry.error) {
      entry.listBox.innerHTML = `<div class="nav-panel-empty">${esc(entry.error)}</div>`;
    } else if (!entry.list.length) {
      entry.listBox.innerHTML = `<div class="nav-panel-empty">${esc(entry.emptyText)}</div>`;
    } else {
      entry.listBox.innerHTML = entry.list.map((item) => rowHTML(entry.type, item)).join('');
    }
  }

  async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json();
    // 401 由本文件包装的 fetch 统一处理(切回未登录 + 清掉浮层缓存),这里只当加载失败
    if (!data || data.code !== 0) throw new Error((data && data.message) || '加载失败');
    return data;
  }

  async function load(entry) {
    if (entry.type === 'history') {
      const data = await getJson('/api/account/history?max=0&view_at=0');
      return { list: data.list || [] };
    }
    if (entry.type === 'videos') {
      const data = await getJson('/api/dynamics?type=video');
      // 动态卡片里的投稿视频与历史/收藏夹条目同样有 bvid/page/duration,直接复用行模板
      const list = (data.list || [])
        .filter((item) => item.card && item.card.kind === 'video' && item.card.bvid)
        .map((item) => ({
          bvid: item.card.bvid,
          page: 0,
          title: item.card.title,
          author: item.author && item.author.name,
          // 发布日期直接用动态接口给的相对时间("3天前"/"9月24日"),与动态页一致
          pubTime: item.author && item.author.time,
          pic: item.card.cover,
          duration: item.card.duration,
          progress: 0,
          valid: true,
        }));
      return { list };
    }
    const folders = await getJson('/api/account/favorites');
    const all = folders.list || [];
    // attr 的 bit1 为 0 才是默认收藏夹(上游把它排在最前)
    const folder = all.find((f) => ((f.attr || 0) & 2) === 0) || all[0];
    if (!folder) return { list: [] };
    const data = await getJson(`/api/account/favorites/${encodeURIComponent(folder.id)}?pn=1`);
    return { list: data.list || [], title: data.title || folder.title || '', count: data.mediaCount || 0 };
  }

  function ensureData(entry) {
    // 未登录不请求(接口只会回 401),面板里由 render 换成"登录后可查看…"
    if (!isUserLoggedIn || entry.loaded || entry.loading) return;
    entry.loading = true;
    entry.error = '';
    render(entry, true); // 先把"正在加载..."画上
    load(entry)
      .then((data) => {
        entry.list = data.list || [];
        if (data.title != null) entry.folderName = data.title;
        if (data.count != null) entry.folderCount = data.count;
        entry.loaded = true;
      })
      .catch((err) => {
        entry.error = err.message || '加载失败';
      })
      .then(() => {
        entry.loading = false;
        render(entry, true);
      });
  }

  function openPanel(entry) {
    if (entry.open) return;
    // 两个浮层只开一个
    ENTRIES.forEach((other) => closePanel(other));
    entry.open = true;
    entry.panel.classList.add('show');
    entry.btn.setAttribute('aria-expanded', 'true');
    // 未登录也能开:render 会把列表换成"登录后可查看…"
    ensureData(entry);
    render(entry, isUserLoggedIn);
  }

  function closePanel(entry) {
    if (!entry || !entry.open) return;
    clearTimeout(entry.openTimer);
    entry.open = false;
    entry.panel.classList.remove('show');
    entry.btn.setAttribute('aria-expanded', 'false');
  }

  ENTRIES.forEach((entry) => {
    entry.btn = document.getElementById(entry.btnId);
    if (!entry.btn) return;

    entry.loading = false;
    entry.loaded = false;
    entry.error = '';
    entry.list = [];
    entry.folderName = '';
    entry.folderCount = 0;
    entry.open = false;
    entry.openTimer = null;
    entry.closeTimer = null;

    // 按钮外面包一层,让"按钮 + 浮层"成为同一个悬停区域
    const wrap = document.createElement('div');
    wrap.className = 'nav-pop';
    entry.btn.parentNode.insertBefore(wrap, entry.btn);
    wrap.appendChild(entry.btn);

    const panel = document.createElement('div');
    panel.className = 'nav-panel';
    panel.innerHTML = `
      <div class="nav-panel-head">
        <span class="nav-panel-head-title"></span>
        <span class="nav-panel-head-count"></span>
      </div>
      <div class="nav-panel-list"></div>
      <div class="nav-panel-empty nav-panel-prompt" style="display:none;">
        <span class="nav-panel-prompt-text"></span>
        <button class="nav-panel-login" type="button">登录</button>
      </div>
      <a class="nav-panel-foot" href="${entry.moreHref}">${entry.moreText}</a>
    `;
    wrap.appendChild(panel);

    entry.panel = panel;
    entry.headTitle = panel.querySelector('.nav-panel-head-title');
    entry.headCount = panel.querySelector('.nav-panel-head-count');
    entry.listBox = panel.querySelector('.nav-panel-list');
    entry.prompt = panel.querySelector('.nav-panel-prompt');
    entry.promptText = panel.querySelector('.nav-panel-prompt-text');
    entry.foot = panel.querySelector('.nav-panel-foot');
    entry.btn.setAttribute('aria-haspopup', 'true');
    entry.btn.setAttribute('aria-expanded', 'false');

    // 未登录时面板里的"登录":开扫码登录弹窗,面板不收
    entry.prompt.querySelector('.nav-panel-login').addEventListener('click', () => openLoginModal());

    wrap.addEventListener('mouseenter', () => {
      clearTimeout(entry.closeTimer);
      clearTimeout(entry.openTimer);
      // 只是划过不请求数据,所以展开也晚一点
      entry.openTimer = setTimeout(() => openPanel(entry), OPEN_DELAY_MS);
    });
    wrap.addEventListener('mouseleave', () => {
      clearTimeout(entry.openTimer);
      clearTimeout(entry.closeTimer);
      entry.closeTimer = setTimeout(() => closePanel(entry), CLOSE_DELAY_MS);
    });
    // 键盘:Tab 聚焦按钮即展开,焦点离开整个包裹元素才收起
    wrap.addEventListener('focusin', () => {
      if (ignoreFocusOpen) {
        ignoreFocusOpen = false;
        return;
      }
      clearTimeout(entry.closeTimer);
      openPanel(entry);
    });
    wrap.addEventListener('focusout', (e) => {
      if (!wrap.contains(e.relatedTarget)) closePanel(entry);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const opened = ENTRIES.find((entry) => entry.open);
    if (!opened) return;
    closePanel(opened);
    // 焦点可能正落在面板里,收起后还给按钮;本来就焦点在按钮上时不会再触发 focusin
    if (document.activeElement !== opened.btn) {
      ignoreFocusOpen = true;
      opened.btn.focus();
    }
  });

  // 登录态快照:和它不一致说明刚登录/换号/退出,缓存与展开状态都不能留
  let loggedInSnapshot = false;

  window.NavPanels = {
    // 由 renderLoginSlot 在每次刷新登录态后调用
    syncLoginState() {
      if (isUserLoggedIn === loggedInSnapshot) return;
      loggedInSnapshot = isUserLoggedIn;
      window.NavPanels.reset();
    },
    // 数据要么属于上一个账号,要么是未登录时那句"登录后可查看…",都丢掉,下次展开按新状态重画
    reset() {
      ENTRIES.forEach((entry) => {
        closePanel(entry);
        entry.loaded = false;
        entry.loading = false;
        entry.error = '';
        entry.list = [];
      });
    },
  };
})();
