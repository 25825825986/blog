/*!
 * 笔尖光标 · 跳转后自动恢复
 *
 * 现象：点导航 / 链接跳转后，鼠标变成系统箭头；不移动鼠标就一直保持箭头，
 *      随手晃一下才变回笔尖。
 *
 * 原因不在 CSS。光标形状是浏览器按「鼠标命中测试」算出来的，而命中测试只在
 * 两种情况重做：① 收到真实的鼠标事件；② 样式重算把光标属性标脏。整页跳转
 * 时浏览器会先把光标重置成默认值（旧文档马上销毁，hover 状态失效），新文档
 * 加载完又没有鼠标事件，于是一直停在默认箭头上 —— 直到你移动鼠标。
 *
 * 做法：页面显示后，把 html 的 cursor 换成一个「字符串不同、渲染结果相同」的
 * 值，逼浏览器重做一次命中测试，下一帧再把控制权交还给 effects.css。
 * 因为 SVG 正常加载时末尾那个 fallback 关键字根本用不到，所以视觉上零变化。
 */
(function () {
  'use strict';

  // 触屏、没有精确指针的设备不存在光标，跳过
  if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    return;
  }

  // 与 effects.css 中 html 的声明保持一致，只把末尾的 auto 换成 default
  var PROBE = 'url("/img/cursor-nib.svg") 2 2, url("/img/cursor-nib.png") 2 2, default';

  function refreshCursor() {
    var root = document.documentElement;
    var previous = root.style.cursor;
    if (previous === PROBE) return;

    root.style.cursor = PROBE;

    // 双 rAF：第一帧让 PROBE 真正参与渲染（浏览器在这一帧重做命中测试），
    // 第二帧再撤掉 inline style，回到 CSS 里的声明。
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        root.style.cursor = previous;
      });
    });
  }

  // pageshow 同时覆盖首次加载、刷新，以及从 bfcache 后退回来
  window.addEventListener('pageshow', refreshCursor);
})();
