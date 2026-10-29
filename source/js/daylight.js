/*!
 * 白天主题 · 日光动效（光尘 / 花瓣 / 飞鸟）
 *
 * 夜里走的是 universe.js 的星空 + 流星，白天底图是一张晴空山湖，
 * 这里补一套同气质但属于白天的动效：
 *
 *   1. 光尘 —— 阳光里的浮尘，暖金色，缓缓上浮、明灭，对应夜里的萤火
 *   2. 花瓣 —— 斜向飘落，带翻转和摇摆，对应夜里的流星
 *   3. 飞鸟 —— 隔一阵成群掠过画面上方，给静态底图添一点生气
 *
 * 只在浅色主题下绘制；切到深色会立刻停掉循环并清空画布，
 * 既不和星空叠在一起，也省掉一份 rAF 开销。
 * 系统开启「减少动态效果」时整块不画。
 */
;(function () {
  'use strict'

  var canvas = document.getElementById('daylight')
  if (!canvas) return

  var ctx = canvas.getContext('2d')
  if (!ctx) return

  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* ---------- 状态 ---------- */

  var W = 0
  var H = 0
  var area = 0
  var dpr = 1

  var motes = [] // 光尘
  var bokeh = [] // 大颗虚焦光斑，只托一层空气感
  var petals = [] // 花瓣
  var flocks = [] // 飞鸟群

  var running = false
  var rafId = 0
  var lastTs = 0
  var clock = 0
  var nextFlockAt = 0
  var revealed = false
  var resizeTimer = null

  function rand (a, b) {
    return a + Math.random() * (b - a)
  }

  /* ---------- 精灵：光晕与花瓣预渲染成小图，逐帧只做 drawImage ---------- */

  function makeGlow (r, g, b, size) {
    var c = document.createElement('canvas')
    c.width = c.height = size
    var g2 = c.getContext('2d')
    var half = size / 2
    var grd = g2.createRadialGradient(half, half, 0, half, half, half)
    grd.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',0.95)')
    grd.addColorStop(0.22, 'rgba(' + r + ',' + g + ',' + b + ',0.58)')
    grd.addColorStop(0.5, 'rgba(' + r + ',' + g + ',' + b + ',0.16)')
    grd.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)')
    g2.fillStyle = grd
    g2.fillRect(0, 0, size, size)
    return c
  }

  // 暖金 / 淡金 / 米白，三种光尘轮换，免得整片一个色。
  // 底色是亮蓝天 + 白云，纯白点会糊掉，所以主色压到偏琥珀的金。
  var GLOWS = [
    makeGlow(255, 199, 96, 64),
    makeGlow(255, 219, 150, 64),
    makeGlow(255, 243, 214, 64)
  ]

  function makePetal (size) {
    var c = document.createElement('canvas')
    c.width = c.height = size
    var g = c.getContext('2d')
    var half = size / 2
    g.translate(half, half)

    var grd = g.createLinearGradient(0, -half * 0.78, 0, half * 0.78)
    grd.addColorStop(0, 'rgba(255, 212, 229, 0.98)')
    grd.addColorStop(0.55, 'rgba(255, 237, 244, 0.95)')
    grd.addColorStop(1, 'rgba(249, 189, 214, 0.95)')

    // 偏圆的瓣形，窄了会像白色碎纸片
    g.beginPath()
    g.moveTo(0, -half * 0.78)
    g.bezierCurveTo(half * 0.8, -half * 0.56, half * 0.74, half * 0.46, 0, half * 0.78)
    g.bezierCurveTo(-half * 0.74, half * 0.46, -half * 0.8, -half * 0.56, 0, -half * 0.78)
    g.closePath()
    g.fillStyle = grd
    g.fill()

    // 描一圈淡粉边：底图云层很白，纯浅色花瓣压上去会糊掉
    g.strokeStyle = 'rgba(224, 132, 170, 0.26)'
    g.lineWidth = Math.max(1, size * 0.028)
    g.stroke()

    // 叶脉：一条极淡的中线，翻转时能看出朝向
    g.beginPath()
    g.moveTo(0, -half * 0.58)
    g.quadraticCurveTo(half * 0.07, 0, 0, half * 0.58)
    g.strokeStyle = 'rgba(226, 150, 180, 0.38)'
    g.lineWidth = Math.max(1, size * 0.03)
    g.stroke()

    return c
  }

  var PETAL_SPRITE = makePetal(64)

  /* ---------- 粒子生成 ---------- */

  function spawnMote (fromBottom) {
    var r = rand(1.5, 3.6)
    return {
      x: rand(-20, W + 20),
      y: fromBottom ? rand(H * 0.3, H + 30) : rand(-20, H + 20),
      r: r,
      vx: rand(-4, 10), // px/s，微风向右
      vy: -rand(4, 16), // px/s，向上飘
      swayAmp: rand(4, 18),
      swayFreq: rand(0.25, 0.75),
      phase: rand(0, Math.PI * 2),
      twinkleFreq: rand(0.5, 1.6),
      twinklePhase: rand(0, Math.PI * 2),
      alpha: rand(0.55, 0.95),
      sprite: GLOWS[Math.floor(Math.random() * GLOWS.length)],
      scale: rand(6, 10) // 光晕直径 = r * scale
    }
  }

  function spawnBokeh () {
    return {
      x: rand(0, W),
      y: rand(0, H),
      r: rand(16, 44),
      vx: rand(-2, 3),
      vy: rand(-4, -1),
      swayAmp: rand(6, 20),
      swayFreq: rand(0.08, 0.22),
      phase: rand(0, Math.PI * 2),
      alpha: rand(0.07, 0.14),
      sprite: GLOWS[1]
    }
  }

  function spawnPetal (fromTop) {
    return {
      x: rand(-40, W + 40),
      y: fromTop ? rand(-H * 0.3, -20) : rand(-40, H),
      size: rand(14, 26),
      vx: rand(8, 22),
      vy: rand(16, 38),
      rot: rand(0, Math.PI * 2),
      rotSpeed: rand(-0.9, 0.9),
      swayAmp: rand(10, 30),
      swayFreq: rand(0.35, 0.8),
      phase: rand(0, Math.PI * 2),
      flutterFreq: rand(0.8, 1.9),
      flutterPhase: rand(0, Math.PI * 2),
      alpha: rand(0.6, 0.88)
    }
  }

  function spawnFlock () {
    if (flocks.length >= 2) return

    var dir = Math.random() < 0.5 ? 1 : -1
    var count = 2 + Math.floor(Math.random() * 3)
    var flock = {
      dir: dir,
      speed: rand(45, 75),
      x: dir > 0 ? -80 : W + 80,
      y: rand(H * 0.06, H * 0.26),
      members: []
    }

    for (var i = 0; i < count; i++) {
      flock.members.push({
        dx: (i - (count - 1) / 2) * rand(11, 20),
        dy: rand(-14, 14),
        size: rand(3.6, 6.4),
        flap: rand(0, Math.PI * 2),
        flapSpeed: rand(6, 9),
        alpha: rand(0.34, 0.55)
      })
    }

    flocks.push(flock)
  }

  function seed () {
    area = W * H

    var moteCount = Math.max(26, Math.min(80, Math.round(area / 20000)))
    var bokehCount = Math.max(3, Math.min(9, Math.round(area / 190000)))
    var petalCount = Math.max(8, Math.min(22, Math.round(area / 85000)))

    motes = []
    for (var i = 0; i < moteCount; i++) motes.push(spawnMote(false))

    bokeh = []
    for (var j = 0; j < bokehCount; j++) bokeh.push(spawnBokeh())

    petals = []
    for (var k = 0; k < petalCount; k++) petals.push(spawnPetal(false))

    flocks = []
    nextFlockAt = clock + rand(3, 8)
  }

  /* ---------- 逐帧更新 ---------- */

  function update (dt) {
    var i, p

    for (i = 0; i < motes.length; i++) {
      p = motes[i]
      p.phase += p.swayFreq * dt
      p.twinklePhase += p.twinkleFreq * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      if (p.y < -30) {
        p.y = H + 30
        p.x = rand(-20, W + 20)
      }
      if (p.x > W + 30) p.x = -30
      if (p.x < -30) p.x = W + 30
    }

    for (i = 0; i < bokeh.length; i++) {
      p = bokeh[i]
      p.phase += p.swayFreq * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      if (p.y < -60) {
        p.y = H + 60
        p.x = rand(0, W)
      }
      if (p.x > W + 60) p.x = -60
      if (p.x < -60) p.x = W + 60
    }

    for (i = 0; i < petals.length; i++) {
      p = petals[i]
      p.phase += p.swayFreq * dt
      p.flutterPhase += p.flutterFreq * dt
      p.rot += p.rotSpeed * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      if (p.y > H + 40 || p.x > W + 60) {
        petals[i] = spawnPetal(true)
      } else if (p.x < -60) {
        p.x = W + 60
      }
    }

    if (clock >= nextFlockAt) {
      spawnFlock()
      nextFlockAt = clock + rand(16, 34)
    }

    for (i = flocks.length - 1; i >= 0; i--) {
      var f = flocks[i]
      f.x += f.dir * f.speed * dt
      if ((f.dir > 0 && f.x > W + 140) || (f.dir < 0 && f.x < -140)) flocks.splice(i, 1)
    }
  }

  /* ---------- 绘制 ---------- */

  function drawBird (x, y, size, flapPhase, flapSpeed, alpha) {
    // lift 为正是翅膀上抬、为负是下压，幅度按体型缩放
    var lift = Math.sin(clock * flapSpeed + flapPhase) * size * 0.7

    ctx.globalAlpha = alpha
    ctx.strokeStyle = 'rgb(32, 48, 64)'
    ctx.lineWidth = Math.max(1, size * 0.22)
    ctx.beginPath()
    ctx.moveTo(x - size, y - lift)
    ctx.quadraticCurveTo(x - size * 0.45, y - lift * 0.2 + size * 0.2, x, y)
    ctx.quadraticCurveTo(x + size * 0.45, y - lift * 0.2 + size * 0.2, x + size, y - lift)
    ctx.stroke()
  }

  function drawFlock (f) {
    for (var i = 0; i < f.members.length; i++) {
      var m = f.members[i]
      var x = f.x + f.dir * m.dx
      var y = f.y + m.dy + Math.sin(clock * 0.6 + m.flap) * 3
      drawBird(x, y, m.size, m.flap, m.flapSpeed, m.alpha)
    }
  }

  function render () {
    var i, p

    ctx.clearRect(0, 0, W, H)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // 大颗光斑：几乎透明，只用来托一层空气感
    for (i = 0; i < bokeh.length; i++) {
      p = bokeh[i]
      var bx = p.x + Math.sin(p.phase) * p.swayAmp
      ctx.globalAlpha = p.alpha
      ctx.drawImage(p.sprite, bx - p.r, p.y - p.r, p.r * 2, p.r * 2)
    }

    // 光尘
    for (i = 0; i < motes.length; i++) {
      p = motes[i]
      var mx = p.x + Math.sin(p.phase) * p.swayAmp
      var twinkle = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(p.twinklePhase))
      var d = p.r * p.scale
      ctx.globalAlpha = p.alpha * twinkle
      ctx.drawImage(p.sprite, mx - d / 2, p.y - d / 2, d, d)
    }

    // 花瓣
    for (i = 0; i < petals.length; i++) {
      p = petals[i]
      var px = p.x + Math.sin(p.phase) * p.swayAmp
      var flip = 0.45 + 0.55 * Math.abs(Math.sin(p.flutterPhase))

      ctx.save()
      ctx.translate(px, p.y)
      ctx.rotate(p.rot)
      ctx.scale(flip, 1)
      ctx.globalAlpha = p.alpha
      ctx.drawImage(PETAL_SPRITE, -p.size / 2, -p.size / 2, p.size, p.size)
      ctx.restore()
    }

    for (i = 0; i < flocks.length; i++) drawFlock(flocks[i])

    ctx.globalAlpha = 1
  }

  /* ---------- 主循环 ---------- */

  function tick (ts) {
    if (!running) return
    rafId = window.requestAnimationFrame(tick)

    // 切到后台就只续帧不画，回来时把时间基准重置，避免一次跳很远
    if (document.hidden) {
      lastTs = ts
      return
    }

    var dt = lastTs ? (ts - lastTs) / 1000 : 0.016
    lastTs = ts
    if (dt > 0.05) dt = 0.05

    clock += dt
    update(dt)
    render()

    if (!revealed) {
      revealed = true
      canvas.classList.add('is-on')
    }
  }

  function start () {
    if (running || reduceMotion) return
    running = true
    lastTs = 0
    rafId = window.requestAnimationFrame(tick)
  }

  function stop () {
    running = false
    if (rafId) window.cancelAnimationFrame(rafId)
    rafId = 0
    // 这里不清画布：切深色时 CSS 还在做 0.5s 淡出，
    // 立刻清空会让粒子「啪」地消失，留最后一帧随画布一起淡出更顺。
    // 切回浅色时首帧的 clearRect 会兜底。
  }

  function isLight () {
    return document.documentElement.getAttribute('data-theme') !== 'dark'
  }

  function sync () {
    if (reduceMotion) return
    if (isLight()) start()
    else stop()
  }

  /* ---------- 尺寸 ---------- */

  function resize () {
    var w = window.innerWidth
    var h = window.innerHeight
    if (w === W && h === H) return

    // 面积变化不大（比如手机地址栏收起）就只改画布，不重排粒子
    var bigChange = !area || Math.abs(w * h - area) / area > 0.12

    W = w
    H = h
    dpr = Math.min(window.devicePixelRatio || 1, 2)

    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    if (bigChange) seed()
  }

  /* ---------- 启动 ---------- */

  function init () {
    resize()

    // 系统开了「减少动态效果」就完全不画，画布保持隐藏
    if (reduceMotion) return

    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resize, 180)
    })

    if (isLight()) start()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
