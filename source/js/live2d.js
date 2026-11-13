/* ── 看板娘 ────────────────────────────────────────────────────────────────
   右下角一个 Live2D 小人，点开能说话。人设走站里那份 skill 的访客版。

   几处刻意的选择：
   - 全部 DOM 由脚本创建，不改主题模板，也不改 layout.pug。
   - 首屏之后才加载，模型 17 MB + 引擎 770 KB，不能拖慢首屏。
   - 手机上不自动加载，先给一个小圆点，点了才下模型。
   - 容器 pointer-events: none，只有人物躯干那一小块热区可点。
   ------------------------------------------------------------------------ */
(function () {
  'use strict';

  if (window.__l2dBooted) return;
  window.__l2dBooted = true;

  var CFG = {
    vendor: '/live2d/vendor/',
    model: '/live2d/models/dafeiyu/model.model3.json',
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

  var GREETINGS = [
    '来了。随便看。',
    '想聊什么？站里的事我大概都知道。',
    '六篇，写的都是踩过的坑。',
    '有问题问我。答不上来我会说不知道。',
    '慢点看，不着急。',
    '这站空过十个月，最近才有点人气。'
  ];

  var el = {};
  var app = null;
  var model = null;
  var raf = 0;

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
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
      return '这篇《' + title + '》。看完了？有不懂的问我。';
    }
    if (path.indexOf('/music/') === 0) return '在听歌啊。歌单是我接的。';
    if (path === '/' || path === '/index.html') return '欢迎。上面几篇都是最近写的。';
    if (path.indexOf('/archives') === 0) return '都在这儿了，按时间排的。';
    return '';
  }

  function buildDom() {
    var root = document.createElement('div');
    root.className = 'l2d';
    root.id = 'l2d';
    root.innerHTML =
      '<div class="l2d-canvas">' +
      '  <img class="l2d-preview" src="/live2d/models/dafeiyu/preview.webp" alt="" decoding="async">' +
      '</div>' +
      '<div class="l2d-bar" aria-hidden="true"><i></i></div>' +
      '<div class="l2d-hit" role="button" tabindex="0" aria-label="跟看板娘说话"></div>' +
      '<div class="l2d-bubble" hidden>' +
      '  <p class="l2d-text"></p>' +
      '  <form class="l2d-form">' +
      '    <input class="l2d-input" type="text" maxlength="120" autocomplete="off" ' +
      '           enterkeyhint="send" placeholder="跟她说点什么…" aria-label="对看板娘说的话">' +
      '    <button class="l2d-send" type="submit" aria-label="发送">→</button>' +
      '  </form>' +
      '</div>' +
      '<button class="l2d-trigger" type="button" hidden aria-label="叫看板娘出来">风</button>';

    document.body.appendChild(root);

    el.root = root;
    el.canvas = root.querySelector('.l2d-canvas');
    el.preview = root.querySelector('.l2d-preview');
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
    if (STATE.busy) return;
    STATE.interacted = true;

    if (STATE.open) {
      say(pick(GREETINGS));
    } else {
      openBubble();
      say(contextLine() || pick(GREETINGS));
    }

    /* 气泡可能已经被自动打招呼打开，所以聚焦不能写在 else 里，
       否则第一次点她只会换一句词，光标不进输入框。 */
    setTimeout(function () {
      if (!STATE.busy) {
        try { el.input.focus(); } catch (e) {}
      }
    }, 280);
  }

  function boot() {
    if (STATE.booting || STATE.ready) return;
    STATE.booting = true;

    if (!el.root) buildDom();

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

        /* 两件事都挂在同一根 ticker 上：Cubism 每帧会把参数和部件不透明度
           重置回默认值，设一次不保持，只能每帧按住。

           1) 第 16 个部件是鼻梁上一小块黑色贴片。作者自己的宣传图里没有它，
              应该是导出时没关掉的辅助件，这里按住不让它显示。
           2) 说话时驱动 ParamMouthOpenY，让嘴动起来。不发声，只是给个节奏。 */
        var core = null;
        var mouthPhase = 0;
        var wasSpeaking = false;
        try { core = m.internalModel.coreModel; } catch (e) {}

        if (core) {
          app.ticker.add(function () {
            try { core.setPartOpacityByIndex(16, 0); } catch (e) {}

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

        try {
          m.internalModel.motionManager.groups.idle = 'Idle';
          m.internalModel.motionManager.startRandomMotion('Idle');
        } catch (e) {}

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
  }

  function onVisibility() {
    if (!app) return;
    if (document.hidden) app.ticker.stop();
    else app.ticker.start();
  }

  function bindFocus() {
    document.addEventListener('pointermove', function (e) {
      if (!model) return;
      var fx = (e.clientX / window.innerWidth) * 2 - 1;
      var fy = (e.clientY / window.innerHeight) * 2 - 1;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        try { model.focus(fx * 0.7, -fy * 0.7); } catch (err) {}
      });
    }, { passive: true });
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
      if (full) {
        STATE.history.push({ role: 'user', content: q });
        STATE.history.push({ role: 'assistant', content: full });
        STATE.history = STATE.history.slice(-CFG.turns * 2);
      } else {
        say('……我走神了。再说一遍？');
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
    if (m.indexOf('no-key') >= 0) return '我还没接上脑子。站主没给我配钥匙，先这样吧。';
    if (m.indexOf('quota') >= 0) return '今天说太多了，明天再来。';
    if (m.indexOf('rate') >= 0) return '你问得有点快，等我一下。';
    return '连不上了。可能是我这边的问题，等会儿再试。';
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
