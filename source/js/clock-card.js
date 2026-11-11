/* ============================================================================
 * source/js/clock-card.js —— 侧边栏「时光」时间卡片
 * ----------------------------------------------------------------------------
 * 把浏览器本地时间写进卡片，每秒一次；农历和节气按天刷新（同一天不重算）。
 * 不请求任何接口，不依赖时区配置，不引入第三方库。
 *
 * 几个细节：
 *   1. 页面切到后台时停掉定时器，回来再重启（省电，也避免后台标签页每秒重排）。
 *   2. Butterfly 开了 pjax，侧边栏会整块替换，所以 pjax:complete 后要重新取元素；
 *      同时把「上次算农历的日期」清掉，否则新元素会一直是空的。
 *   3. 农历/节气依赖 lunar.js，它没加载成功就只显示时间，不影响卡片其余部分。
 * ========================================================================== */
(function () {
  'use strict';

  var WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  var timer = null;
  var el = {};
  /* 记录上次渲染农历时的日期，跨天或 pjax 换元素时才重算 */
  var lastDay = '';

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /* 按小时给一句问候，比干巴巴显示时间多一点人味 */
  function greeting(h) {
    if (h < 5) return '夜深了，早点休息';
    if (h < 9) return '早上好';
    if (h < 12) return '上午好';
    if (h < 13) return '中午好';
    if (h < 18) return '下午好';
    if (h < 23) return '晚上好';
    return '夜深了，早点休息';
  }

  function cache() {
    el.hm = document.getElementById('clock-hm');
    el.sec = document.getElementById('clock-sec');
    el.date = document.getElementById('clock-date');
    el.fill = document.getElementById('clock-fill');
    el.greet = document.getElementById('clock-greet');
    el.pct = document.getElementById('clock-pct');
    el.lunar = document.getElementById('clock-lunar');
    el.jieqi = document.getElementById('clock-jieqi');
    return !!(el.hm && el.sec && el.date);
  }

  /* ── 农历 / 节气：一天只算一次 ─────────────────────────────────────────── */
  function renderLunar(now) {
    var key = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    if (key === lastDay) return;
    lastDay = key;

    var L = window.Lunar;
    if (!L) return;

    var lu = L.solarToLunar(now);
    if (el.lunar) el.lunar.textContent = lu ? lu.text : '';

    if (!el.jieqi) return;
    var today = L.jieQiOf(now);
    if (today) {
      /* 当天就是节气，单独用主色标出来 */
      el.jieqi.textContent = '今日 ' + today;
      el.jieqi.classList.add('is-today');
    } else {
      var next = L.nextJieQi(now);
      el.jieqi.textContent = next ? '距 ' + next.name + ' 还有 ' + next.days + ' 天' : '';
      el.jieqi.classList.remove('is-today');
    }
  }

  function render() {
    var now = new Date();
    var h = now.getHours();
    var m = now.getMinutes();
    var s = now.getSeconds();

    el.hm.textContent = pad(h) + ':' + pad(m);
    el.sec.textContent = pad(s);
    el.date.textContent =
      now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' +
      WEEK[now.getDay()];

    /* 今日进度：0 点到现在占一整天的比例 */
    var ratio = (h * 3600 + m * 60 + s) / 86400;
    if (el.fill) el.fill.style.width = (ratio * 100).toFixed(2) + '%';
    if (el.greet) el.greet.textContent = greeting(h);
    if (el.pct) el.pct.textContent = '今日 ' + Math.floor(ratio * 100) + '%';

    renderLunar(now);
  }

  function start() {
    /* pjax 会换掉整块侧边栏，元素变了就强制重算一次农历 */
    lastDay = '';
    if (!cache()) return;
    render();
    stop();
    timer = setInterval(render, 1000);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  document.addEventListener('pjax:complete', start);
})();
