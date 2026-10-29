/*!
 * 首页副标题 · 诗句轮播
 *
 * 主题自带的 subtitle.effect 走的是 Typed.js + loop:true，
 * 而今日诗词一次只返回一句，于是同一句会被无限重打。
 *
 * 这里的做法：页面打开时取一小批句子存在本地，按队列播放，
 * 队列播完就重新洗牌复用，隔几轮再补一两句新的。句子允许复用，
 * 接口调用量很低（一次打开约 8 次，之后每 3 轮补 2 次）。
 */
;(function () {
  'use strict'

  var el = document.getElementById('subtitle')
  if (!el || window.__poemSubtitleStarted) return
  window.__poemSubtitleStarted = true

  var API = 'https://v2.jinrishici.com/one.json?client=browser-sdk/1.2'
  var TOKEN_KEY = 'jinrishici-token'

  // ── 节奏参数：按「整句」计时长，不是单字间隔 ──
  var TYPE_MS = 3000 // 一句打完用多久
  var HOLD_MS = 4000 // 打完停留多久
  var ERASE_MS = 1500 // 一句退格用多久

  // ── 取词参数 ──
  var POOL_SIZE = 8 // 每次打开页面先取几句
  var REFILL_COUNT = 2 // 每次补几句新的
  var REFILL_EVERY = 3 // 每播完几轮补一次（接口当天往往只给同一首诗的句子，补太勤也是重复的）
  var ARCHIVE_LIMIT = 60 // 最多记住多少句，控制单轮长度
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

  function requestPoem () {
    var token = readToken()
    var url = API + (token ? '&X-User-Token=' + encodeURIComponent(token) : '')

    return fetch(url, { credentials: 'omit' })
      .then(function (res) {
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

  // 并发取几句，最多 3 个请求同时跑；取到一句就放进队列，不必等整批
  function fillPool (count) {
    var started = 0

    function worker () {
      if (started >= count) return Promise.resolve()
      started++
      pendingFetches++

      return requestPoem()
        .then(function (line) {
          addToArchive(line)
          if (line !== lastLine && pool.indexOf(line) === -1) pool.push(line)
        })
        .catch(function () {})
        .then(function () {
          pendingFetches--
          return worker()
        })
    }

    var workers = []
    for (var i = 0; i < Math.min(3, count); i++) workers.push(worker())
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

  function type (text) {
    return new Promise(function (resolve) {
      if (reduceMotion) {
        el.textContent = text
        resolve()
        return
      }

      var step = Math.max(16, TYPE_MS / Math.max(text.length, 1))
      var i = 0
      el.textContent = ''

      ;(function tick () {
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
    return new Promise(function (resolve) {
      if (reduceMotion || !el.textContent) {
        el.textContent = ''
        resolve()
        return
      }

      var step = Math.max(12, ERASE_MS / Math.max(el.textContent.length, 1))

      ;(function tick () {
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
    nextTimer = setTimeout(function () {
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

    var line = take()

    if (!line) {
      running = false
      schedule(WAIT_MS)
      return
    }

    erase()
      .then(function () {
        return type(line)
      })
      .then(function () {
        schedule(HOLD_MS)
      })
      .catch(function (err) {
        console.warn('[poem-subtitle] 轮播异常：', err && err.message)
        schedule(RETRY_MS)
      })
      .then(function () {
        running = false
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
    // 万一副标题还是由主题启动的，先把它的 Typed 实例停掉，避免两套逻辑打架
    if (window.typed && typeof window.typed.destroy === 'function') {
      try {
        window.typed.destroy()
      } catch (err) {}
    }
    window.typed = null

    el.textContent = ''

    // 打字机光标（放在 #subtitle 外面，改文字时不会被清掉）
    if (el.parentNode) {
      var caret = document.createElement('span')
      caret.className = 'poem-caret'
      caret.setAttribute('aria-hidden', 'true')
      el.parentNode.insertBefore(caret, el.nextSibling)
    }

    fillPool(POOL_SIZE)
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
})()
