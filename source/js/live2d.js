/* ── 看板娘 ────────────────────────────────────────────────────────────────
   右下角一个 Live2D 小人，点开能说话。人设走站里那份 skill 的访客版。

   几处刻意的选择：
   - 全部 DOM 由脚本创建，不改主题模板，也不改 layout.pug。
   - 首屏之后才加载，模型 1.8 MB + 引擎 770 KB，不能拖慢首屏。
   - 手机上不自动加载，先给一个小圆点，点了才下模型。
   - 容器 pointer-events: none，只有人物躯干那一小块热区可点。
   ------------------------------------------------------------------------ */
(function () {
  'use strict';

  if (window.__l2dBooted) return;
  window.__l2dBooted = true;

  var CFG = {
    vendor: '/live2d/vendor/',
    model: '/live2d/models/feiyu/feiyu.model3.json',
    api: '/api/chat',
    delay: 2600,
    turns: 8
  };

  var STATE = {
    booting: false,
    ready: false,
    open: false,
    busy: false,
    speaking: false,
    interacted: false,
    history: []
  };

  /* 被摸头的反应。轻一点，别一惊一乍：她只是被人顺手摸了一下。 */
  var PATS = [
    '……干嘛',
    '头发要乱了',
    '唔',
    '摸头长不高的',
    '就一下啊',
    '你手挺凉'
  ];

  var GREETINGS = [
    '来了，随便看',
    '想聊什么？站里的事我大概都知道',
    '六篇，写的都是踩过的坑',
    '有问题问我，答不上来我会说不知道',
    '慢点看，不着急',
    '这站空过十个月，最近才有点人气'
  ];

  var el = {};
  var app = null;
  var model = null;
  var raf = 0;
  var anim = null;
  var lastReact = 0;
  var mix = {};        /* 参数 → 当前叠加量 */
  var lastTick = 0;
  var hover = 0;       /* 悬停强度 0..1，单独一条平滑曲线 */
  var hoverOn = false;
  var hoverTimer = 0;

  /* 拖动：pos 是「从右下角往左上偏多少」，永远 >= 0。
     不用 left/top，是因为容器本来就是 right:0; bottom:0，
     换成 left/top 还要在 resize 时重算；而 translate 不参与布局，
     拖的时候不会触发重排，气泡和热区作为 .l2d 的 absolute 子节点
     也会自动跟着走。 */
  var DRAG = { minDist: 4, key: 'l2d-pos-v1' };
  var pos = { x: 0, y: 0 };
  var drag = { on: false, id: 0, sx: 0, sy: 0, ox: 0, oy: 0,
               moved: false, justDragged: false };

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* ── 动作 ──────────────────────────────────────────────────────────────
     这套模型作者只给了表情，没有 motion 文件。本来可以自己写 motion3.json，
     但 pixi-live2d-display 一旦开始播 motion 就会跳过自动眨眼——她会一直
     瞪着不眨眼。所以动作直接在主循环里用缓动函数推参数：每帧写一次，
     Cubism 下一帧自己重置回默认值，互不干扰，眨眼照常。

     参数方向是实测出来的：AngleY 正 = 低头、负 = 抬头；AngleX 正 = 转向
     画面左侧；AngleZ 正 = 向左歪头。身体角度和手臂都是物理输出，写了也会
     被物理覆盖，所以只用头部和五官。 */
  function smooth(u, a, b) {
    if (u <= a) return 0;
    if (u >= b) return 1;
    var x = (u - a) / (b - a);
    return x * x * (3 - 2 * x);
  }

  function hold(u, a, b) {
    return smooth(u, 0, a) * (1 - smooth(u, b, 1));
  }

  var ANIMS = {
    /* 点头：先快后慢地低一下 */
    nod: { dur: 1.05, fn: function (u) {
      var b = Math.sin(Math.PI * u);
      b = b * b;
      return { ParamAngleY: 15 * b, ParamAngleZ: -1.6 * b };
    } },

    /* 摇头：左右各一个来回，两头淡入淡出 */
    shake: { dur: 1.5, fn: function (u) {
      var env = Math.sin(Math.PI * u);
      var x = 13 * Math.sin(2 * Math.PI * 1.7 * u) * env;
      return { ParamAngleX: x, ParamAngleZ: -x * 0.18 };
    } },

    /* 歪头：抬起来停一会儿，眼睛跟着往左上瞟 */
    tilt: { dur: 2.6, fn: function (u) {
      var h = hold(u, 0.16, 0.78);
      return {
        ParamAngleZ: 16 * h,
        ParamAngleX: 3.5 * h,
        ParamEyeBallY: 0.32 * h,
        ParamEyeBallX: -0.2 * h,
        ParamBrowLY: 0.22 * h
      };
    } },

    /* 思考：歪头 + 眼睛往右上 + 抿嘴 */
    think: { dur: 2.8, fn: function (u) {
      var h = hold(u, 0.14, 0.82);
      return {
        ParamAngleZ: 10 * h,
        ParamAngleY: -4.5 * h,
        ParamEyeBallY: 0.5 * h,
        ParamEyeBallX: 0.3 * h,
        ParamBrowLY: 0.3 * h,
        ParamBrowRY: 0.3 * h,
        ParamMouthForm: 0.2 * h
      };
    } },

    /* 惊讶：抬头、张嘴、挑眉，带一点抖 */
    surprise: { dur: 1.0, fn: function (u) {
      var b = Math.sin(Math.PI * Math.pow(u, 0.72));
      return {
        ParamAngleY: -11 * b,
        ParamAngleZ: 2.2 * Math.sin(4 * Math.PI * u) * b,
        ParamMouthOpenY: 0.5 * b,
        ParamBrowLY: 0.85 * b,
        ParamBrowRY: 0.85 * b
      };
    } },

    /* 打盹：慢慢低头闭眼，最后惊醒抬头 */
    sleepy: { dur: 3.6, fn: function (u) {
      var wake = smooth(u, 0.84, 0.94);
      var k = smooth(u, 0.06, 0.42) * (1 - wake);
      var shut = smooth(u, 0.3, 0.5) * (1 - smooth(u, 0.86, 0.93));
      return {
        ParamAngleY: 13 * k,
        ParamAngleZ: 5 * k,
        ParamEyeLOpen: 1 - 0.94 * shut,
        ParamEyeROpen: 1 - 0.94 * shut,
        ParamMouthOpenY: 0.12 * shut
      };
    } },

    /* 开心：闭眼笑，微微抬头 */
    happy: { dur: 1.5, fn: function (u) {
      var b = Math.sin(Math.PI * u);
      var e = Math.min(1, b * 1.6);
      return {
        ParamAngleY: -5 * b,
        ParamEyeSmile: 0.9 * e,
        ParamEyeLOpen: 1 - 0.9 * e,
        ParamEyeROpen: 1 - 0.9 * e,
        ParamMouthOpenY: 0.22 * b,
        ParamMouthForm: 0.55 * b
      };
    } },

    /* 瞽一眼：眼球先过去，头慢半拍跟上，眼睛先收回来 */
    glance: { dur: 2.2, fn: function (u) {
      var eye = smooth(u, 0.02, 0.16) * (1 - smooth(u, 0.70, 0.86));
      var head = smooth(u, 0.16, 0.44) * (1 - smooth(u, 0.74, 0.96));
      return {
        ParamEyeBallX: -0.72 * eye,
        ParamEyeBallY: 0.2 * eye,
        ParamAngleX: -12 * head,
        ParamAngleY: -3 * head,
        ParamAngleZ: 3 * head
      };
    } },

    /* 叹气：低头、眼睛半闭、嘴角往下、眉毛内侧压 */
    sigh: { dur: 3.0, fn: function (u) {
      var h = hold(u, 0.20, 0.70);
      return {
        ParamAngleY: 11 * h,
        ParamAngleZ: -3.5 * h,
        ParamEyeLOpen: 1 - h,
        ParamEyeROpen: 1 - h,
        ParamMouthForm: -0.55 * h,
        ParamBrowLAngle: 0.3 * h,
        ParamBrowRAngle: 0.3 * h,
        ParamBrowLY: -0.2 * h,
        ParamBrowRY: -0.2 * h
      };
    } },

    /* 鼓嘴：把头别开、嘴角往下拉、眼睛耷下来 */
    pout: { dur: 2.6, fn: function (u) {
      var h = hold(u, 0.14, 0.80);
      return {
        ParamAngleX: 14 * h,
        ParamAngleY: 3 * h,
        ParamAngleZ: 6 * h,
        ParamMouthForm: -0.8 * h,
        ParamMouthX: 0.35 * h,
        ParamBrowLY: -0.35 * h,
        ParamBrowRY: -0.35 * h
      };
    } },

    /* 吓一跳：猛地抬头、挑眉、张嘴，然后带一点抖地回落 */
    startle: { dur: 0.9, fn: function (u) {
      var env = u < 0.14 ? u / 0.14 : Math.pow(1 - (u - 0.14) / 0.86, 2);
      return {
        ParamAngleY: -18 * env,
        ParamAngleZ: 4.5 * Math.sin(7 * Math.PI * u) * env,
        ParamMouthOpenY: 0.45 * env,
        ParamBrowLY: 1 * env,
        ParamBrowRY: 1 * env
      };
    } },

    /* 害羞：低头别开脸、脸红、眼神往下躲 */
    shy: { dur: 3.0, fn: function (u) {
      var h = hold(u, 0.18, 0.78);
      return {
        ParamAngleY: 8 * h,
        ParamAngleX: -11 * h,
        ParamAngleZ: 7 * h,
        ParamEyeBallX: -0.5 * h,
        ParamEyeBallY: -0.3 * h,
        PARAM_EXP4: h,
        ParamMouthForm: 0.35 * h,
        ParamBrowLY: 0.2 * h,
        ParamBrowRY: 0.2 * h
      };
    } },

    /* 打哈欠：仰头、闭眼、张大嘴 */
    yawn: { dur: 3.4, fn: function (u) {
      var open = smooth(u, 0.10, 0.30) * (1 - smooth(u, 0.72, 0.86));
      var shut = smooth(u, 0.14, 0.34) * (1 - smooth(u, 0.74, 0.88));
      return {
        ParamAngleY: -13 * open,
        ParamAngleZ: 3 * open,
        ParamEyeLOpen: 1 - shut,
        ParamEyeROpen: 1 - shut,
        ParamMouthOpenY: 0.8 * open,
        ParamBrowLY: 0.45 * open,
        ParamBrowRY: 0.45 * open
      };
    } }
  };

  /* 点她的时候随机挑一个。nod / tilt / glance 权重高一点，太爱演反而吵。 */
  var REACTIONS = [
    'nod', 'nod', 'nod', 'tilt', 'tilt', 'glance', 'glance',
    'shake', 'sigh', 'pout', 'surprise', 'startle', 'shy', 'yawn', 'happy', 'sleepy'
  ];
  var lastReaction = '';

  function react(name) {
    var a = ANIMS[name];
    if (!a) return;
    lastReact = Date.now();
    anim = { t0: performance.now(), dur: a.dur * 1000, fn: a.fn };
  }

  function reactRandom() {
    var n = pick(REACTIONS);
    if (n === lastReaction) n = pick(REACTIONS);
    lastReaction = n;
    react(n);
  }

  /* 没人理她的时候，隔十几二十秒自己动一下，像 Hiyori 那几段循环待机。
     不常驻：常驻会一直压着光标跟随，鼠标一动她就僵在那里。 */
  var QUIET = ['glance', 'glance', 'sigh', 'tilt', 'yawn', 'pout'];
  var idleTimer = 0;

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (STATE.ready && !STATE.busy && !anim && Date.now() - lastReact > 6000) {
        react(pick(QUIET));
      }
      scheduleIdle();
    }, 14000 + Math.random() * 14000);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('脚本加载失败 ' + src)); };
      document.head.appendChild(s);
    });
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  /* 她得知道自己在哪一页。pjax 换页后 location 会变，所以每次现算。 */
  function contextLine() {
    var title = (document.title || '').split('|')[0].trim();
    var path = location.pathname;
    if (path.indexOf('/post/') === 0 && title) {
      return '这篇《' + title + '》，看完了？有不懂的问我';
    }
    if (path.indexOf('/music/') === 0) return '在听歌啊，歌单是我接的';
    if (path === '/' || path === '/index.html') return '欢迎，上面几篇都是最近写的';
    if (path.indexOf('/archives') === 0) return '都在这儿了，按时间排的';
    return '';
  }

  function buildDom() {
    var root = document.createElement('div');
    root.className = 'l2d';
    root.id = 'l2d';
    root.innerHTML =
      '<div class="l2d-canvas">' +
      '  <img class="l2d-preview" src="/live2d/models/feiyu/preview.webp" alt="" decoding="async">' +
      '</div>' +
      '<div class="l2d-bar" aria-hidden="true"><i></i></div>' +
      '<div class="l2d-head" role="button" aria-label="摸摸头"></div>' +
      '<div class="l2d-hit" role="button" tabindex="0" aria-label="跟看板娘说话"></div>' +
      '<div class="l2d-bubble" hidden>' +
      '  <div class="l2d-cloud" aria-hidden="true"><i></i><i></i><span class="l2d-tail"></span></div>' +
      '  <div class="l2d-inner">' +
      '    <p class="l2d-text"></p>' +
      '    <form class="l2d-form">' +
      '      <input class="l2d-input" type="text" maxlength="120" autocomplete="off" ' +
      '             enterkeyhint="send" placeholder="跟她说点什么…" aria-label="对看板娘说的话">' +
      '      <button class="l2d-send" type="submit" aria-label="发送">→</button>' +
      '    </form>' +
      '  </div>' +
      '</div>' +
      '<button class="l2d-trigger" type="button" hidden aria-label="叫看板娘出来">风</button>';

    document.body.appendChild(root);

    el.root = root;
    el.canvas = root.querySelector('.l2d-canvas');
    el.preview = root.querySelector('.l2d-preview');
    el.head = root.querySelector('.l2d-head');
    el.hit = root.querySelector('.l2d-hit');
    el.bubble = root.querySelector('.l2d-bubble');
    el.text = root.querySelector('.l2d-text');
    el.form = root.querySelector('.l2d-form');
    el.input = root.querySelector('.l2d-input');
    el.send = root.querySelector('.l2d-send');
    el.trigger = root.querySelector('.l2d-trigger');

    el.hit.addEventListener('click', onPoke);
    el.hit.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPoke(); }
    });

    /* 摸头：头顶单独一块热区，因为它不在身体热区的范围内。
       这块不给 tabindex——摸头是彩蛋，键盘用户走身体热区就好，
       多一个 Tab 停靠点反而让人迷惑。 */
    el.head.addEventListener('click', onPat);

    /* 悬停：两块热区各绑一对，用 80ms 延迟关闭避免从头顶滑到身体时
       中间那一下 leave 把状态抖断。 */
    [el.head, el.hit].forEach(function (node) {
      node.addEventListener('pointerenter', onHoverIn);
      node.addEventListener('pointerleave', onHoverOut);

      /* 拖动。两块热区都能拖，拖的是整个容器。
         setPointerCapture 之后 move/up 会一直发到按下时那个节点，
         拖出热区、拖到屏幕边上都不会断。 */
      node.addEventListener('pointerdown', onDragStart);
      node.addEventListener('pointermove', onDragMove);
      node.addEventListener('pointerup', onDragEnd);
      node.addEventListener('pointercancel', onDragEnd);
    });
    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = el.input.value;
      el.input.value = '';
      ask(q);
    });
    el.trigger.addEventListener('click', function () {
      el.trigger.hidden = true;
      boot();
    });

    document.addEventListener('click', function (e) {
      if (!STATE.open) return;
      if (el.root.contains(e.target)) return;
      closeBubble();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && STATE.open) closeBubble();
    });
  }

  function openBubble() {
    STATE.open = true;
    el.bubble.hidden = false;
    requestAnimationFrame(function () {
      el.bubble.classList.add('is-open');
    });
  }

  function closeBubble() {
    STATE.open = false;
    el.bubble.classList.remove('is-open');
    setTimeout(function () {
      if (!STATE.open) el.bubble.hidden = true;
    }, 240);
  }

  function say(text) {
    el.text.classList.remove('is-typing');
    el.text.textContent = text;
    el.text.scrollTop = 0;
  }

  function onPoke() {
    if (drag.justDragged) { drag.justDragged = false; return; }
    if (STATE.busy) return;
    STATE.interacted = true;

    if (STATE.open) {
      say(pick(GREETINGS));
    } else {
      openBubble();
      say(contextLine() || pick(GREETINGS));
    }

    reactRandom();

    /* 气泡可能已经被自动打招呼打开，所以聚焦不能写在 else 里，
       否则第一次点她只会换一句词，光标不进输入框。 */
    setTimeout(function () {
      if (!STATE.busy) {
        try { el.input.focus(); } catch (e) {}
      }
    }, 280);
  }

  function onHoverIn() {
    /* 拖着走的时候别抬眼看你，手一抖就会在拖和看之间反复横跳 */
    if (drag.on) return;
    clearTimeout(hoverTimer);
    hoverOn = true;
  }

  function onHoverOut() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () { hoverOn = false; }, 80);
  }

  /* ── 拖动 ──────────────────────────────────────────────────────────────
     她默认钉在右下角，但那块地方有时候正好压着正文、按钮或者返回顶部。
     拖开就行，位置存本地，下次进来还在那儿。

     拖动和点击靠位移阈值分开：超过 4px 才算拖，否则还是点击。
     拖过之后的那个 click 必须吞掉，不然一松手就弹出气泡。 */
  /* 气泡是 absolute 相对 .l2d 定位的，而且比容器宽（240 vs 258/300）、
     往上长。拖到边上之后点她，气泡会整个跑到屏幕外，看着就像「点了
     没反应」。所以拖动范围里得把气泡那块的量预留出来。

     横向：气泡 right 对齐容器中心，左边缘落在容器左边界外
           (240 − 宽/2) 的地方，宽 258 时是 111px。
     纵向：气泡最高约 200px（文字区 max-height 168 + padding + 输入框）。 */
  function bubbleRoom() {
    var w = el.root.offsetWidth;
    var bw = Math.min(240, window.innerWidth - 40);   /* 跟 CSS 的 max-width 一致 */
    return {
      x: Math.max(0, bw - w * 0.5),
      y: 200
    };
  }

  function clampPos(x, y) {
    var room = bubbleRoom();
    var maxX = Math.max(0, window.innerWidth - el.root.offsetWidth - room.x);
    var maxY = Math.max(0, window.innerHeight - el.root.offsetHeight - room.y);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY)
    };
  }

  function setPos(x, y, save) {
    var p = clampPos(x, y);
    pos.x = p.x;
    pos.y = p.y;

    /* 回到原点就把 transform 摘掉，不写一个 0,0 的 translate */
    el.root.style.transform = (pos.x || pos.y)
      ? 'translate3d(' + (-pos.x).toFixed(1) + 'px,' + (-pos.y).toFixed(1) + 'px,0)'
      : '';

    if (save) {
      try {
        localStorage.setItem(DRAG.key, JSON.stringify({
          x: Math.round(pos.x), y: Math.round(pos.y)
        }));
      } catch (e) {}
    }
  }

  function loadPos() {
    try {
      var raw = localStorage.getItem(DRAG.key);
      if (!raw) return;
      var o = JSON.parse(raw);
      /* 换了小屏进来时原来的位置可能已经在屏幕外，setPos 里会再夹一道 */
      if (o && isFinite(o.x) && isFinite(o.y)) setPos(o.x, o.y);
    } catch (e) {}
  }

  function onDragStart(e) {
    /* 只认左键。触摸和笔没有 button 概念，不拦 */
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    drag.on = true;
    drag.id = e.pointerId;
    drag.sx = e.clientX;
    drag.sy = e.clientY;
    drag.ox = pos.x;
    drag.oy = pos.y;
    drag.moved = false;
    drag.justDragged = false;

    /* 拖动时把「抬眼看你」压下去，不然她一路仰着头被你拖 */
    hoverOn = false;
    clearTimeout(hoverTimer);

    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function onDragMove(e) {
    if (!drag.on || e.pointerId !== drag.id) return;

    var dx = e.clientX - drag.sx;
    var dy = e.clientY - drag.sy;

    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG.minDist) return;
      drag.moved = true;
      el.root.classList.add('is-dragging');
    }

    /* 鼠标往左走 dx 是负的，她也要往左，所以是 ox - dx */
    setPos(drag.ox - dx, drag.oy - dy);
  }

  function onDragEnd(e) {
    if (!drag.on) return;
    drag.on = false;
    el.root.classList.remove('is-dragging');

    if (drag.moved) {
      /* 留给紧跟其后的那个 click：吞掉它，别一松手就开气泡 */
      drag.justDragged = true;
      setPos(pos.x, pos.y, true);
    }

    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}

    /* 松手时指针可能还停在她身上，把悬停接回来 */
    if (el.hit.matches(':hover') || el.head.matches(':hover')) {
      clearTimeout(hoverTimer);
      hoverOn = true;
    }
  }

  function onPat() {
    if (drag.justDragged) { drag.justDragged = false; return; }
    if (STATE.busy) return;
    STATE.interacted = true;

    /* 摸头时把悬停压下去。不然「抬眼看你」和「闭眼笑」叠在一起，
       头会先抬再笑，反而怪。动作做完鼠标没动，也就不会重新触发。 */
    hoverOn = false;
    clearTimeout(hoverTimer);

    if (!STATE.open) openBubble();
    say(pick(PATS));
    react(Math.random() < 0.55 ? 'happy' : 'shy');

    /* 不抢焦点：摸头是顺手一下，不是要跟她说话。 */
  }

  function boot() {
    if (STATE.booting || STATE.ready) return;
    STATE.booting = true;

    if (!el.root) buildDom();
    loadPos();

    /* 先让静态图出来顶着。9.4 MB 的 moc3 在慢网下要二十几秒，
       空着右下角会让人以为坏了。 */
    el.root.classList.add('is-on');

    loadScript(CFG.vendor + 'pixi.min.js')
      .then(function () { return loadScript(CFG.vendor + 'cubismcore5.min.js'); })
      .then(function () { return loadScript(CFG.vendor + 'cubism4.min.js'); })
      .then(initModel)
      .then(function () {
        STATE.ready = true;
        STATE.booting = false;
        el.root.classList.add('is-ready');
        document.body.classList.add('l2d-on');
        el.trigger.hidden = true;
        maybeGreet();
        scheduleIdle();
      })
      .catch(function (err) {
        STATE.booting = false;
        console.warn('[l2d]', err && err.message);
        el.trigger.hidden = false;
      });
  }

  function initModel() {
    var w = el.canvas.clientWidth || 280;
    var h = el.canvas.clientHeight || 400;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    app = new PIXI.Application({
      width: w,
      height: h,
      resolution: dpr,
      autoDensity: true,
      backgroundAlpha: 0,
      antialias: true,
      powerPreference: 'low-power'
    });
    el.canvas.appendChild(app.view);
    app.view.style.width = '100%';
    app.view.style.height = '100%';

    return PIXI.live2d.Live2DModel.from(CFG.model, { autoInteract: false })
      .then(function (m) {
        model = m;
        app.stage.addChild(m);
        layout();

        /* 三件事都写在渲染前，顺序不能乱：Cubism 每帧会把参数重置回默认值，
           设一次不保持，只能每帧按住。

           时机很关键。库里的 update 是这样跑的：动作 → 表情 → 眨眼 → 物理
           → 发 beforeModelUpdate → coreModel.update() 算网格 → loadParameters()
           把参数还原。所以写在 ticker 或渲染前都会被还原掉，眼睛闭不上、
           嘴张不开。beforeModelUpdate 是唯一“物理算完、网格还没算”的缝隙。

           1) 水印：作者把「带水印 / 无水印」做成两套部件，靠 Paramcol_3 切。
           2) 动作：见上面 ANIMS。
           3) 口型：说话时驱动 ParamMouthOpenY。放最后，说话时口型优先。 */
        var core = null;
        var mouthPhase = 0;
        var wasSpeaking = false;
        try { core = m.internalModel.coreModel; } catch (e) {}

        /* 调试钩子：控制台里能直接摸参数，验收脚本也靠它。 */
        window.__l2d = { app: app, model: m, core: core };

        if (core) {
          m.internalModel.on('beforeModelUpdate', function () {
            try { core.setParameterValueById('Paramcol_3', 1); } catch (e) {}

            /* 动作是「叠加」在模型算出来的姿势上的，不是覆盖。

               直接覆盖会出两个问题，看着就是头在闪：
               1) 模型每帧先算完光标跟随和呼吸，我们再把头角度盖成 0 起步，
                  动作一结束又弹回视线角度——起落各跳一下；
               2) 上一个动作没放完就被下一个打断时，头先归零再起。

               所以只写差值，而且用一个 70ms 左右的时间常数淡入淡出：
               打断时从当前叠加量直接往新目标走，中间不经过 0。 */
            var now = performance.now();
            var dt = lastTick ? Math.min(now - lastTick, 120) : 16.7;
            lastTick = now;
            var ease = 1 - Math.exp(-dt / 70);

            var target = null;
            if (anim) {
              var u = (now - anim.t0) / anim.dur;
              if (u >= 1) anim = null;
              else target = anim.fn(u);
            }

            /* 悬停：抬眼看你。走单独一条 180ms 曲线，比动作的 70ms 慢，
               不然鼠标一扫过去她就像被弹了一下。 */
            hover += ((hoverOn ? 1 : 0) - hover) * (1 - Math.exp(-dt / 180));
            if (hover > 0.003) {
              if (!target) target = {};
              target.ParamAngleY = (target.ParamAngleY || 0) - 5 * hover;
              target.ParamAngleZ = (target.ParamAngleZ || 0) + 2.2 * hover;
              target.ParamEyeBallY = (target.ParamEyeBallY || 0) + 0.14 * hover;
              target.ParamBrowLY = (target.ParamBrowLY || 0) + 0.34 * hover;
              target.ParamBrowRY = (target.ParamBrowRY || 0) + 0.34 * hover;
              target.ParamMouthForm = (target.ParamMouthForm || 0) + 0.1 * hover;
            }

            var k;
            if (target) {
              for (k in target) if (!(k in mix)) mix[k] = 0;
            }

            for (k in mix) {
              var tv = (target && k in target) ? target[k] : 0;
              mix[k] += (tv - mix[k]) * ease;
              if (Math.abs(mix[k]) < 0.002 && tv === 0) {
                delete mix[k];
                continue;
              }
              try {
                /* 叠加不能超范围：光标停在角落时 focus 已经 +20°，再叠 18° 就破了。 */
                var idx = core.getParameterIndex(k);
                var v = core.getParameterValueById(k) + mix[k];
                if (idx >= 0) {
                  var lo = core.getParameterMinimumValue(idx);
                  var hi = core.getParameterMaximumValue(idx);
                  if (v < lo) v = lo;
                  if (v > hi) v = hi;
                }
                core.setParameterValueById(k, v);
              } catch (e) {}
            }

            if (STATE.speaking) {
              wasSpeaking = true;
              mouthPhase += 0.34;
              var v = Math.abs(Math.sin(mouthPhase)) * (0.45 + 0.35 * Math.abs(Math.sin(mouthPhase * 0.41)));
              try { core.setParameterValueById('ParamMouthOpenY', v * 0.7); } catch (e) {}
            } else if (wasSpeaking) {
              wasSpeaking = false;
              try { core.setParameterValueById('ParamMouthOpenY', 0); } catch (e) {}
            }
          });
        }

        bindFocus();
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('resize', debounce(function () {
          resize();
        }, 220));
      });
  }

  function layout() {
    if (!model || !app) return;
    var w = app.renderer.width / app.renderer.resolution;
    var h = app.renderer.height / app.renderer.resolution;
    var im = model.internalModel;
    var scale = (h * 0.99) / im.originalHeight;
    model.anchor.set(0.5, 1);
    model.scale.set(scale);
    model.x = w * 0.5;
    model.y = h;
  }

  function resize() {
    if (!app || !model) return;
    var w = el.canvas.clientWidth;
    var h = el.canvas.clientHeight;
    if (!w || !h) return;
    app.renderer.resize(w, h);
    layout();
    /* 窗口变小后存的位置可能已经在屏幕外，重新夹一道 */
    if (el.root) setPos(pos.x, pos.y);
  }

  function onVisibility() {
    if (!app) return;
    if (document.hidden) app.ticker.stop();
    else app.ticker.start();
  }

  /* 视线跟随。

     不用 model.focus()。它收的是舞台坐标，内部走 toModelPosition → 归一化
     → atan2 → 取单位向量，所以：
       1) 传 -1..1 这种归一化值，等于说「画布左上角附近的某个点」，方向恒定
          指向左上，她会一直斜着眼看左边；
       2) 它永远返回单位向量，算不出「正前方」，focus(0,0) 同样指左上。

     直接驱动 focusController，它收的才是 -1..1：x 正 = 看画面右侧，
     y 正 = 低头（ParamAngleY 正为低头，实测）。方向按模型中心算，
     这样鼠标在她右边她就往右看，而不是按视口中心算。 */
  function bindFocus() {
    document.addEventListener('pointermove', function (e) {
      if (!model || !app) return;
      if (raf) return;
      var cx = e.clientX, cy = e.clientY;
      raf = requestAnimationFrame(function () {
        raf = 0;
        try {
          var r = app.view.getBoundingClientRect();
          var ox = r.left + r.width * 0.5;
          var oy = r.top + r.height * 0.5;

          /* 按「到哪一侧边界」分别归一化，不能用视口半宽除：
             她在右下角，右边只剩一百多像素，统一除半宽的话鼠标推到最右
             也只有 0.1 的偏移，看着像没反应。 */
          var dx = cx - ox, dy = cy - oy;
          var fx = dx >= 0 ? dx / Math.max(1, window.innerWidth - ox)
                           : dx / Math.max(1, ox);
          var fy = dy >= 0 ? dy / Math.max(1, window.innerHeight - oy)
                           : dy / Math.max(1, oy);

          model.internalModel.focusController.focus(fx * 0.85, fy * 0.85);
        } catch (err) {}
      });
    }, { passive: true });

    /* 鼠标移出窗口时把视线收回正前方。这里必须是 focusController 的 (0,0)，
       走 model.focus 会得到左上角。 */
    function recenter() {
      if (!model) return;
      try { model.internalModel.focusController.focus(0, 0); } catch (err) {}
    }

    document.addEventListener('pointerout', function (e) {
      if (e.relatedTarget || e.toElement) return;
      recenter();
    });

    window.addEventListener('blur', recenter);
  }

  function maybeGreet() {
    var KEY = 'l2d-greeted';
    try {
      if (sessionStorage.getItem(KEY)) return;
      sessionStorage.setItem(KEY, '1');
    } catch (e) {}

    setTimeout(function () {
      if (STATE.open) return;
      openBubble();
      say(contextLine() || pick(GREETINGS));
      react('happy');
      /* 用户一旦自己点开过，就不再自动收 */
      setTimeout(function () {
        if (!STATE.busy && !STATE.interacted) closeBubble();
      }, 5200);
    }, 1600);
  }

  function setBusy(b) {
    STATE.busy = b;
    STATE.speaking = b;
    el.send.disabled = b;
  }

  function ask(raw) {
    var q = String(raw || '').trim();
    if (!q || STATE.busy) return;
    if (q.length > 120) q = q.slice(0, 120);

    if (!STATE.open) openBubble();
    STATE.interacted = true;

    setBusy(true);
    react('think');
    el.text.textContent = '';
    el.text.classList.add('is-typing');

    var msgs = STATE.history.concat([{ role: 'user', content: q }]).slice(-CFG.turns * 2);

    fetch(CFG.api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: msgs })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = '';
          try { msg = JSON.parse(t).error || ''; } catch (e) { msg = ''; }
          throw new Error(msg || ('HTTP ' + res.status));
        });
      }
      return readStream(res);
    }).then(function (full) {
      el.text.classList.remove('is-typing');
      setBusy(false);
      react('nod');
      if (full) {
        STATE.history.push({ role: 'user', content: q });
        STATE.history.push({ role: 'assistant', content: full });
        STATE.history = STATE.history.slice(-CFG.turns * 2);
      } else {
        say('……我走神了，再说一遍？');
      }
    }).catch(function (err) {
      el.text.classList.remove('is-typing');
      setBusy(false);
      say(errorLine(err));
    });
  }

  function readStream(res) {
    if (!res.body || !res.body.getReader) {
      return res.text().then(function (t) {
        el.text.textContent = t;
        return t;
      });
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    var full = '';

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return full;
        buf += decoder.decode(r.value, { stream: true });

        var idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line || line.charAt(0) === ':') continue;
          if (line.indexOf('data:') !== 0) continue;

          var payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          try {
            var j = JSON.parse(payload);
            var d = j.choices && j.choices[0] && j.choices[0].delta;
            var t = d && d.content;
            if (t) {
              full += t;
              el.text.textContent = full;
              el.text.scrollTop = el.text.scrollHeight;
            }
          } catch (e) {}
        }
        return pump();
      });
    }

    return pump();
  }

  function errorLine(err) {
    var m = String((err && err.message) || '');
    if (m.indexOf('no-key') >= 0) return '我还没接上脑子，站主没给我配钥匙，先这样吧';
    if (m.indexOf('quota') >= 0) return '今天说太多了，明天再来';
    if (m.indexOf('rate') >= 0) return '你问得有点快，等我一下';
    return '连不上了，可能是我这边的问题，等会儿再试';
  }

  function schedule() {
    var isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
      if (!el.root) buildDom();
      el.trigger.hidden = false;
      return;
    }
    setTimeout(boot, CFG.delay);
  }

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule);

  document.addEventListener('pjax:complete', function () {
    if (STATE.ready && !document.getElementById('l2d')) {
      STATE.ready = false;
      STATE.booting = false;
      window.__l2dBooted = false;
      buildDom();
      boot();
    }
  });
})();
