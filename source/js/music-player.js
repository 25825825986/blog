(function () {
  var POS_KEY = 'music-dock-pos';
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
      coverImg.src = item.pic;
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
    /* 只有「续播」这一条路径会带 resumeAt；点歌、上一首、下一首一律从头放 */
    pendingSeek = (typeof resumeAt === 'number' && resumeAt > 0) ? resumeAt : 0;
    audio.src = item.url;
    titleEl.textContent = item.title || '未知曲目';
    artistEl.textContent = item.author || '';
    loadLyric(item.songId);
    if (item.pic) {
      coverImg.src = item.pic;
      coverBtn.classList.add('has-cover');
    } else {
      coverBtn.classList.remove('has-cover');
    }
    highlightRow();
    updateProgress();
    syncPlayAllLabel();
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

    audio.addEventListener('play', function () {
      failCount = 0;
      dock.classList.add('playing');
      playBtn.innerHTML = ICONS.pause;
      playBtn.setAttribute('aria-label', '暂停');
      highlightRow();
    });

    audio.addEventListener('pause', function () {
      dock.classList.remove('playing');
      playBtn.innerHTML = ICONS.play;
      playBtn.setAttribute('aria-label', '播放');
      highlightRow();
      saveState(true);
    });

    audio.addEventListener('timeupdate', function () {
      updateProgress();
      syncLyric(audio.currentTime || 0);
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
      failCount += 1;
      if (failCount > 5) {
        console.warn('[music] 连续多首无法播放，先停下');
        return;
      }
      setTimeout(next, 320);
    });
  }

  /* 依次尝试各个源，第一个成功就返回；全部失败才抛错 */
  function fetchPlaylistFrom(i, id) {
    var base = METING_APIS[i];
    var url = base + '?server=netease&type=playlist&id=' + id + '&r=' + Math.random();
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) throw new Error('返回空歌单');
        return list;
      })
      .catch(function (err) {
        if (i + 1 < METING_APIS.length) {
          console.warn('[music] 源不可用，换下一个：' + base, err);
          return fetchPlaylistFrom(i + 1, id);
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
  var lyricEl = null, lyricLineEl = null, lyricTransEl = null;
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
    var meta = {}, lines = [];
    for (var i = 0; i < rows.length; i++) {
      var m = CREDIT_RE.exec(rows[i].text);
      if (m && rows[i].t < 8) {
        if (!meta[m[1]]) meta[m[1]] = m[2].trim();
      } else {
        lines.push(rows[i]);
      }
    }
    return { meta: meta, lines: lines };
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

  /* pjax 换页后 DOM 是新的，元素引用要重新拿一遍，再按当前状态重画 */
  function mountLyric() {
    lyricEl = pageEl ? pageEl.querySelector('.mp-lyric') : null;
    lyricLineEl = pageEl ? pageEl.querySelector('.mp-lyric__line') : null;
    lyricTransEl = pageEl ? pageEl.querySelector('.mp-lyric__trans') : null;
    if (lyricEl && lyric.ready) renderIdle();
  }

  function loadLyric(songId) {
    var id = songId ? String(songId) : '';
    if (!id) {
      lyric = { key: '', lines: [], trans: [], meta: {}, pure: true, ready: true };
      lyricIdx = -2;
      paintLyric('', '', true);
      return;
    }
    if (lyric.key === id) return;

    lyric = { key: id, lines: [], trans: [], meta: {}, pure: false, ready: false };
    lyricIdx = -2;
    paintLyric('', '', true);

    fetchLyric(0, id).then(function (d) {
      if (lyric.key !== id) return;   /* 已经切歌，这批数据丢掉 */
      var main = splitCredits(parseLrc(d && d.lrc));
      lyric.lines = main.lines;
      lyric.meta = main.meta;
      lyric.trans = parseLrc(d && d.tlyric);
      lyric.pure = looksPure(main.lines);
      lyric.ready = true;
      renderIdle();
      syncLyric(audio.currentTime || 0);
    }).catch(function () {
      if (lyric.key !== id) return;
      lyric.pure = true;
      lyric.ready = true;
      renderIdle();
    });
  }

  /* 有歌词就停在当前那句；纯音乐显示署名，别留一块空白 */
  function renderIdle() {
    if (!lyricLineEl) return;
    if (!lyric.pure && lyric.lines.length) {
      var line = lyric.lines[lyricIdx >= 0 ? lyricIdx : 0];
      paintLyric(line.text, transAt(line.t), true);
      /* pjax 回来时重画，前奏的淡色状态也要一起还原 */
      if (lyricLineEl) lyricLineEl.classList.toggle('is-pending', lyricIdx < 0);
      return;
    }
    var sub = [];
    if (lyric.meta['作曲']) sub.push('作曲 ' + lyric.meta['作曲']);
    /* 作曲编曲常常是同一人，别写成「作曲 xx · 编曲 xx」 */
    if (lyric.meta['编曲'] && lyric.meta['编曲'] !== lyric.meta['作曲']) {
      sub.push('编曲 ' + lyric.meta['编曲']);
    }
    paintLyric('纯音乐', sub.join(' · '), true);
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
        paintLyric(lyric.lines[0].text, '', true);
        if (lyricLineEl) lyricLineEl.classList.add('is-pending');
      }
      return;
    }
    if (idx === lyricIdx) return;
    if (lyricLineEl) lyricLineEl.classList.remove('is-pending');
    lyricIdx = idx;
    var line = lyric.lines[idx];
    paintLyric(line.text, transAt(line.t));
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

  /* 换一句：先淡出，210ms 后换字再淡入。
     间隔太短的快歌直接换，否则两句挤在一起反而看不清。 */
  function paintLyric(text, trans, instant) {
    if (!lyricLineEl || !lyricTransEl) return;
    var now = Date.now();
    if (!instant && now - lyricPaintedAt < 1100) instant = true;
    lyricPaintedAt = now;

    var gen = ++lyricGen;
    clearTimeout(lyricTimer);
    lyricLineEl.classList.remove('is-in');
    lyricTransEl.classList.remove('is-in');

    function apply() {
      if (gen !== lyricGen) return;
      lyricLineEl.textContent = text || '';
      lyricTransEl.textContent = trans || '';
      lyricTransEl.hidden = !trans;
      /* 强制回流，否则同一个 class 连着加两次不会有过渡 */
      void lyricLineEl.offsetWidth;
      lyricLineEl.classList.add('is-in');
      if (trans) lyricTransEl.classList.add('is-in');
    }

    if (instant) { apply(); return; }
    lyricTimer = setTimeout(apply, 210);
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
      '<span class="mp-hero__kicker">网易云音乐 · 歌单</span>',
      '<h1 class="mp-hero__title">正在载入歌单…</h1>',
      '<p class="mp-hero__desc">正在连接</p>',
      '<div class="mp-hero__ops">',
      '<button class="mp-btn mp-btn--primary" type="button" data-act="playall">' + ICONS.play + '<span>播放全部</span></button>',
      '<button class="mp-btn" type="button" data-act="shuffle">随机播放</button>',
      '</div>',
      '</div>',
      '</header>',
      '<div class="mp-lyric" aria-live="polite" aria-label="歌词">',
      '<p class="mp-lyric__line"></p>',
      '<p class="mp-lyric__trans" hidden></p>',
      '</div>',
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
    mountLyric();

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
    var coverNode = pageEl.querySelector('.mp-hero__cover img');
    var bgNode = pageEl.querySelector('.mp-hero__bg');

    var pl = currentPl();

    /* 标题永远是当前歌单名（载入中也一样），切换时不会闪成「正在载入」 */
    titleNode.textContent = pl.name;
    descNode.textContent = playlist.length
      ? '共 ' + playlist.length + ' 首 · 数据来自网易云音乐'
      : (loading ? '正在连接网易云音乐' : '还没加载出来，点「播放全部」重试');

    /* 封面优先用歌单自己的，列表还没到时也有图可看 */
    var pic = pl.cover || (playlist[0] && playlist[0].pic) || '';
    if (pic) {
      coverNode.src = pic;
      coverNode.classList.add('is-ready');
      bgNode.style.backgroundImage = 'url("' + pic.replace(/"/g, '\\"') + '")';
      // 未开始播放时，播放条也显示歌单封面，避免只有一个音符图标
      if (!audio || !audio.src) {
        coverImg.src = pic;
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
  }

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
      lyricEl = null;
      lyricLineEl = null;
      lyricTransEl = null;
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
