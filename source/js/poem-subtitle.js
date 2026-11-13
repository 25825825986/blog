/*!
 * 首页副标题 · 诗句轮播
 *
 * 主题自带的 subtitle.effect 走的是 Typed.js + loop:true，
 * 而今日诗词一次只返回一句，于是同一句会被无限重打。
 *
 * 这里的做法：页面打开时取一小批句子存在本地，按队列播放，
 * 队列播完就重新洗牌复用，隔几轮再补一两句新的。句子允许复用。
 *
 * 接口按 IP 限速，实测每秒超过两次就返 403，而且 403 的响应体是空的，
 * 前端只能看到一个光秃秃的状态码。所以：
 *   1) 所有请求排成一条串行队列，两次之间至少隔 700ms；
 *   2) 取到的句子存 localStorage，下次打开先用旧的直接开播，
 *      有缓存时一次都不请求；
 *   3) 一旦撞到 403 就停止本轮补句，越打只会限得越久。
 */
;(function () {
  'use strict'

  /* #subtitle 在 #body-wrap 里，pjax 换页时会被整块替换成新节点，
     所以不能在这里抓一次就完事——那样会一直往已经脱离文档的旧节点上打字，
     表现为「从文章页回首页后副标题一片空白」。真实取元素放在 start() 里。 */
  var el = null
  if (window.__poemSubtitleStarted) return
  window.__poemSubtitleStarted = true

  var API = 'https://v2.jinrishici.com/one.json?client=browser-sdk/1.2'
  var TOKEN_KEY = 'jinrishici-token'
  var CACHE_KEY = 'poem-cache-v1'

  /* 两次请求的最小间隔。实测 400ms 时第六个就 403，600ms 能过，
     取 700ms 留余量。 */
  var MIN_GAP = 700

  // ── 节奏参数：按「整句」计时长，不是单字间隔 ──
  var TYPE_MS = 3000 // 一句打完用多久
  var HOLD_MS = 4000 // 打完停留多久
  var ERASE_MS = 1500 // 一句退格用多久

  // ── 取词参数 ──
  var POOL_SIZE = 5 // 每次打开页面先取几句（限速下不宜多）
  var REFILL_COUNT = 1 // 每次补几句新的
  var REFILL_EVERY = 3 // 每播完几轮补一次（接口当天往往只给同一首诗的句子，补太勤也是重复的）
  var ARCHIVE_LIMIT = 60 // 最多记住多少句，控制单轮长度
  var CACHE_LIMIT = 60 // 本地缓存上限
  var WAIT_MS = 800 // 暂时没有可播的句子时等多久
  var RETRY_MS = 5000 // 异常时的重试间隔

  // 接口不可用时兜底，保证横幅不空着
  var FALLBACK = [
    '人生代代无穷已，江月年年只相似。',
    '江流宛转绕芳甸，月照花林皆似霰。',
    '桂花香雾冷，梧叶西风影。',
    '宁可枝头抱香死，何曾吹落北风中。',
    '洛阳城里见秋风，欲作家书意万重。'
  ]

  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* ---------- 诗句池 ---------- */

  var pool = [] // 待播队列
  var archive = [] // 本次打开页面取到过的句子
  var lastLine = '' // 上一句，避免紧接着重播
  var roundCount = 0 // 已经播完几轮
  var pendingFetches = 0 // 还在路上的请求数

  function shuffle (list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1))
      var tmp = list[i]
      list[i] = list[j]
      list[j] = tmp
    }
    return list
  }

  function addToArchive (line) {
    if (!line || archive.indexOf(line) !== -1) return
    archive.push(line)
    if (archive.length > ARCHIVE_LIMIT) archive.shift()
  }

  /* ---------- 请求今日诗词 ---------- */

  function readToken () {
    try {
      return window.localStorage.getItem(TOKEN_KEY)
    } catch (err) {
      return null
    }
  }

  function saveToken (token) {
    if (!token) return
    try {
      window.localStorage.setItem(TOKEN_KEY, token)
    } catch (err) {}
  }

  /* ---------- 本地缓存 ----------
     取到的句子存下来，下次打开先用旧的直接开播。限速是按 IP 的，
     同一台机器反复刷新页面时，缓存能把请求量降到零。 */

  function readCache () {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY)
      if (!raw) return []
      var arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return []
      return arr.filter(function (x) {
        return typeof x === 'string' && x
      })
    } catch (err) {
      return []
    }
  }

  function saveCache (list) {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(list.slice(-CACHE_LIMIT)))
    } catch (err) {}
  }

  /* ---------- 请求（串行 + 限速） ----------
     接口按 IP 限速，实测每秒超过两次就 403，响应体为空。
     所以所有请求串成一条链，前一个回来再等 MIN_GAP 才发下一个。 */

  var lastReqAt = 0
  var reqChain = Promise.resolve()

  function sleep (ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms)
    })
  }

  function doFetch () {
    var token = readToken()
    var url = API + (token ? '&X-User-Token=' + encodeURIComponent(token) : '')

    return fetch(url, { credentials: 'omit' })
      .then(function (res) {
        if (res.status === 403) {
          var err = new Error('HTTP 403')
          err.rateLimited = true
          throw err
        }
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(function (json) {
        saveToken(json && json.token)
        if (!json || json.status !== 'success' || !json.data || !json.data.content) {
          throw new Error((json && json.errMessage) || '接口返回为空')
        }
        return json.data.content
      })
  }

  function requestPoem () {
    var run = reqChain.then(function () {
      var wait = MIN_GAP - (Date.now() - lastReqAt)
      if (wait < 0) wait = 0
      return sleep(wait).then(function () {
        lastReqAt = Date.now()
        return doFetch()
      })
    })

    // 链本身不能因为一次失败就断掉
    reqChain = run.then(function () {}, function () {})
    return run
  }

  /* 取几句。requestPoem 自己会排队限速，这里开两个 worker 只是让队列
     不至于因为一次失败就断掉；真正发出去的请求永远是一条一条的。 */
  function fillPool (count) {
    var started = 0
    var stopped = false

    function worker () {
      if (stopped || started >= count) return Promise.resolve()
      started++
      pendingFetches++

      return requestPoem()
        .then(function (line) {
          addToArchive(line)
          saveCache(archive)
          if (line !== lastLine && pool.indexOf(line) === -1) pool.push(line)
        })
        .catch(function (err) {
          // 撞到限速就别继续了，越打恢复得越慢
          if (err && err.rateLimited) stopped = true
        })
        .then(function () {
          pendingFetches--
          return worker()
        })
    }

    var workers = []
    for (var i = 0; i < Math.min(2, count); i++) workers.push(worker())
    return Promise.all(workers)
  }

  function seedFallback () {
    FALLBACK.forEach(addToArchive)
    pool = pool.concat(shuffle(FALLBACK.slice()))
  }

  // 队列播完了：把已有句子重新洗牌再来一轮，隔几轮才补几句新的
  function replenish () {
    var reuse = archive.slice()

    if (reuse.length > 1 && lastLine) {
      var idx = reuse.indexOf(lastLine)
      if (idx !== -1) {
        reuse.splice(idx, 1)
        reuse.push(lastLine) // 上一句排到最后，避免紧接着重播
      }
    }

    pool = shuffle(reuse)

    roundCount++
    if (roundCount % REFILL_EVERY === 0 && archive.length < ARCHIVE_LIMIT) {
      fillPool(REFILL_COUNT)
    }
  }

  function take () {
    if (!pool.length) replenish()

    // 一句都取不到，或者只取到一句（接口当天只给同一句）时，掺几句兜底，免得卡住
    if (!pool.length || (archive.length <= 1 && !pendingFetches)) seedFallback()

    var line = pool.shift()

    if (line === lastLine) {
      if (pool.length) {
        pool.push(line)
        line = pool.shift()
      } else {
        pool.push(line)
        return null // 只剩这一句，等新句子进来再播
      }
    }

    lastLine = line
    return line
  }

  /* ---------- 打字 / 退格 ---------- */

  var typeTimer = null
  var nextTimer = null
  var running = false
  var pausedWhileHidden = false
  /* 每次重启（pjax 换页）都会 +1。异步链路里都记住自己那一代的号，
     发现不是当前代就直接退出——否则新旧两套循环会同时往同一个元素上打字。 */
  var gen = 0

  function type (text) {
    var my = gen
    return new Promise(function (resolve) {
      if (reduceMotion) {
        if (my === gen) el.textContent = text
        resolve()
        return
      }

      var step = Math.max(16, TYPE_MS / Math.max(text.length, 1))
      var i = 0
      el.textContent = ''

      ;(function tick () {
        if (my !== gen) { resolve(); return }   // 已重启，旧元素不要了
        if (i >= text.length) {
          resolve()
          return
        }
        el.textContent += text.charAt(i++)
        typeTimer = setTimeout(tick, step)
      })()
    })
  }

  function erase () {
    var my = gen
    return new Promise(function (resolve) {
      if (reduceMotion || !el.textContent) {
        if (my === gen) el.textContent = ''
        resolve()
        return
      }

      var step = Math.max(12, ERASE_MS / Math.max(el.textContent.length, 1))

      ;(function tick () {
        if (my !== gen) { resolve(); return }
        var text = el.textContent
        if (!text) {
          resolve()
          return
        }
        el.textContent = text.slice(0, -1)
        typeTimer = setTimeout(tick, step)
      })()
    })
  }

  /* ---------- 主循环 ---------- */

  function schedule (delay) {
    clearTimeout(nextTimer)
    var my = gen
    nextTimer = setTimeout(function () {
      if (my !== gen) return
      if (document.hidden) {
        pausedWhileHidden = true
        return
      }
      cycle()
    }, delay)
  }

  function cycle () {
    if (running || document.hidden) {
      if (document.hidden) pausedWhileHidden = true
      return
    }
    running = true
    var my = gen

    var line = take()

    if (!line) {
      if (my === gen) running = false
      schedule(WAIT_MS)
      return
    }

    erase()
      .then(function () {
        return type(line)
      })
      .then(function () {
        if (my === gen) schedule(HOLD_MS)
      })
      .catch(function (err) {
        console.warn('[poem-subtitle] 轮播异常：', err && err.message)
        if (my === gen) schedule(RETRY_MS)
      })
      .then(function () {
        if (my === gen) running = false
      })
  }

  /* ---------- 启动 ---------- */

  // 队列里一有句子就开播，不必等整批取完
  function whenReady (fn) {
    var waited = 0
    ;(function check () {
      if (pool.length || waited >= 3000) {
        fn()
        return
      }
      waited += 100
      setTimeout(check, 100)
    })()
  }

  function start () {
    // 每次启动都重新取：pjax 换页后 #subtitle 是新节点
    el = document.getElementById('subtitle')
    if (!el) return   // 非首页（文章页 / 归档页都没有副标题）

    gen++             // 作废上一代还在跑的循环
    running = false
    pausedWhileHidden = false
    clearTimeout(typeTimer)
    clearTimeout(nextTimer)

    // 万一副标题还是由主题启动的，先把它的 Typed 实例停掉，避免两套逻辑打架
    if (window.typed && typeof window.typed.destroy === 'function') {
      try {
        window.typed.destroy()
      } catch (err) {}
    }
    window.typed = null

    el.textContent = ''

    // 打字机光标（放在 #subtitle 外面，改文字时不会被清掉）
    if (el.parentNode && !el.parentNode.querySelector('.poem-caret')) {
      var caret = document.createElement('span')
      caret.className = 'poem-caret'
      caret.setAttribute('aria-hidden', 'true')
      el.parentNode.insertBefore(caret, el.nextSibling)
    }

    /* 先用上次存下的句子开播，不等网络。
       有缓存时连一次请求都不用发，刷新页面也不会再去撞限速。 */
    var cached = readCache()
    if (cached.length) {
      cached.forEach(addToArchive)
      pool = pool.concat(shuffle(cached.slice()))
    }

    // 缓存够用就只补一句新的，不够才补到 POOL_SIZE
    var need = POOL_SIZE - cached.length
    fillPool(need > 0 ? need : 1)

    whenReady(cycle)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }

  // 切到后台就暂停轮播，回到前台再继续
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && pausedWhileHidden) {
      pausedWhileHidden = false
      clearTimeout(nextTimer)
      cycle()
    }
  })

  /* ---------- pjax ----------
   * pjax 只替换 #body-wrap 里的内容，本脚本不会被重新执行。
   * 换页时先把旧循环停掉（否则它还会往已经销毁的节点上打字），
   * 新页面落地后如果是首页就重新启动。 */
  document.addEventListener('pjax:send', function () {
    gen++
    clearTimeout(typeTimer)
    clearTimeout(nextTimer)
    running = false
    pausedWhileHidden = false
  })

  document.addEventListener('pjax:complete', function () {
    if (document.getElementById('subtitle')) start()
  })
})()
