(function () {
  var POS_KEY = 'music-dock-pos';
  /* Cover proxy: netease originals are low-res; route them through
     /meting/cover for LANCZOS resize + sharpen, cached server-side.
     Idempotent so an already-proxied src passes through unchanged.
     Falls back to the raw URL if the proxy ever fails. */
  function coverUrl(u) {
    if (!u) return '';
    if (u.indexOf('/meting/cover') === 0 || u.indexOf('data:') === 0) return u;
    if (/^https?:\/\//.test(u) && /music\.126\.net\//.test(u)) {
      return '/meting/cover?url=' + encodeURIComponent(u);
    }
    return u;
  }
  function setCover(img, raw) {
    if (!img || !raw) return;
    var proxied = coverUrl(raw);
    img.onerror = function () {
      img.onerror = null;
      if (proxied !== raw) img.src = raw;
    };
    if (img.getAttribute('src') !== proxied) img.src = proxied;
  }
  /* 播放进度记忆：记住「哪首歌 + 听到第几秒」，刷新或下次进站接着听。
     只存歌名/歌手/秒数，不存播放地址——网易云的地址带时效签名，几十分钟就失效，
     下次进来必须重新向服务端要一份新的。 */
  var STATE_KEY = 'music-last-state';
  var STATE_TTL = 60 * 864e5;   /* 超过 60 天的记录直接丢弃 */
  var SAVE_GAP = 4000;          /* timeupdate 很密，最多每 4 秒落一次盘 */
  var RESUME_MIN = 5;           /* 少于 5 秒不值得续播，当从头开始 */
  /* ── 歌单 ────────────────────────────────────────────────────────────────
   * 支持多个歌单。默认按 uid 自动拉取该账号「自己创建」的公开歌单
   * （/meting/?type=playlists&uid=...），所以以后在网易云新建歌单，博客刷新
   * 就能看到，不用改代码。
   *
   * PLAYLISTS 是兜底：自动拉取失败时只用它。想完全手动维护就把 PLAYLIST_UID
   * 置空，然后在这份数组里一条一个歌单地写。
   * ---------------------------------------------------------------------- */
  var PLAYLIST_UID = '2096160621';
  var PLAYLISTS = [
    { id: '13102236224', name: '安静', cover: '', count: 0 }
  ];
  /* 首次访问默认停在哪个歌单。不指定的话会落到列表第一项（那是
     「我喜欢的音乐」），博客门面还是「安静」更合适。 */
  var DEFAULT_PL = '13102236224';
  /* 记住上次选的是哪个歌单（存 id，不存下标——歌单增减后下标会漂） */
  var PL_KEY = 'music-playlist';
  /* 旧版进度记忆没有歌单维度，迁移时归到这个歌单名下 */
  var LEGACY_PL = '13102236224';
  var plIndex = 0;
  var plGen = 0;
  /* 用 injahow 这个源：同一歌单在 i-meto 上有近半数播放地址返回 404（版权），
     这里 51 首全部可播。不同源的字段名不一致，loadPlaylist() 里做了归一化。 */
  /* 解析服务地址，按顺序尝试：
     1) /meting/ —— 自建（/opt/meting/server.js），与博客同源，无第三方依赖；
     2) 备用 —— 自建服务挂了也不至于整个音乐页白屏。
     换源只改这个数组，渲染逻辑不用动。 */
  var METING_APIS = [
    '/meting/',
    'https://api.injahow.cn/meting/',
    'https://api.i-meto.com/meting/api'
  ];
  var MUSIC_PATHS = ['/music', '/music/index.html'];

  var ICONS = {
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9.28a4 4 0 1 0 2 3.46V7h4V3h-6z"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6L18 18V6z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>'
  };

  var dock, coverBtn, coverImg, titleEl, artistEl, playBtn, barEl;
  var timelineEl, timelineFill, timelineDot, timeEl;
  var pageEl, rowsEl;
  var audio = null;
  var playlist = [];
  var index = 0;
  var failCount = 0;
  var loading = false;
  var dragging = false;
  var moved = false;
  var start = { x: 0, y: 0, left: 0, top: 0 };
  var pendingSeek = 0;   /* 下次 load 之后要跳到的秒数（续播用） */
  var currentKey = '';   /* 当前播放曲目的「歌名|歌手」，与列表下标解耦 */
  var lastSaveAt = 0;    /* 上次落盘时间，用来给 timeupdate 节流 */

  /* ---------------------------------------------------------- 进度记忆 */

  function trackKey(item) {
    return (item.title || '') + '|' + (item.author || '');
  }

  /* 进度按歌单分开存：{ 歌单id: {key,index,time,...} }。
     一个歌单一条，切来切去各自都记得自己听到哪。 */
  function stateMap() {
    var raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    } catch (e) {
      return {};
    }
    if (!raw || typeof raw !== 'object') return {};
    /* 旧版是单条记录，没有歌单维度，迁到当时那个歌单名下 */
    if (typeof raw.time === 'number' && raw.key) {
      var m = {};
      m[LEGACY_PL] = raw;
      return m;
    }
    return raw;
  }

  function readState() {
    var v = stateMap()[currentPl().id];
    if (!v || typeof v !== 'object') return null;
    if (typeof v.time !== 'number' || !isFinite(v.time) || v.time < 0) return null;
    if (v.at && Date.now() - v.at > STATE_TTL) return null;
    return v;
  }

  function writeState(obj) {
    var m = stateMap();
    m[currentPl().id] = obj;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(m));
    } catch (e) {
      /* 隐私模式 / 配额满：记忆失效，但不该影响播放本身 */
    }
  }

  function saveState(force) {
    /* index < 0：当前播放的曲目不属于这个列表（刚切走歌单），
       这时不能记，否则会把上一首的进度写到新歌单名下 */
    if (!audio || !audio.src || !playlist.length || index < 0) return;
    var now = Date.now();
    if (!force && now - lastSaveAt < SAVE_GAP) return;
    lastSaveAt = now;

    var item = playlist[index] || {};
    var dur = isFinite(audio.duration) ? audio.duration : 0;
    var t = audio.currentTime || 0;
    /* 已经听到结尾的别再记，否则下次一进来就「续播」到最后一秒 */
    if (dur && t > dur - 2) t = 0;

    writeState({
      key: trackKey(item),
      index: index,
      time: Math.round(t * 10) / 10,
      duration: Math.round(dur),
      title: item.title || '',
      author: item.author || '',
      at: now
    });
  }

  function findSavedIndex(v) {
    if (!v || !playlist.length) return -1;
    /* 先按「歌名 + 歌手」找：歌单增删后下标会漂，只认下标容易续到别的歌 */
    if (v.key) {
      for (var i = 0; i < playlist.length; i++) {
        if (trackKey(playlist[i]) === v.key) return i;
      }
    }
    /* 歌名对不上，说明这首已经从歌单里删了。这时不要拿旧下标硬凑，
       否则会把「别的歌」续播到上次那首的秒数上，听起来就是莫名其妙跳了一段。 */
    if (v.key) return -1;

    /* 没有 key 的旧记录才退到下标 */
    if (typeof v.index === 'number' && v.index >= 0 && v.index < playlist.length) {
      return v.index;
    }
    return -1;
  }

  /* 歌单到手后调用：把「上次听到哪」写回界面，但不加载音频（不产生请求） */
  function applySavedState() {
    var v = readState();
    if (!v || !playlist.length) return;
    var i = findSavedIndex(v);
    if (i < 0) return;

    index = i;
    pendingSeek = v.time >= RESUME_MIN ? v.time : 0;

    var item = playlist[index];
    currentKey = trackKey(item);
    titleEl.textContent = item.title || '未知曲目';
    if (item.pic) {
      setCover(coverImg, item.pic);
      coverBtn.classList.add('has-cover');
    }
    if (pendingSeek > 0) {
      artistEl.textContent = '上次听到 ' + fmtTime(pendingSeek) + ' · 点播放继续';
      /* 未播放时把进度条也停在上次的位置，比空着一条线更直观 */
      var dur = (typeof v.duration === 'number' && v.duration > 0) ? v.duration : 0;
      if (dur) {
        var pct = Math.min(100, (pendingSeek / dur) * 100);
        if (barEl) barEl.style.width = pct + '%';
        if (timelineFill) timelineFill.style.width = pct + '%';
        if (timelineDot) timelineDot.style.left = pct + '%';
        if (timeEl) timeEl.textContent = fmtTime(pendingSeek) + ' / ' + fmtTime(dur);
      }
    } else {
      artistEl.textContent = item.author || '点播放继续';
    }
    highlightRow();
    syncPlayAllLabel();
  }

  /* 首次播放（audio 还没有 src）时走这里：有进度就接着听 */
  function resume() {
    if (!playlist.length) {
      artistEl.textContent = loading ? '正在载入歌单…' : '点这里重试载入歌单';
      loadPlaylist();
      return;
    }
    var t = pendingSeek;
    if (!t) {
      load(index || 0, true);
      return;
    }
    load(index, false, t);
    audio.play().catch(function (err) {
      console.warn('[music] 续播被拦截', err);
    });
  }

  /* 音乐页「播放全部」按钮：有待续播进度时改成「继续播放」 */
  function syncPlayAllLabel() {
    if (!pageEl) return;
    var btn = pageEl.querySelector('[data-act="playall"]');
    if (!btn) return;
    var span = btn.querySelector('span');
    if (!span) return;
    var canResume = pendingSeek > 0 && audio && !audio.src;
    span.textContent = canResume ? '继续播放 ' + fmtTime(pendingSeek) : '播放全部';
  }

  /* ---------------------------------------------------------- 多歌单 */

  function currentPl() {
    return PLAYLISTS[plIndex] || PLAYLISTS[0] || { id: '', name: '歌单', cover: '', count: 0 };
  }

  function readSavedPl() {
    try { return localStorage.getItem(PL_KEY) || ''; } catch (e) { return ''; }
  }

  function applySavedPl() {
    var id = readSavedPl() || DEFAULT_PL;
    for (var i = 0; i < PLAYLISTS.length; i++) {
      if (PLAYLISTS[i].id === id) { plIndex = i; return; }
    }
  }

  /* 拉账号下的公开歌单列表。失败就保持兜底列表不动，不影响播放。 */
  function discoverPlaylists() {
    if (!PLAYLIST_UID) return Promise.resolve(null);
    var url = METING_APIS[0] + '?server=netease&type=playlists&uid=' + PLAYLIST_UID;
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) throw new Error('返回空列表');
        return list.map(function (p) {
          return {
            id: String(p.id),
            name: p.name || '未命名歌单',
            cover: p.cover || '',
            count: p.count || 0
          };
        });
      })
      .catch(function (err) {
        console.warn('[music] 歌单列表拉取失败，用内置列表', err);
        return null;
      });
  }

  /* 切换歌单：只换列表，不动播放器。
     正在听的那首继续放着，只有点列表里的具体曲目才会切歌。 */
  function switchPlaylist(i) {
    if (i === plIndex || !PLAYLISTS[i]) return;

    /* 先把旧歌单听到哪记下来，再清空——顺序反了会存成空记录 */
    saveState(true);

    var hasTrack = !!(audio && audio.src);
    /* 记住当前这首是谁：切回它所在的歌单时，把高亮落回它身上 */
    var curKey = hasTrack ? currentKey : '';

    plIndex = i;
    try { localStorage.setItem(PL_KEY, PLAYLISTS[i].id); } catch (e) {}

    playlist = [];
    /* -1：当前曲目不在这个列表里，避免 next/prev 按下标取到别的歌 */
    if (hasTrack) index = -1;
    pendingSeek = 0;
    failCount = 0;
    loading = true;   /* 先置位，空列表才不会闪一下「加载失败」 */

    updateHero();
    renderTabs();
    renderRows();

    loadPlaylist(true).then(function (list) {
      if (!list || !list.length) return;
      if (hasTrack) {
        if (curKey) {
          for (var k = 0; k < playlist.length; k++) {
            if (trackKey(playlist[k]) === curKey) { index = k; highlightRow(); break; }
          }
        }
      } else {
        /* 播放器本来是空的，才让它落到这个歌单的上次进度；
           正在放歌时保持原样，不打断 */
        applySavedState();
      }
    });
  }

  function bootstrap() {
    discoverPlaylists().then(function (list) {
      if (list && list.length) PLAYLISTS = list;
      applySavedPl();
      updateHero();
      renderTabs();
      loadPlaylist();
    });
  }

  function isMusicPage() {
    var p = location.pathname.replace(/\/+$/, '');
    return MUSIC_PATHS.indexOf(p) !== -1;
  }

  function build() {
    dock = document.createElement('div');
    dock.id = 'music-dock';
    dock.className = 'music-dock';
    dock.innerHTML = [
      '<button class="music-dock__cover" type="button" aria-label="音乐播放器">',
      '<img alt="">',
      '<span class="music-dock__icon">' + ICONS.note + '</span>',
      '</button>',
      '<div class="music-dock__body">',
      '<div class="music-dock__meta">',
      '<span class="music-dock__title">未在播放</span>',
      '<span class="music-dock__artist">点开球载入歌单</span>',
      '</div>',
      '<div class="music-dock__actions">',
      '<button class="music-dock__btn" type="button" data-act="prev" aria-label="上一首">' + ICONS.prev + '</button>',
      '<button class="music-dock__btn music-dock__btn--play" type="button" data-act="play" aria-label="播放">' + ICONS.play + '</button>',
      '<button class="music-dock__btn" type="button" data-act="next" aria-label="下一首">' + ICONS.next + '</button>',
      '</div>',
      '<div class="music-dock__timeline" role="slider" tabindex="0" aria-label="播放进度">',
      '<span class="music-dock__timeline-track"></span>',
      '<span class="music-dock__timeline-fill"></span>',
      '<span class="music-dock__timeline-dot"></span>',
      '</div>',
      '<span class="music-dock__time">0:00 / 0:00</span>',
      '</div>',
      '<div class="music-dock__progress"><span></span></div>'
    ].join('');
    document.body.appendChild(dock);

    coverBtn = dock.querySelector('.music-dock__cover');
    coverImg = coverBtn.querySelector('img');
    titleEl = dock.querySelector('.music-dock__title');
    artistEl = dock.querySelector('.music-dock__artist');
    playBtn = dock.querySelector('[data-act="play"]');
    barEl = dock.querySelector('.music-dock__progress span');
    timelineEl = dock.querySelector('.music-dock__timeline');
    timelineFill = dock.querySelector('.music-dock__timeline-fill');
    timelineDot = dock.querySelector('.music-dock__timeline-dot');
    timeEl = dock.querySelector('.music-dock__time');
  }

  function clamp() {
    if (!dock) return;
    var w = dock.offsetWidth || 56;
    var h = dock.offsetHeight || 56;
    var x = parseFloat(dock.style.left) || 0;
    var y = parseFloat(dock.style.top) || 0;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    dock.style.left = x + 'px';
    dock.style.top = y + 'px';
  }

  function restorePos() {
    var saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    } catch (e) {}
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      dock.style.left = saved.x + 'px';
      dock.style.top = saved.y + 'px';
    } else {
      dock.style.left = '24px';
      dock.style.top = Math.max(24, window.innerHeight - 96) + 'px';
    }
    clamp();
  }

  function toggleOpen(force) {
    var open = typeof force === 'boolean' ? force : !dock.classList.contains('open');
    if (open && !isMusicPage()) {
      var rect = dock.getBoundingClientRect();
      if (rect.left + 328 > window.innerWidth - 8) {
        dock.style.left = Math.max(8, window.innerWidth - 328 - 8) + 'px';
      }
    }
    dock.classList.toggle('open', open);
    // 首次加载失败（网络抖动 / API 超时）时，展开面板顺手重试一次
    if (open && !playlist.length && !loading) loadPlaylist();
  }

  function load(i, autoplay, resumeAt) {
    if (!playlist.length) return;
    index = (i + playlist.length) % playlist.length;
    var item = playlist[index];
    currentKey = trackKey(item);
    npPlayingItem = item; npPlayingListName = currentPl().name || "";
    /* 只有「续播」这一条路径会带 resumeAt；点歌、上一首、下一首一律从头放 */
    pendingSeek = (typeof resumeAt === 'number' && resumeAt > 0) ? resumeAt : 0;
    audio.src = item.url;
    titleEl.textContent = item.title || '未知曲目';
    artistEl.textContent = item.author || '';
    loadLyric(item.songId);
    if (item.pic) {
      setCover(coverImg, item.pic);
      coverBtn.classList.add('has-cover');
    } else {
      coverBtn.classList.remove('has-cover');
    }
    highlightRow();
    updateProgress();
    syncPlayAllLabel();
    if (npOpen) npSync();
    if (autoplay) {
      audio.play().catch(function () {
        console.warn('[music] 自动播放被拦截');
      });
    }
  }

  function next() { load(index + 1, true); }
  function prev() { load(index < 0 ? playlist.length - 1 : index - 1, true); }

  function togglePlay() {
    /* 已经在放歌时，播放键只管暂停/继续，跟列表是否为空无关
       （切歌单的瞬间列表会短暂为空，但当前这首还在放） */
    if (audio && audio.src) {
      if (audio.paused) {
        audio.play().catch(function (err) {
          console.warn('[music] 播放失败', err);
        });
      } else {
        audio.pause();
      }
      return;
    }
    if (!playlist.length) {
      artistEl.textContent = loading ? '正在载入歌单…' : '正在重试载入…';
      loadPlaylist();
      return;
    }
    /* 有上次进度就接着听，否则从第一首开始 */
    resume();
  }

  function initAudio() {
    audio = new Audio();
    audio.preload = 'none';
    /* 频谱要读音频样本，必须走 CORS。网易云 CDN 回
       Access-Control-Allow-Origin: *，万一哪个源不回，播放会直接失败——
       error 处理里有降级，去掉 crossOrigin 重试一次。 */
    audio.crossOrigin = 'anonymous';
    requestAnimationFrame(progressLoop);
    /* 调试钩子，也给看板娘用：她能通过它切歌、暂停。
       control 只暴露几个无副作用的动作，不开放任意函数。 */
    window.__mp = {
      audio: audio,
      control: function (what) {
        if (!playlist.length) return false;
        if (what === 'next') { load((index + 1) % playlist.length, true); return true; }
        if (what === 'prev') { load((index - 1 + playlist.length) % playlist.length, true); return true; }
        return false;
      }
    };

    audio.addEventListener('play', function () {
      failCount = 0;
      dock.classList.add('playing');
      syncLyricVisible();
      playBtn.innerHTML = ICONS.pause;
      playBtn.setAttribute('aria-label', '暂停');
      highlightRow();
      if (npOpen) npSyncPlayIcon();
    });

    audio.addEventListener('pause', function () {
      dock.classList.remove('playing');
      syncLyricVisible();
      playBtn.innerHTML = ICONS.play;
      playBtn.setAttribute('aria-label', '播放');
      highlightRow();
      saveState(true);
      if (npOpen) npSyncPlayIcon();
    });

    audio.addEventListener('timeupdate', function () {
      updateProgress();
      /* 歌词不挂在这里。timeupdate 只有 4Hz，最多滞后 250ms，
         快歌里字幕会明显慢半拍。改成 rAF 驱动，见 progressLoop。 */
      saveState(false);
    });

    audio.addEventListener('loadedmetadata', function () {
      /* 续播：必须等元数据到位再 seek，太早设置会被浏览器丢掉 */
      if (pendingSeek > 0) {
        var t = pendingSeek;
        pendingSeek = 0;
        try {
          var dur = isFinite(audio.duration) ? audio.duration : 0;
          audio.currentTime = dur ? Math.min(t, Math.max(0, dur - 1)) : t;
        } catch (err) {}
      }
      updateProgress();
      syncPlayAllLabel();
    });

    audio.addEventListener('durationchange', updateProgress);

    /* 拖动进度条、暂停、关页面，都立刻记一次，别等下一个 4 秒 */
    audio.addEventListener('seeked', function () { saveState(true); });

    audio.addEventListener('ended', next);

    audio.addEventListener('error', function () {
      /* 带了 crossOrigin 但源没回 CORS 头，浏览器会当成加载失败（code 4）。
         去掉再试一次——宁可没有频谱，也不能没声音。只试一次，
         免得 URL 真过期时在这儿空转。 */
      if (audio.crossOrigin && !corsDropped && audio.error &&
          audio.error.code === 4) {
        corsDropped = true;
        var retry = audio.src;
        audio.crossOrigin = null;
        audio.src = retry;
        audio.play().catch(function () {});
        return;
      }
      failCount += 1;
      if (failCount > 5) {
        console.warn('[music] 连续多首无法播放，先停下');
        return;
      }
      setTimeout(next, 320);
    });
  }

  /* 依次尝试各个源，第一个成功就返回；全部失败才抛错。
     限流(429) / 5xx 视为「自建源暂时忙」，必须同源退避重试——绝不能切到匿名
     公共源：那边的会员曲目会静默变成 30 秒试听，比暂时没歌更难受。 */
  function fetchPlaylistFrom(i, id, attempt) {
    var base = METING_APIS[i];
    var url = base + '?server=netease&type=playlist&id=' + id + '&r=' + Math.random();
    var tries = attempt || 0;
    return fetch(url)
      .then(function (r) {
        if (r.status === 429 || r.status >= 500) {
          var busy = new Error('HTTP ' + r.status);
          busy.busy = true;
          throw busy;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) throw new Error('返回空歌单');
        return list;
      })
      .catch(function (err) {
        if (err && err.busy && i === 0) {
          if (tries < 3) {
            var wait = 800 * Math.pow(2, tries);
            console.warn('[music] 自建源限流，' + wait + 'ms 后重试（第 ' + (tries + 1) + ' 次）');
            return new Promise(function (res) { setTimeout(res, wait); })
              .then(function () { return fetchPlaylistFrom(i, id, tries + 1); });
          }
          console.warn('[music] 自建源持续限流，本次不加载，保留现有列表');
          throw err;
        }
        if (i + 1 < METING_APIS.length) {
          console.warn('[music] 源不可用，换下一个：' + base, err);
          return fetchPlaylistFrom(i + 1, id, 0);
        }
        throw err;
      });
  }

  /* silent：只换列表，不碰播放器上的曲名/封面/进度 */
  function loadPlaylist(silent) {
    /* 每次请求带一个代号：连着点两个歌单时，先发的那批数据回来直接丢弃，
       否则会出现「已经切到 B，列表却显示 A」的错乱。 */
    var my = ++plGen;
    var pl = currentPl();
    loading = true;
    if (!playlist.length && !silent) artistEl.textContent = '正在载入「' + pl.name + '」…';
    return fetchPlaylistFrom(0, pl.id)
      .then(function (list) {
        if (my !== plGen) return null;
        loading = false;
        /* i-meto 返回 title/author，injahow 返回 name/artist；
           统一成一套字段，以后换源不用再动渲染逻辑。 */
        playlist = list.filter(function (x) { return x && x.url; }).map(function (x) {
          return {
            title: x.title || x.name || '未知曲目',
            author: x.author || x.artist || '',
            url: x.url,
            pic: x.pic || '',
            songId: x.songId || '',
            lrc: x.lrc || ''
          };
        });
        /* 标签上的数字以实际能播的为准：接口给的 trackCount 里可能包含
           无播放地址（下架/无版权）的曲目，会出现「写 21 首、列表 20 行」。 */
        if (PLAYLISTS[plIndex]) PLAYLISTS[plIndex].count = playlist.length;
        if (!silent) {
          artistEl.textContent = playlist.length
            ? pl.name + ' · ' + playlist.length + ' 首'
            : '歌单为空';
        }
        updateHero();
        renderRows();
        renderTabs();
        if (!silent) applySavedState();
        if (npOpen) npSync();
        return playlist;
      })
      .catch(function (err) {
        if (my !== plGen) return null;
        loading = false;
        console.warn('[music] 歌单加载失败', err);
        if (!playlist.length && !silent) artistEl.textContent = '歌单加载失败，点球重试';
        updateHero();
        renderRows();
        return null;
      });
  }

  /* ---------------------------------------------------------- 歌单页 */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ── 歌词 ──────────────────────────────────────────────────────────
   * 一句一行，居中，其余留白。不做滚动歌词列表：这个站本来就是安静的，
   * 字幕跟着声音走就够了。
   * 纯音乐占这个站的绝大多数，所以「没有歌词」不是异常态而是常态——
   * 那时候不空着，把歌词头部那几行署名（作曲 / 编曲）拿出来顶上。
   * ---------------------------------------------------------------- */
  var lyric = { key: '', lines: [], trans: [], meta: {}, pure: false, ready: false };
  var lyricEl = null, lyricColEls = [], lyricTransEl = null;
  var lyricGen = 0, lyricTimer = 0, lyricIdx = -2, lyricPaintedAt = 0;

  var LRC_SRC = '\\[(\\d{1,2}):(\\d{2})(?:[.:](\\d{1,3}))?\\]';
  var CREDIT_RE = /^([\u4e00-\u9fa5A-Za-z]{1,8})\s*[:：]\s*(.+)$/;
  var PURE_RE = /纯音乐|請欣賞|请欣赏/;
  var SYMBOL_RE = /^[\s♪♫·•—….-]+$/;

  /* [01:23.45] 或 [01:23:45]，一句可能挂多个时间标签（副歌复用） */
  function parseLrc(text) {
    var out = [];
    if (!text) return out;
    var rows = String(text).split(/\r?\n/);
    for (var i = 0; i < rows.length; i++) {
      var raw = rows[i];
      if (!raw || raw.indexOf('[') < 0) continue;
      var re = new RegExp(LRC_SRC, 'g');
      var times = [], m;
      while ((m = re.exec(raw)) !== null) {
        var frac = m[3] || '';
        var ms = 0;
        if (frac) {
          ms = frac.length === 1 ? Number(frac) * 100
             : frac.length === 2 ? Number(frac) * 10
             : Number(frac);
        }
        times.push(Number(m[1]) * 60 + Number(m[2]) + ms / 1000);
      }
      if (!times.length) continue;
      var body = raw.replace(new RegExp(LRC_SRC, 'g'), '').trim();
      /* 整行只有 ♪ · — 这类符号的，是间奏标记不是歌词，丢掉 */
      if (!body || SYMBOL_RE.test(body)) continue;
      for (var k = 0; k < times.length; k++) out.push({ t: times[k], text: body });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  /* 歌词头部那几行「作词 : xxx」不是歌词，单独挑出来 */
  function splitCredits(rows) {
    var meta = {}, lines = [], inList = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var m = CREDIT_RE.exec(row.text);
      if (m && row.t < 8) {
        if (!meta[m[1]]) meta[m[1]] = m[2].trim();
        continue;
      }

      /* 致谢名单。有的歌开头会摆一段「愿望来自于：A/B/C/…」，
         一行塞十几个名字。第一行有冒号能被 CREDIT_RE 挑走，
         后面几行没有冒号，就全被当成歌词一句句唱过去了。
         靠斜杠数量认：开头 20 秒内，一行里三个以上斜杠判为名单；
         一旦进了名单，后面只要还带斜杠就继续丢（最后一行常只剩一个）。
         限定 20 秒内，是怕误伤正文里正常的「你/我」。 */
      if (row.t < 20) {
        var slashes = (row.text.match(/\//g) || []).length;
        if (slashes >= 3 || (inList && slashes >= 1)) {
          inList = true;
          continue;
        }
      }
      inList = false;
      lines.push(row);
    }
    return { meta: meta, lines: lines };
  }

  /* 一两个字的短句并回下一句。

     有的 LRC 把「当阳光洒落在我们身旁」拆成「当」+「阳光洒落…」，
     「当」只占 0.31 秒（《我们》01:00.64）。滚动动画要 600ms，
     根本跑不完——字还没滚到位就被下一句顶掉，两列一起弹回原位，
     看着就是闪一下。

     这种短句其实是下一句的开头，并回去就正常了。判据：两个字以内
     且停留不到 0.9 秒。连续几个短句会一路并进后面第一个长句。

     只并到下一句，不并到上一句：「当」是「当阳光洒落…」的第一个字，
     挂到上一句末尾就变成「…最初的模样当」，反了。 */
  function mergeTinyLines(rows) {
    if (rows.length < 2) return rows;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var next = rows[i + 1];
      var life = next ? (next.t - row.t) * 1000 : 1e9;
      var chars = row.text.replace(/\s/g, '').length;
      if (next && chars <= 2 && life < 900 &&
          next.text.length + row.text.length <= 24) {
        /* 用被并那句的时间，字幕才和歌声对得上——「当」一出口，
           整句就该出来，而不是等 0.31 秒后才补上 */
        next.text = row.text + next.text;
        next.t = row.t;
        continue;
      }
      out.push(row);
    }
    return out;
  }

  /* 两种形态都算纯音乐：
     一是歌词直接写着「纯音乐，请欣赏」；
     二是整篇只有一串 ♪，一个字都没有。 */
  function looksPure(lines) {
    if (!lines.length) return true;
    var i;
    for (i = 0; i < lines.length; i++) {
      if (PURE_RE.test(lines[i].text)) return true;
    }
    for (i = 0; i < lines.length; i++) {
      if (!SYMBOL_RE.test(lines[i].text)) return false;
    }
    return true;
  }

  function fetchLyric(i, id) {
    var base = METING_APIS[i];
    var url = base + '?server=netease&type=lyric&id=' + encodeURIComponent(id) + '&r=' + Math.random();
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (err) {
        if (i + 1 < METING_APIS.length) return fetchLyric(i + 1, id);
        throw err;
      });
  }

  /* 歌词层是全站的，不只属于音乐页。

     挂在 body 下面有两个原因：
     1. 音乐页里它的祖先有一层 div 带 backdrop-filter: blur(18px)，
        而 backdrop-filter 和 transform 一样会创建包含块——
        position: fixed 会退化成相对那层定位，top: 50% 算到页面中间去；
     2. 换页时 body 不被 pjax 替换，这一层能活下来，不用反复重建。 */
  function buildLyricLayer() {
    var node = document.getElementById('mp-lyric-layer');
    if (!node) {
      node = document.createElement('div');
      node.className = 'mp-lyric';
      node.id = 'mp-lyric-layer';
      node.setAttribute('aria-live', 'polite');
      node.setAttribute('aria-label', '歌词');
      node.innerHTML = '<p class="mp-lyric__col"></p>' +
                       '<p class="mp-lyric__col"></p>' +
                       '<p class="mp-lyric__trans" hidden></p>';
      document.body.appendChild(node);
    }
    return node;
  }

  /* 什么时候显示。

     在放歌就全站显示；没放歌时只在音乐页显示（那里是“看歌词”的场景，
     暂停着也该能看到停在那一句）。首页、文章页暂停时左边凭空挂一行
     字很奇怪，所以隐掉。 */
  function syncLyricVisible() {
    var playing = audio && !audio.paused && !!audio.src;
    var on = playing || isMusicPage();
    document.body.classList.toggle('lyric-on', on);
  }

  /* pjax 换页后 DOM 是新的，元素引用要重新拿一遍，再按当前状态重画 */
  function mountLyric() {
    /* 歌词层在 body 下，不在 pageEl 里 */
    lyricEl = buildLyricLayer();
    syncLyricVisible();
    lyricColEls = lyricEl
      ? Array.prototype.slice.call(lyricEl.querySelectorAll('.mp-lyric__col'))
      : [];
    lyricTransEl = lyricEl ? lyricEl.querySelector('.mp-lyric__trans') : null;
    if (lyricEl && lyric.ready) renderIdle();
  }

  function loadLyric(songId) {
    var id = songId ? String(songId) : '';
    if (!id) {
      lyric = { key: '', lines: [], trans: [], meta: {}, pure: true, ready: true };
      lyricIdx = -2;
      paintLyric('', '', '', true, 0, 0, false);
      return;
    }
    if (lyric.key === id) return;

    lyric = { key: id, lines: [], trans: [], meta: {}, pure: false, ready: false };
    lyricIdx = -2;
    paintLyric('', '', '', true, 0, 0, false);

    fetchLyric(0, id).then(function (d) {
      if (lyric.key !== id) return;   /* 已经切歌，这批数据丢掉 */
      var main = splitCredits(parseLrc(d && d.lrc));
      lyric.lines = mergeTinyLines(main.lines);
      lyric.meta = main.meta;
      lyric.trans = parseLrc(d && d.tlyric);
      lyric.pure = looksPure(main.lines);
      lyric.ready = true;
      renderIdle();
      syncLyric(audio.currentTime || 0);
    }).catch(function () {
      if (lyric.key !== id) return;
      lyric.pure = true;
      lyric.failed = true;
      lyric.ready = true;
      renderIdle();
    });
  }

  /* 有歌词就停在当前那句；纯音乐显示署名，别留一块空白 */
  function renderIdle() {
    if (!lyricEl) return;
    if (!lyric.pure && lyric.lines.length) {
      var idx = lyricIdx >= 0 ? lyricIdx : 0;
      var line = lyric.lines[idx];
      var next = lyric.lines[idx + 1];
      /* pjax 回来时把进度区间一起还原，否则高亮要等到下一句才接上 */
      paintLyric(line.text, next ? next.text : '', transAt(line.t), true,
                 0, 0, false);
      /* pjax 回来时重画，前奏的淡色状态也要一起还原 */
      lyricEl.classList.toggle('is-pending', lyricIdx < 0);
      return;
    }
    /* 只留「纯音乐」三个字，不摆作曲 / 编曲署名。
       署名仍然从歌词里剔掉（splitCredits），否则会被当成歌词唱出来。 */
    paintLyric('纯音乐', '', '', true, 0, 0, false);
  }

  /* 按时间二分找当前句，比逐行遍历稳 */
  function syncLyric(t) {
    if (lyric.pure || !lyric.lines.length) return;
    var lo = 0, hi = lyric.lines.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lyric.lines[mid].t <= t) { idx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (idx < 0) {
      /* 前奏还没唱到第一句：把首句用淡色摆着当预告，
         否则前奏长的歌会让这块空二十几秒，看着像没加载出来 */
      if (lyricIdx !== -1) {
        lyricIdx = -1;
        paintLyric(lyric.lines[0].text,
                   lyric.lines[1] ? lyric.lines[1].text : '',
                   '', true, 0, 0, false);
        if (lyricEl) lyricEl.classList.add('is-pending');
      }
      return;
    }
    if (idx === lyricIdx) return;
    if (lyricEl) lyricEl.classList.remove('is-pending');
    var prevIdx = lyricIdx;
    lyricIdx = idx;
    var line = lyric.lines[idx];
    var next = lyric.lines[idx + 1];

    /* 同一句被多个时间戳重复标注的（YELLOW 最小间隔 0.02s、
       Rolling star 甚至 0.00s），内容一样就不用重画——
       重画一次就多一次闪烁，而且闪的是同一行字。 */
    if (prevIdx >= 0 && line.text === lyric.lines[prevIdx].text) return;

    /* 只有「紧接着的下一句」才走滚动动画。seek 跳转、切歌直接换。 */
    var animate = prevIdx >= 0 && idx === prevIdx + 1;

    /* 这句能停留多久，交给绘制层决定用哪种动画。用时间戳算，
       不用「上次绘制到现在」——那个值会被 seek、暂停带偏。 */
    var life = next ? Math.max(0, (next.t - line.t) * 1000) : 1e9;
    paintLyric(line.text, next ? next.text : '', transAt(line.t), false, life, 0, animate);
  }

  function transAt(t) {
    if (!lyric.trans.length) return '';
    var lo = 0, hi = lyric.trans.length - 1, idx = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lyric.trans[mid].t <= t + 0.4) { idx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    if (idx < 0) return '';
    var d = lyric.trans[idx].t - t;
    return (d > -0.8 && d < 0.8) ? lyric.trans[idx].text : '';
  }

  /* 换句：两列分别向左右滑出去，换字，再从中间展开回来。
     间隔太短的快歌直接换，否则两段动画会叠在一起看不清。

     两列是「上一句 / 这一句」，不是把一句从中间劈开——
     劈开的话读到一半要横跳，气就断了。 */
  function setCol(el, text) {
    /* 不再拆成单字 span——逐字高亮去掉了，现在整句一起亮。
       空格换成不换行空格，否则竖排里英文句子的词间距会被折叠。 */
    el.textContent = String(text || '').replace(/ /g, ' ');
  }

  /* 换句靠这个循环推。

     原来挂在 timeupdate 上，那是 4Hz（250ms 一跳），快歌里字幕
     明显慢半拍。rAF 跟着刷新率走，16ms 内就能反应。
     syncLyric 内部有「idx 没变就 return」的短路，空转开销很小。 */
  function progressLoop() {
    if (audio && !audio.paused) {
      syncLyric(audio.currentTime || 0);
    }
    /* 沉浸页的进度条也挂这里。timeupdate 只有 4Hz，
       全屏那么大一条进度会明显一跳一跳。 */
    if (npOpen) npTick();
    requestAnimationFrame(progressLoop);
  }

  /* 短间隔换句：不滚动，只让字“浮”上来。

     快歌里两句只隔 0.2~0.5 秒，滚动动画（600ms）根本跑不完，
     而以前是直接 settle 硬切——字“叭”地一下变了，看着就是闪。
     这里改成：字立即换掉，当前句从淡到亮走 180ms。
     视觉上是文字浮现，不是闪烁。 */
  function fadeSwap(c0, c1, cur, next, life) {
    /* 先把位置一次性归零（transform 无过渡），再把字换掉 */
    c0.style.transition = 'none';
    c1.style.transition = 'none';
    c0.classList.remove('is-advancing', 'is-leaving', 'is-fresh');
    c1.classList.remove('is-advancing', 'is-leaving', 'is-fresh');
    c1.classList.add('is-cur');
    setCol(c1, cur);
    setCol(c0, next || '');
    void c1.offsetWidth;
    c0.style.transition = '';
    c1.style.transition = '';

    /* 让当前句从 0.2 浮到 1。

       这里用 Web Animations 而不是 CSS transition：transition 要
       「先设 0.18 → 强制回流 → 再清空」，而快歌里两句只隔 0.2~0.5 秒，
       连续切换时浏览器会把这几步合并成一次样式计算，起点根本落不下地
       （实测 opacity 一直是 1，等于硬切）。WAAPI 不受这个影响。 */
    if (c1.__fade) { try { c1.__fade.cancel(); } catch (e) {} }
    /* 能活多久决定淡入多快：只剩 300ms 还淡 180ms，一半时间都是糊的。
       下限 90ms，再快就等于硬切，不如直接亮。 */
    var dur = Math.min(180, Math.max(90, Math.round((life || 0) * 0.22)));
    c1.__fade = c1.animate(
      [{ opacity: 0.2 }, { opacity: 1 }],
      { duration: dur, easing: 'ease' }
    );
  }

  function paintLyric(cur, next, trans, instant, life, t1, animate) {
    if (!lyricEl || !lyricColEls.length || !lyricTransEl) return;
    var now = Date.now();
    var gap = now - lyricPaintedAt;
    lyricPaintedAt = now;

    var gen = ++lyricGen;
    clearTimeout(lyricTimer);

    var c0 = lyricColEls[0];
    var c1 = lyricColEls[1];

    function settle() {
      c0.style.transition = 'none';
      c1.style.transition = 'none';
      c0.classList.remove('is-advancing', 'is-leaving', 'is-fresh', 'is-cur');
      c1.classList.remove('is-advancing', 'is-leaving', 'is-fresh');
      c1.classList.add('is-cur');
      setCol(c1, cur);
      setCol(c0, next || '');
      void lyricEl.offsetWidth;
      c0.style.transition = '';
      c1.style.transition = '';
    }

    function commit() {
      /* 接棒：左列刚才停的地方就是右列现在的位置 */
      c1.style.transition = 'none';
      c1.classList.remove('is-leaving');
      c1.classList.add('is-cur');
      setCol(c1, cur);
      void c1.offsetWidth;
      c1.style.transition = '';

      /* 左列换上再下一句，从更远的地方淡进来 */
      c0.style.transition = 'none';
      c0.classList.remove('is-advancing', 'is-fresh');
      c0.classList.add('is-fresh');
      setCol(c0, next || '');
      void c0.offsetWidth;
      c0.style.transition = '';
      c0.classList.remove('is-fresh');
    }

    /* seek 跳转、切歌、pjax 回来：直接摆好，不走动画 */
    if (!animate || instant) { settle(); return; }

    /* 这句活不到 1.2 秒，就别滚了。

       滚动动画 600ms，跑完只剩两百毫秒就换下一句；更短的话中途
       被打断，两列从半路弹回原位再换字——那一下就是「闪」。
       短句一律走淡切，淡入时长再按能活多久缩。

       gap 那个条件留着做兜底：上一轮动画还没跑完新句就来了，
       先把它打断总比两段动画叠在一起强。 */
    if (life < 1200 || gap < 700) { fadeSwap(c0, c1, cur, next, life); return; }

    /* 上一轮还没跑完就被打断，先把残留的类清掉再起新的 */
    c0.classList.remove('is-fresh');
    c0.classList.add('is-advancing');
    c1.classList.add('is-leaving');

    /* 比 CSS 里最长的过渡（0.56s）稍晚一点再接棒，
       不然字还没滚到位就换了，会看到一下抖动 */
    lyricTimer = setTimeout(function () {
      if (gen !== lyricGen) return;
      commit();
    }, 600);
  }

  function renderMusicPage() {
    if (pageEl) return;
    var host = document.getElementById('article-container');
    if (!host) return;

    pageEl = document.createElement('section');
    pageEl.className = 'mp';
    pageEl.id = 'music-page';
    pageEl.innerHTML = [
      '<header class="mp-hero">',
      '<div class="mp-hero__bg"></div>',
      '<div class="mp-hero__cover">',
      '<img alt="">',
      '<span class="mp-hero__badge">' + ICONS.note + '</span>',
      '</div>',
      '<div class="mp-hero__info">',
      '<span class="mp-hero__kicker">网易云音乐 · 曲目单</span>',
      '<h1 class="mp-hero__title">正在载入歌单…</h1>',
      '<p class="mp-hero__desc">正在连接</p>',
      '<div class="mp-hero__ops">',
      '<button class="mp-btn mp-btn--primary" type="button" data-act="playall">' + ICONS.play + '<span>播放全部</span></button>',
      '<button class="mp-btn" type="button" data-act="shuffle">随机播放</button>',
      '</div>',
      '</div>',
      '<span class="mp-hero__folio" aria-hidden="true"></span>',
      '</header>',
      '<nav class="mp-tabs" aria-label="歌单切换"></nav>',
      '<div class="mp-panel">',
      '<div class="mp-head">',
      '<span class="mp-c mp-c--idx">#</span>',
      '<span class="mp-c mp-c--title">音乐标题</span>',
      '<span class="mp-c mp-c--artist">歌手</span>',
      '<span class="mp-c mp-c--act"></span>',
      '</div>',
      '<div class="mp-rows"></div>',
      '</div>'
    ].join('');

    host.appendChild(pageEl);

    rowsEl = pageEl.querySelector('.mp-rows');
    buildLyricLayer();
    mountLyric();

    // Music page cover opens the immersive view (home cover does not).
    var heroCover = pageEl.querySelector('.mp-hero__cover');
    if (heroCover) heroCover.addEventListener('click', function () { openNp(); });

    pageEl.querySelector('.mp-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pl]');
      if (btn) switchPlaylist(Number(btn.getAttribute('data-pl')));
    });

    pageEl.querySelector('[data-act="playall"]').addEventListener('click', function () {
      if (!playlist.length) { loadPlaylist(); return; }
      /* 有上次进度时这个按钮显示「继续播放」，点了就接着听 */
      if (pendingSeek > 0 && !audio.src) { resume(); return; }
      load(0, true);
    });
    pageEl.querySelector('[data-act="shuffle"]').addEventListener('click', function () {
      if (!playlist.length) { loadPlaylist(); return; }
      load(Math.floor(Math.random() * playlist.length), true);
    });
    rowsEl.addEventListener('click', function (e) {
      var row = e.target.closest('.mp-row');
      if (!row) return;
      var i = Number(row.getAttribute('data-i'));
      if (i === index && audio && audio.src) togglePlay();
      else load(i, true);
    });
    rowsEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target.closest('.mp-row');
      if (!row) return;
      e.preventDefault();
      load(Number(row.getAttribute('data-i')), true);
    });

    updateHero();
    renderRows();
    renderTabs();
    syncPlayAllLabel();
  }

  function updateHero() {
    if (!pageEl) return;
    var titleNode = pageEl.querySelector('.mp-hero__title');
    var descNode = pageEl.querySelector('.mp-hero__desc');
    var folioNode = pageEl.querySelector('.mp-hero__folio');
    var coverNode = pageEl.querySelector('.mp-hero__cover img');
    var bgNode = pageEl.querySelector('.mp-hero__bg');

    var pl = currentPl();

    /* 标题永远是当前歌单名（载入中也一样），切换时不会闪成「正在载入」 */
    titleNode.textContent = pl.name;
    descNode.textContent = playlist.length
      ? '共收录 ' + playlist.length + ' 首'
      : (loading ? '正在连接网易云音乐' : '还没加载出来，点「播放全部」重试');
    folioNode.textContent = String(pl.count || playlist.length || '');

    /* 封面优先用歌单自己的，列表还没到时也有图可看 */
    var pic = pl.cover || (playlist[0] && playlist[0].pic) || '';
    if (pic) {
      setCover(coverNode, pic);
      coverNode.classList.add('is-ready');
      bgNode.style.backgroundImage = 'url("' + coverUrl(pic).replace(/"/g, '\\"') + '")';
      // 未开始播放时，播放条也显示歌单封面，避免只有一个音符图标
      if (!audio || !audio.src) {
        setCover(coverImg, pic);
        coverBtn.classList.add('has-cover');
      }
    }
  }

  /* 歌单切换器：一行胶囊，横向可滚。只有一个歌单时整行隐藏 */
  function renderTabs() {
    if (!pageEl) return;
    var nav = pageEl.querySelector('.mp-tabs');
    if (!nav) return;
    if (PLAYLISTS.length < 2) {
      nav.innerHTML = '';
      nav.style.display = 'none';
      return;
    }
    nav.style.display = '';
    var html = [];
    for (var i = 0; i < PLAYLISTS.length; i++) {
      var p = PLAYLISTS[i];
      html.push(
        '<button class="mp-tab' + (i === plIndex ? ' is-active' : '') + '" type="button" data-pl="' + i + '">' +
        '<span class="mp-tab__name">' + esc(p.name) + '</span>' +
        (p.count ? '<span class="mp-tab__count">' + p.count + '</span>' : '') +
        '</button>'
      );
    }
    nav.innerHTML = html.join('');
  }

  function renderRows() {
    if (!rowsEl) return;
    if (!playlist.length) {
      rowsEl.innerHTML = '<div class="mp-empty">' +
        (loading ? '正在载入歌单…' : '歌单加载失败，点上方「播放全部」重试') +
        '</div>';
      return;
    }
    var html = [];
    for (var i = 0; i < playlist.length; i++) {
      var it = playlist[i];
      html.push(
        '<div class="mp-row" data-i="' + i + '" role="button" tabindex="0">' +
        '<span class="mp-c mp-c--idx">' +
        '<span class="mp-idx">' + pad2(i + 1) + '</span>' +
        '<span class="mp-wave"><i></i><i></i><i></i></span>' +
        '</span>' +
        '<span class="mp-c mp-c--title"><span class="mp-name">' + esc(it.title || '未知曲目') + '</span></span>' +
        '<span class="mp-c mp-c--artist">' + esc(it.author || '未知歌手') + '</span>' +
        '<span class="mp-c mp-c--act">' + ICONS.play + '</span>' +
        '</div>'
      );
    }
    rowsEl.innerHTML = html.join('');
    highlightRow();
  }

  function highlightRow() {
    if (!rowsEl) return;
    var rows = rowsEl.querySelectorAll('.mp-row');
    var playing = audio && !audio.paused && audio.src;
    for (var i = 0; i < rows.length; i++) {
      var on = Number(rows[i].getAttribute('data-i')) === index && playlist.length > 0 && audio && (audio.src || pendingSeek > 0);
      rows[i].classList.toggle('is-current', !!on);
      rows[i].classList.toggle('is-playing', !!(on && playing));
    }
  }

  function updateProgress() {
    var dur = audio && isFinite(audio.duration) ? audio.duration : 0;
    var cur = audio ? audio.currentTime : 0;
    var pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
    if (barEl) barEl.style.width = pct + '%';
    if (timelineFill) timelineFill.style.width = pct + '%';
    if (timelineDot) timelineDot.style.left = pct + '%';
    if (timeEl) timeEl.textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
  }

  function seekTo(clientX) {
    if (!audio || !isFinite(audio.duration) || !audio.duration) return;
    var rect = timelineEl.getBoundingClientRect();
    if (!rect.width) return;
    var ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
    updateProgress();
  }

  function bindTimeline() {
    var seeking = false;
    timelineEl.addEventListener('pointerdown', function (e) {
      seeking = true;
      try { timelineEl.setPointerCapture(e.pointerId); } catch (err) {}
      seekTo(e.clientX);
      e.stopPropagation();
    });
    timelineEl.addEventListener('pointermove', function (e) {
      if (!seeking) return;
      seekTo(e.clientX);
      e.stopPropagation();
    });
    timelineEl.addEventListener('pointerup', function (e) {
      seeking = false;
      try { timelineEl.releasePointerCapture(e.pointerId); } catch (err) {}
      e.stopPropagation();
    });
    timelineEl.addEventListener('pointercancel', function () { seeking = false; });
  }

  function bind() {
    // pointerdown 之后如果调 setPointerCapture，后续 pointerup 的 target
    // 会被重定向到 dock 本身，e.target.closest('.music-dock__cover') 永远为 null，
    // 点击就永远不会触发。所以按下时先把真实目标记下来，且只在真正拖动时才捕获。
    var downTarget = null;

    dock.addEventListener('pointerdown', function (e) {
      // 音乐页是固定播放条，不参与拖动
      if (isMusicPage()) return;
      // 按钮、进度条交给各自的处理，不进入拖动流程
      if (e.target.closest('[data-act]') || e.target.closest('.music-dock__timeline')) return;
      downTarget = e.target;
      dragging = true;
      moved = false;
      start.x = e.clientX;
      start.y = e.clientY;
      var rect = dock.getBoundingClientRect();
      start.left = parseFloat(dock.style.left) || rect.left;
      start.top = parseFloat(dock.style.top) || rect.top;
    });

    dock.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - start.x;
      var dy = e.clientY - start.y;
      if (!moved) {
        if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) return;
        moved = true;
        dock.classList.add('dragging');
        // 确认是拖动再捕获，保证点击路径上 target 不被改写
        try { dock.setPointerCapture(e.pointerId); } catch (err) {}
      }
      dock.style.left = start.left + dx + 'px';
      dock.style.top = start.top + dy + 'px';
      clamp();
    });

    dock.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      dragging = false;
      dock.classList.remove('dragging');
      try { dock.releasePointerCapture(e.pointerId); } catch (err) {}

      if (moved) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({
            x: parseFloat(dock.style.left) || 0,
            y: parseFloat(dock.style.top) || 0
          }));
        } catch (err) {}
      } else if (!isMusicPage() && downTarget && downTarget.closest('.music-dock__cover')) {
        toggleOpen();
      }
      downTarget = null;
    });

    dock.addEventListener('pointercancel', function () {
      dragging = false;
      downTarget = null;
      dock.classList.remove('dragging');
    });

    dock.querySelector('[data-act="play"]').addEventListener('click', function (e) {
      e.stopPropagation();
      togglePlay();
    });
    dock.querySelector('[data-act="prev"]').addEventListener('click', function (e) {
      e.stopPropagation();
      prev();
    });
    dock.querySelector('[data-act="next"]').addEventListener('click', function (e) {
      e.stopPropagation();
      next();
    });

    dock.addEventListener('click', function (e) {
      if (isMusicPage()) return;
      if (e.target.closest('[data-act]') || e.target.closest('.music-dock__cover') || e.target.closest('.music-dock__timeline')) return;
      if (dock.classList.contains('open')) toggleOpen(false);
    });

    bindTimeline();

    /* Home dock cover only toggles the player panel (see pointerup);
       immersive view is opened from the music page cover. */
  }

  /* Immersive v2: this block replaces the previous np UI inside the player closure.
     The audio element, queue, lyric parser and spectrum graph remain shared. */
  var npEl = null, npBg = null, npImg = null, npTitle = null, npArtist = null;
  var npFill = null, npDot = null, npCur = null, npDur = null, npPlay = null;
  var npBar = null, npSpec = null, npOpen = false;
  var npAccentColor = '#d5af89', npAccentFor = '';
  var actx = null, analyser = null, freqData = null, specRaf = 0, corsDropped = false;
  var npLyrics = null, npTrack = null, npLyricKey = '', npActive = -2;
  var npQueue = null, npQueueKey = '', npFocusFrom = null, npResize = null;
  var npCompact = false, npTheme = 'night', npThemeManual = false;
  var npPlayingItem = null, npPlayingListName = '';

  function npFollowTheme() {
    if (npThemeManual) return;
    npTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'night' : 'day';
    if (npEl) npSetTheme();
  }
  new MutationObserver(npFollowTheme).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme']
  });
  var NP_ICONS = {
    close: '<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>',
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/></svg>',
    focus: '<svg viewBox="0 0 24 24"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>',
    queue: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="m11 5-6 4H2v6h3l6 4Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>',
    muted: '<svg viewBox="0 0 24 24"><path d="m11 5-6 4H2v6h3l6 4Zm5 4 6 6m0-6-6 6"/></svg>',
    disc: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M5.5 12a6.5 6.5 0 0 1 6.5-6.5"/></svg>'
  };

  function npWakeAudio() {
    if (actx && actx.state === 'suspended') actx.resume().catch(function () {});
  }

  function buildNp() {
    if (npEl) return npEl;
    npEl = document.createElement('section');
    npEl.className = 'np np-v2';
    npEl.id = 'np-layer';
    npEl.setAttribute('role', 'dialog');
    npEl.setAttribute('aria-modal', 'true');
    npEl.setAttribute('aria-label', '沉浸听歌');
    npEl.setAttribute('aria-hidden', 'true');
    npEl.inert = true;
    npEl.innerHTML = [
      '<div class="np-bg"></div><div class="np-veil"></div><div class="np-grain"></div>',
      '<header class="np-header">',
        '<div class="np-brand">' + NP_ICONS.disc + '<span>风月酌酒</span><i></i><span class="np-brand-sub">此刻，只听音乐</span></div>',
        '<div class="np-tools">',
          '<button type="button" class="np-tool" data-np="theme" aria-label="切换清晨配色">' + NP_ICONS.sun + '<span>清晨</span></button>',
          '<button type="button" class="np-tool" data-np="focus" aria-label="切换纯净模式" aria-pressed="false">' + NP_ICONS.focus + '<span>纯净</span></button>',
          '<button type="button" class="np-tool np-close" aria-label="收起沉浸模式">' + NP_ICONS.close + '<span>收起</span></button>',
        '</div>',
      '</header>',
      '<main class="np-stage">',
        '<section class="np-album">',
          '<div class="np-art-wrap"><div class="np-art-shadow"></div><div class="np-cover"><img alt="当前专辑封面"></div></div>',
          '<div class="np-meta"><div class="np-eyebrow"><span class="np-signal"></span><span class="np-state">等待播放</span><span class="np-album-pl"></span></div>',
          '<h2 class="np-title">载入曲目</h2><p class="np-artist"></p></div>',
        '</section>',
        '<section class="np-lyric-side" aria-label="歌词">',
          '<div class="np-lyric-heading"><span class="np-eyebrow">歌词</span><span class="np-lyric-hint">点一句，听这一段</span></div>',
          '<div class="np-lyrics"><div class="np-lyric-track"></div></div>',
          '<div class="np-lyric-foot"><span class="np-follow">随音乐慢慢往下</span><span class="np-lyric-position"></span></div>',
        '</section>',
      '</main>',
      '<footer class="np-console">',
        '<div class="np-progress"><span class="np-time np-time--cur">0:00</span>',
        '<div class="np-bar" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><span class="np-fill"></span><span class="np-dot"></span></div>',
        '<span class="np-time np-time--dur">0:00</span></div>',
        '<div class="np-bottom">',
          '<div class="np-mood"><canvas class="np-spec" aria-hidden="true"></canvas><span class="np-playing-label">等待播放</span></div>',
          '<div class="np-ctrl"><button class="np-btn" type="button" data-act="prev" aria-label="上一首">' + ICONS.prev + '</button>',
          '<button class="np-btn np-play" type="button" data-act="play" aria-label="播放">' + ICONS.play + '</button>',
          '<button class="np-btn" type="button" data-act="next" aria-label="下一首">' + ICONS.next + '</button></div>',
          '<div class="np-extras"><div class="np-volume"><button class="np-tool np-mute" type="button" aria-label="静音">' + NP_ICONS.volume + '</button>',
          '<input type="range" min="0" max="1" step="0.01" value="1" aria-label="音量"></div>',
          '<button type="button" class="np-tool np-list-toggle" aria-label="打开播放列表" aria-expanded="false" aria-controls="np-queue">' + NP_ICONS.queue + '<span>播放列表</span><b class="np-count">0</b></button></div>',
        '</div>',
      '</footer>',
      '<div class="np-drawer-shade" hidden></div>',
      '<aside class="np-drawer" id="np-queue" aria-label="播放列表" inert>',
      '<div class="np-drawer-head"><div><span class="np-eyebrow">接下来听</span><h3>播放列表 <span class="np-drawer-count"></span></h3></div>',
      '<button class="np-tool" data-np="queue-close" type="button" aria-label="关闭播放列表">×</button></div>',
      '<div class="np-queue-items"></div></aside>'
    ].join('');
    document.body.appendChild(npEl);
    npBg = npEl.querySelector('.np-bg'); npImg = npEl.querySelector('.np-cover img');
    npTitle = npEl.querySelector('.np-title'); npArtist = npEl.querySelector('.np-artist');
    npFill = npEl.querySelector('.np-fill'); npDot = npEl.querySelector('.np-dot');
    npCur = npEl.querySelector('.np-time--cur'); npDur = npEl.querySelector('.np-time--dur');
    npPlay = npEl.querySelector('.np-play'); npBar = npEl.querySelector('.np-bar');
    npSpec = npEl.querySelector('.np-spec'); npLyrics = npEl.querySelector('.np-lyrics');
    npTrack = npEl.querySelector('.np-lyric-track'); npQueue = npEl.querySelector('.np-queue-items');
    npEl.querySelector('.np-close').addEventListener('click', closeNp);
    npEl.querySelector('.np-ctrl').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      npWakeAudio();
      if (b.dataset.act === 'play') togglePlay();
      if (b.dataset.act === 'prev') prev();
      if (b.dataset.act === 'next') next();
    });
    npEl.querySelector('[data-np="theme"]').addEventListener('click', function () {
      npThemeManual = true;
      npTheme = npTheme === 'night' ? 'day' : 'night'; npSetTheme();
    });
    npEl.querySelector('[data-np="focus"]').addEventListener('click', function () {
      npCompact = !npCompact;
      npEl.classList.toggle('is-focus', npCompact);
      this.setAttribute('aria-pressed', String(npCompact));
      this.setAttribute('aria-label', npCompact ? '退出纯净模式' : '切换纯净模式');
      this.querySelector('span').textContent = npCompact ? '还原' : '纯净';
      npActive = -2; npTick();
    });
    npEl.querySelector('.np-list-toggle').addEventListener('click', function () { npToggleQueue(!npEl.classList.contains('queue-on')); });
    npEl.querySelector('[data-np="queue-close"]').addEventListener('click', function () { npToggleQueue(false); });
    npEl.querySelector('.np-drawer-shade').addEventListener('click', function () { npToggleQueue(false); });
    npQueue.addEventListener('click', function (e) {
      var row = e.target.closest('[data-track]'); if (!row) return;
      npWakeAudio(); load(Number(row.dataset.track), true); npToggleQueue(false); npPlay.focus();
    });
    npTrack.addEventListener('click', function (e) {
      var line = e.target.closest('[data-time]'); if (!line || !audio) return;
      npWakeAudio();
      if (audio.readyState < 1) pendingSeek = Number(line.dataset.time);
      else audio.currentTime = Number(line.dataset.time);
      audio.play().catch(function () {}); npActive = -2; npTick();
    });
    npEl.querySelector('.np-volume input').value = audio ? audio.volume : 1;
    npEl.querySelector('.np-volume input').addEventListener('input', function () {
      if (!audio) return; audio.volume = Number(this.value); audio.muted = false; npVolumeIcon();
    });
    npEl.querySelector('.np-mute').addEventListener('click', function () {
      if (!audio) return; audio.muted = !audio.muted; npVolumeIcon();
    });
    if (audio) audio.addEventListener('volumechange', npVolumeIcon);
    npResize = new ResizeObserver(function () { npActive = -2; if (npOpen) npTick(); });
    npResize.observe(npLyrics);
    bindNpBar(); npSetTheme();
    return npEl;
  }

  function npSetTheme() {
    npEl.dataset.mood = npTheme;
    var b = npEl.querySelector('[data-np="theme"]');
    b.innerHTML = (npTheme === 'night' ? NP_ICONS.sun : NP_ICONS.moon) + '<span>' + (npTheme === 'night' ? '清晨' : '暖夜') + '</span>';
    b.setAttribute('aria-label', npTheme === 'night' ? '切换清晨配色' : '切换暖夜配色');
  }
  function npVolumeIcon() {
    if (!npEl || !audio) return;
    var b = npEl.querySelector('.np-mute');
    var muted = audio.muted || !audio.volume;
    b.innerHTML = muted ? NP_ICONS.muted : NP_ICONS.volume;
    b.setAttribute('aria-label', muted ? '取消静音' : '静音');
    npEl.querySelector('.np-volume input').value = audio.muted ? 0 : audio.volume;
  }
  function npToggleQueue(on) {
    npEl.classList.toggle('queue-on', on);
    npEl.querySelector('.np-drawer').inert = !on;
    npEl.querySelector('.np-drawer-shade').hidden = !on;
    npEl.querySelector('.np-list-toggle').setAttribute('aria-expanded', String(on));
    if (on) {
      npRenderQueue(); npEl.querySelector('[data-np="queue-close"]').focus();
      var current = npQueue.querySelector('.is-current'); if (current) current.scrollIntoView({ block: 'nearest' });
    } else npEl.querySelector('.np-list-toggle').focus();
  }
  function npRenderQueue() {
    var key = playlist.map(trackKey).join('\n') + ':' + index;
    if (key === npQueueKey) return; npQueueKey = key;
    npQueue.replaceChildren();
    playlist.forEach(function (p, i) {
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'np-queue-item' + (i === index ? ' is-current' : ''); b.dataset.track = i;
      var n = document.createElement('span'); n.className = 'np-queue-num'; n.textContent = String(i + 1).padStart(2, '0');
      var content = document.createElement('span'); content.className = 'np-queue-title';
      var title = document.createElement('strong'); title.textContent = p.title;
      var author = document.createElement('small'); author.textContent = p.author;
      content.append(title, author); b.append(n, content);
      if (i === index) { var state = document.createElement('span'); state.className = 'np-queue-current'; state.textContent = '当前'; b.appendChild(state); }
      npQueue.appendChild(b);
    });
    npEl.querySelector('.np-count').textContent = playlist.length;
    npEl.querySelector('.np-drawer-count').textContent = playlist.length;
  }

  function bindNpBar() {
    var dragging = false;
    function seekTo(x) {
      var dur = audio && isFinite(audio.duration) ? audio.duration : 0; if (!dur) return;
      var r = npBar.getBoundingClientRect(); if (!r.width) return;
      audio.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur; npTick();
    }
    npBar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return; dragging = true; npBar.classList.add('is-drag');
      try { npBar.setPointerCapture(e.pointerId); } catch (err) {} seekTo(e.clientX);
    });
    npBar.addEventListener('pointermove', function (e) { if (dragging) seekTo(e.clientX); });
    function stop() { dragging = false; npBar.classList.remove('is-drag'); }
    npBar.addEventListener('pointerup', stop); npBar.addEventListener('pointercancel', stop);
    npBar.addEventListener('keydown', function (e) {
      if (!audio || !isFinite(audio.duration)) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault(); e.stopPropagation();
        audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault(); audio.currentTime = e.key === 'Home' ? 0 : Math.max(0, audio.duration - .1);
      }
      npTick();
    });
  }
  function openNp() {
    if (npOpen) return;
    npFollowTheme();
    npFocusFrom = document.activeElement; buildNp(); npOpen = true;
    npEl.inert = false; npEl.setAttribute('aria-hidden', 'false');
    npEl.scrollLeft = 0; npEl.scrollTop = 0;
    document.body.classList.add('np-on'); npEl.classList.add('is-on');
    if (audio && !audio.src && playlist[index]) {
      load(index, false, pendingSeek);
      audio.preload = 'metadata';
      audio.load();
    }
    /* Opening the overlay never calls play: autoplay and the shared player stay intact. */
    npSync(); npPlay.focus({ preventScroll: true });
    if (initSpectrum()) {
      if (actx.state === 'suspended') actx.resume().catch(function () {});
      if (!specRaf) specRaf = requestAnimationFrame(specLoop);
    }
  }
  function closeNp() {
    if (!npOpen) return;
    npToggleQueue(false); npOpen = false; npEl.inert = true;
    document.body.classList.remove('np-on'); npEl.classList.remove('is-on');
    npEl.setAttribute('aria-hidden', 'true');
    if (specRaf) { cancelAnimationFrame(specRaf); specRaf = 0; }
    if (npFocusFrom && npFocusFrom.isConnected) npFocusFrom.focus({ preventScroll: true });
  }
  function npSync() {
    if (!npEl) return;
    var p = audio && audio.src && npPlayingItem ? npPlayingItem : playlist[index];
    var pic = p ? p.pic : (coverImg && coverImg.getAttribute('src') || '');
    npTitle.textContent = p ? p.title : (titleEl.textContent || '未在播放');
    npArtist.textContent = p ? p.author : artistEl.textContent;
    npEl.querySelector('.np-album-pl').textContent = audio && audio.src && npPlayingItem ? npPlayingListName : (currentPl().name || '');
    if (pic) {
      if (npImg.getAttribute('src') !== pic) {
        setCover(npImg, pic); npImg.style.visibility = '';
        npBg.style.backgroundImage = 'url("' + coverUrl(pic).replace(/["\\\n\r]/g, '') + '")';
      }
    } else { npImg.removeAttribute('src'); npImg.style.visibility = 'hidden'; npBg.style.backgroundImage = ''; }
    var coverForHash = coverUrl(pic);
    if (coverForHash !== npAccentFor) {
      npAccentFor = coverForHash;
      npAccentColor = '#d5af89'; npEl.style.setProperty('--np-accent', npAccentColor);
      if (coverForHash) pickAccent(coverForHash);
    }
    npRenderQueue(); npTick(); npSyncPlayIcon();
  }
  function npTick() {
    if (!npEl || !npOpen) return;
    var dur = audio && isFinite(audio.duration) ? audio.duration : 0;
    var cur = audio ? audio.currentTime : 0, pct = dur ? Math.min(100, cur / dur * 100) : 0;
    npFill.style.width = pct + '%'; npDot.style.left = pct + '%';
    npCur.textContent = fmtTime(cur); npDur.textContent = fmtTime(dur);
    var sec = Math.floor(cur);
    if (npBar.getAttribute('aria-valuenow') !== String(sec) ||
        npBar.getAttribute('aria-valuemax') !== String(Math.floor(dur))) {
      npBar.setAttribute('aria-valuemax', String(Math.floor(dur)));
      npBar.setAttribute('aria-valuenow', String(sec));
      npBar.setAttribute('aria-valuetext', fmtTime(cur) + ' / ' + fmtTime(dur));
    }
    npSyncLyrics(cur);
  }
  function npSyncPlayIcon() {
    if (!npEl) return;
    var on = !!(audio && !audio.paused); npEl.classList.toggle('is-paused', !on);
    npPlay.innerHTML = on ? ICONS.pause : ICONS.play; npPlay.setAttribute('aria-label', on ? '暂停' : '播放');
    npEl.querySelector('.np-state').textContent = on ? '正在播放' : '暂停片刻';
    npEl.querySelector('.np-playing-label').textContent = on ? '正在聆听' : '空格，继续听';
  }
  function npSyncLyrics(t) {
    var key = lyric.key + ':' + !!lyric.ready + ':' + lyric.lines.length + ':' + !!lyric.failed;
    if (key !== npLyricKey) {
      npLyricKey = key; npActive = -2; npTrack.replaceChildren();
      if (!lyric.ready || !lyric.lines.length || lyric.pure) {
        var empty = document.createElement('div'); empty.className = 'np-lyric-empty';
        var title = document.createElement('strong'), subtitle = document.createElement('span');
        title.textContent = !lyric.ready ? '歌词正慢慢到来' : lyric.failed ? '暂时没取到歌词' : '把时间交给旋律';
        subtitle.textContent = !lyric.ready ? '正在载入' : lyric.failed ? '播放不受影响' : '纯音乐';
        empty.append(title, subtitle); npTrack.appendChild(empty);
        npEl.classList.add('no-lyrics'); npEl.querySelector('.np-lyric-position').textContent = ''; return;
      }
      npEl.classList.remove('no-lyrics');
      lyric.lines.forEach(function (line, i) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'np-line'; b.dataset.time = line.t;
        var text = document.createElement('span'); text.textContent = line.text; b.appendChild(text);
        var tr = transAt(line.t);
        if (tr) { var small = document.createElement('small'); small.textContent = tr; b.appendChild(small); }
        npTrack.appendChild(b);
      });
    }
    if (!lyric.ready || !lyric.lines.length || lyric.pure) return;
    var lo = 0, hi = lyric.lines.length - 1, idx = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (lyric.lines[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx === npActive) return;
    var old = npActive; npActive = idx;
    var active = Math.max(0, idx), children = npTrack.children;
    for (var i = 0; i < children.length; i++) {
      children[i].classList.toggle('is-active', i === idx);
      children[i].classList.toggle('is-near', Math.abs(i - active) === 1);
      children[i].classList.toggle('is-far', Math.abs(i - active) > 1);
      children[i].tabIndex = Math.abs(i - active) <= 1 ? 0 : -1;
      if (i === idx) children[i].setAttribute('aria-current', 'true'); else children[i].removeAttribute('aria-current');
    }
    var target = children[active]; if (!target) return;
    /* Limit the scroll to the remaining phrase time. Seeking is an immediate reposition.
       Geometry doesn't change with active state, avoiding a frame-to-frame layout jump. */
    var remaining = idx >= 0 && lyric.lines[idx + 1] ? (lyric.lines[idx + 1].t - t) * 1000 : 5000;
    var ms = old >= 0 && idx === old + 1 ? Math.max(70, Math.min(460, remaining * .35)) : 0;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) ms = 0;
    npTrack.style.transitionDuration = ms + 'ms';
    npTrack.style.transform = 'translate3d(0,' + Math.round(npLyrics.clientHeight * .45 - target.offsetTop - target.offsetHeight / 2) + 'px,0)';
    npEl.querySelector('.np-lyric-position').textContent = String(active + 1).padStart(2, '0') + ' / ' + String(lyric.lines.length).padStart(2, '0');
    npEl.querySelector('.np-follow').textContent = idx < 0 ? '前奏，把呼吸放慢' : '随音乐慢慢往下';
  }

  function initSpectrum() {
    if (actx) return !!analyser;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !audio) return false;

    try {
      actx = new AC();
      var src = actx.createMediaElementSource(audio);
      /* 先接回扬声器再谈分析。顺序反过来的话，analyser 那步万一抛了，
         声音就永远出不来，用户只会觉得「点了没声」 */
      src.connect(actx.destination);
      analyser = actx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      analyser.minDecibels = -82;
      analyser.maxDecibels = -16;
      src.connect(analyser);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch (e) {
      console.warn('[music] 频谱起不来，退回静态背景', e);
      analyser = null;
      freqData = null;
      return false;
    }
  }

  function specLoop() {
    specRaf = requestAnimationFrame(specLoop);
    if (!analyser || !npSpec || !npOpen) return;

    var c = npSpec;
    var w = c.clientWidth;
    var h = c.clientHeight;
    if (!w || !h) return;

    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cw = Math.round(w * dpr);
    var ch = Math.round(h * dpr);
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }

    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);

    analyser.getByteFrequencyData(freqData);

    var bars = 64;
    /* 只取前 60% 的频段。后面全是高频噪声，人耳听不出，画出来只是毛刺 */
    var span = Math.floor(freqData.length * 0.6);
    var step = Math.max(1, Math.floor(span / bars));
    var bw = cw / bars;

    ctx.fillStyle = npTheme === 'day' ? '#897153' : npAccentColor;
    for (var i = 0; i < bars; i++) {
      var sum = 0;
      for (var k = 0; k < step; k++) sum += freqData[i * step + k];
      var v = sum / step / 255;
      /* 开方压动态范围：不然安静段落全贴底、副歌又全顶满 */
      v = Math.sqrt(v);
      /* 右侧衰减，像一条从左往右淡出的光带 */
      v *= 1 - (i / bars) * 0.5;

      var bh = Math.max(1.5, v * ch * 0.86);
      ctx.globalAlpha = 0.35 + v * 0.55;
      ctx.fillRect(i * bw + bw * 0.2, ch - bh, bw * 0.6, bh);
    }
    ctx.globalAlpha = 1;
  }

  /* 从封面里挑一个能当强调色的平均色 */
  function pickAccent(url) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () {
      if (url !== npAccentFor) return;
      try {
        var c = document.createElement('canvas');
        c.width = 24;
        c.height = 24;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 24, 24);
        var d = ctx.getImageData(0, 0, 24, 24).data;

        var r = 0, g = 0, b = 0, n = 0;
        for (var i = 0; i < d.length; i += 4) {
          var lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          /* 过黑过白的不算。它们在模糊背景里贡献的是灰，不是颜色，
             混进来会把主色拉脏 */
          if (lum < 34 || lum > 220) continue;
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          n++;
        }
        if (!n) return;

        r = Math.round(r / n);
        g = Math.round(g / n);
        b = Math.round(b / n);

        /* 往白里提 34%：暗背景上的强调色得够亮才看得见 */
        r = Math.round(r + (255 - r) * 0.34);
        g = Math.round(g + (255 - g) * 0.34);
        b = Math.round(b + (255 - b) * 0.34);

        npAccentColor = 'rgb(' + r + ',' + g + ',' + b + ')';
        npEl.style.setProperty('--np-accent', npAccentColor);
      } catch (e) {
        /* canvas 被污染就守着默认色，不影响播放 */
      }
    };
    img.src = url;
  }



  document.addEventListener('keydown', function (e) {
    if (!npOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (npEl.classList.contains('queue-on')) npToggleQueue(false); else closeNp(); return;
    }
    if (e.key === 'Tab') {
      var region = npEl.classList.contains('queue-on') ? npEl.querySelector('.np-drawer') : npEl;
      var list = Array.from(region.querySelectorAll('button:not([disabled]), input, [tabindex="0"]')).filter(function (n) { return n.tabIndex >= 0 && n.offsetParent && !n.closest('[inert]'); });
      if (!list.length) return;
      if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === list[list.length - 1]) { e.preventDefault(); list[0].focus(); }
      return;
    }
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable || e.target === npBar) return;
    if (e.key === ' ' && tag === 'BUTTON') return; // native activation must not toggle twice
    if (e.repeat) return;
    npWakeAudio();
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  });

  function syncRoute() {
    var onMusic = isMusicPage();
    document.body.classList.toggle('music-page', onMusic);
    if (onMusic) {
      // PJAX 切换会把 #article-container 整个换掉，旧引用失效时重建
      if (!document.getElementById('music-page')) {
        pageEl = null;
        rowsEl = null;
        renderMusicPage();
      }
      toggleOpen(true);
    } else {
      pageEl = null;
      rowsEl = null;
      /* 歌词层留着——全站共用，正在放歌时还得显示。 */
      buildLyricLayer();
      mountLyric();
    }
  }

  function init() {
    if (document.getElementById('music-dock')) return;
    build();
    bind();
    restorePos();
    initAudio();
    bootstrap();
    syncRoute();
    window.addEventListener('resize', clamp);

    /* 移动端切后台、桌面端关标签页，都不一定触发 pause，这里兜一次底 */
    window.addEventListener('pagehide', function () { saveState(true); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) saveState(true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  document.addEventListener('pjax:complete', syncRoute);
  document.addEventListener('pjax:success', syncRoute);
})();
