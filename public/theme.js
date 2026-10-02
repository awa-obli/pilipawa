/* 主题(亮/暗)。
   放在 <head> 里同步执行:首次绘制前就把 data-theme 写到 <html> 上,
   否则深色用户会先看到一帧白底。配色变量都在 common.css 里。 */
(function () {
  'use strict';

  const THEME_KEY = 'bili_theme';
  const THEMES = ['light', 'dark'];

  function normalize(theme) {
    return THEMES.includes(theme) ? theme : 'light';
  }

  function readTheme() {
    try {
      return normalize(localStorage.getItem(THEME_KEY));
    } catch (err) {
      // 隐私模式下 localStorage 不可用,退回浅色
      return 'light';
    }
  }

  // 设置页调用:立即生效并记住,写不进 localStorage 也不影响本次切换
  window.setTheme = function (theme) {
    const next = normalize(theme);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (err) {
      /* 忽略 */
    }
    return next;
  };

  document.documentElement.dataset.theme = readTheme();
})();
