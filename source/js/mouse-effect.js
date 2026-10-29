/*!
 * 鼠标点击 · 星尘涟漪
 *
 * 夜里点一下，金色碎星向外荡开，配一圈缓慢扩散的光环，
 * 笔触沿用 universe.js 的小方块，和星空是同一只手画的。
 * 白天换成暖金与淡粉的碎屑，会慢慢往上飘，接 daylight.js 的花瓣气质。
 *
 * 只在点击那一刻起循环，粒子散尽就停掉 rAF，不常驻空转。
 * 系统开启「减少动态效果」时整块不启用。
 */
;(function () {
  'use strict'

  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduceMotion) return

  var canvas = document.createElement('canvas')
  canvas.id = 'mouse-ripple'
  canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)

  var ctx = canvas.getContext('2d')
  if (!ctx) return

  var W = 0
  var H = 0
  var dpr = 1
  var parts = []
  var rings = []
  var flash = null
  var running = false
  var rafId = 0
  var lastTs = 0
  var resizeTimer = null

  // 同屏最多留这么多粒子，连点时丢掉最老的，避免一路堆到卡顿
  var MAX_PARTS = 240

  function rand (a, b) {
    return a + Math.random() * (b - a)
  }

  /* ---------- 精灵：光晕预渲染成小图，逐帧只做 drawImage ---------- */

  function makeGlow (r, g, b, size) {
    var c = document.createElement('canvas')
    c.width = c.height = size
    var g2 = c.getContext('2d')
    var half = size / 2
    var grd = g2.createRadialGradient(half, half, 0, half, half, half)
    grd.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',0.95)')
    grd.addColorStop(0.2, 'rgba(' + r + ',' + g + ',' + b + ',0.5)')
    grd.addColorStop(0.5, 'rgba(' + r + ',' + g + ',' + b + ',0.13)')
    grd.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)')
    g2.fillStyle = grd
    g2.fillRect(0, 0, size, size)
    return c
  }

  // 夜：金 / 蓝白 / 纯白，取自 universe.js 的三色星
  var NIGHT = [
    { glow: makeGlow(226, 225, 142, 32), core: 'rgba(248,246,196,' },
    { glow: makeGlow(180, 184, 240, 32), core: 'rgba(216,220,255,' },
    { glow: makeGlow(226, 225, 224, 32), core: 'rgba(255,255,255,' }
  ]

  // 昼：琥珀 / 花瓣粉 / 米金。亮底会把浅色吃掉，
  // 所以光晕留亮、实心核压深，靠这点对比撑住可见度
  var DAY = [
    { glow: makeGlow(255, 186, 96, 32), core: 'rgba(224,140,46,' },
    { glow: makeGlow(250, 175, 200, 32), core: 'rgba(214,112,152,' },
    { glow: makeGlow(255, 240, 214, 32), core: 'rgba(198,152,86,' }
  ]

  var RING_NIGHT = 'rgba(226,225,224,'
  var RING_DAY = 'rgba(186,124,78,'

  /* ---------- 一次点击 ---------- */

  function burst (x, y) {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark'
    var set = dark ? NIGHT : DAY
    var count = 28

    // 按视口宽度收放扩散半径，窄屏上不会显得炸得太开
    var scale = Math.max(0.7, Math.min(1.4, W / 1200))

    if (parts.length > MAX_PARTS) parts.splice(0, parts.length - MAX_PARTS)

    for (var i = 0; i < count; i++) {
      // 角度抖得大一点，免得排成一圈规整的圆点
      var a = (i / count) * Math.PI * 2 + rand(-0.55, 0.55)
      // 速度偏向慢的：中心留一层细密碎屑，只放几颗飞得远
      var speed = (1.2 + Math.pow(Math.random(), 1.6) * 3.6) * scale
      var s = set[(Math.random() * set.length) | 0]

      parts.push({
        x: x,
        y: y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 1,
        decay: rand(0.008, 0.018),
        size: rand(14, 34),
        glow: s.glow,
        core: s.core,
        square: dark,
        drift: dark ? 0 : rand(-0.014, 0.004)
      })
    }

    rings.push({ x: x, y: y, r: 5, life: 1, color: dark ? RING_NIGHT : RING_DAY })

    // 点击瞬间的一小团光核，200ms 内散尽，让「点到了」有反馈
    flash = { x: x, y: y, r: 8, life: 1, glow: set[0].glow }
    start()
  }

  /* ---------- 循环 ---------- */

  function update (k) {
    var drag = Math.pow(0.95, k)

    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i]
      p.x += p.vx * k
      p.y += p.vy * k
      p.vy += p.drift * k
      p.vx *= drag
      p.vy *= drag
      p.life -= p.decay * k
      if (p.life <= 0) parts.splice(i, 1)
    }

    for (var j = rings.length - 1; j >= 0; j--) {
      var g = rings[j]
      g.r += 3.4 * k
      g.life -= 0.032 * k
      if (g.life <= 0) rings.splice(j, 1)
    }

    if (flash) {
      flash.r += 3.4 * k
      flash.life -= 0.09 * k
      if (flash.life <= 0) flash = null
    }
  }

  function render () {
    ctx.clearRect(0, 0, W, H)

    if (flash) {
      var f = flash.life * flash.life
      var fr = flash.r * 2
      ctx.globalAlpha = f * 0.55
      ctx.drawImage(flash.glow, flash.x - fr / 2, flash.y - fr / 2, fr, fr)
      ctx.globalAlpha = 1
    }

    for (var i = 0; i < parts.length; i++) {
      var p = parts[i]
      // 平方衰减，末尾收得比线性快，不会拖一条长长的尾巴
      var a = p.life * p.life

      var s = p.size * (0.55 + p.life * 0.6)
      ctx.globalAlpha = a * 0.8
      ctx.drawImage(p.glow, p.x - s / 2, p.y - s / 2, s, s)

      // 光晕只是托一层柔光，真正被看见的是这颗实心核，所以它要够亮够大
      ctx.globalAlpha = Math.min(1, a * 1.5)
      ctx.fillStyle = p.core + a.toFixed(3) + ')'
      if (p.square) {
        var c = Math.max(1, 3 * p.life)
        ctx.fillRect(p.x - c / 2, p.y - c / 2, c, c)
      } else {
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(0.8, 2.4 * p.life), 0, 6.2832)
        ctx.fill()
      }
    }

    ctx.globalAlpha = 1

    for (var j = 0; j < rings.length; j++) {
      var g = rings[j]
      ctx.beginPath()
      ctx.strokeStyle = g.color + (g.life * 0.22).toFixed(3) + ')'
      ctx.lineWidth = 1
      ctx.arc(g.x, g.y, g.r, 0, 6.2832)
      ctx.stroke()
    }
  }

  function tick (ts) {
    var dt = lastTs ? Math.min(32, ts - lastTs) : 16.67
    lastTs = ts
    var k = dt / 16.67

    update(k)
    render()

    if (parts.length || rings.length || flash) {
      rafId = window.requestAnimationFrame(tick)
    } else {
      running = false
      rafId = 0
      lastTs = 0
      ctx.clearRect(0, 0, W, H)
    }
  }

  function start () {
    if (running) return
    running = true
    lastTs = 0
    rafId = window.requestAnimationFrame(tick)
  }

  /* ---------- 尺寸 ---------- */

  function resize () {
    W = window.innerWidth
    H = window.innerHeight
    dpr = Math.min(window.devicePixelRatio || 1, 2)

    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /* ---------- 启动 ---------- */

  function init () {
    resize()

    document.addEventListener(
      'pointerdown',
      function (e) {
        if (typeof e.button === 'number' && e.button !== 0) return
        burst(e.clientX, e.clientY)
      },
      { passive: true }
    )

    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resize, 180)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
