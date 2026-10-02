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
