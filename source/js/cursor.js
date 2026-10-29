/*!
 * 自定义光标 · 星点 + 跟随光环
 *
 * 内芯严格跟手（瞄准不失真），外圈慢半拍追上来，
 * 指到链接/按钮时撑开一圈，按下时收一下。
 *
 * 只在精确指针设备上初始化；触屏直接不跑。
 * 输入框区域让位给原生光标，那里需要 I 型竖线。
 * 外圈只在没追上的时候跑 rAF，追上了就停。
 */
;(function () {
  'use strict'

  var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches
  if (!fine) return

  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  var ring = document.createElement('div')
  ring.id = 'cursor-ring'
  ring.setAttribute('aria-hidden', 'true')
  ring.appendChild(document.createElement('i'))

  var dot = document.createElement('div')
  dot.id = 'cursor-dot'
  dot.setAttribute('aria-hidden', 'true')
  dot.appendChild(document.createElement('i'))

  document.body.appendChild(ring)
  document.body.appendChild(dot)
  document.documentElement.classList.add('cursor-on')

  // 链接、按钮这类可点区域，光环会撑开
  var HOT = 'a, button, [role="button"], label, .site-page, .copy-btn, .search-close-button'
  // 这些地方交回原生光标
  var NATIVE = 'input, textarea, select, [contenteditable="true"], iframe'

  var mx = -100
  var my = -100
  var rx = -100
  var ry = -100
  var running = false
  var rafId = 0
  var shown = false

  function place (el, x, y) {
    el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'
  }

  function tick () {
    rx += (mx - rx) * 0.22
    ry += (my - ry) * 0.22

    if (Math.abs(mx - rx) < 0.2 && Math.abs(my - ry) < 0.2) {
      rx = mx
      ry = my
      place(ring, rx, ry)
      running = false
      rafId = 0
      return
    }

    place(ring, rx, ry)
    rafId = window.requestAnimationFrame(tick)
  }

  function start () {
    if (running) return
    running = true
    rafId = window.requestAnimationFrame(tick)
  }

  function show (on) {
    if (on === shown) return
    shown = on
    ring.classList.toggle('is-on', on)
    dot.classList.toggle('is-on', on)
  }

  function onMove (e) {
    mx = e.clientX
    my = e.clientY

    place(dot, mx, my)
    show(true)

    if (reduceMotion) {
      rx = mx
      ry = my
      place(ring, rx, ry)
      return
    }

    start()
  }

  function onOver (e) {
    var t = e.target
    if (!t || !t.closest) return

    var native = t.closest(NATIVE) !== null
    ring.classList.toggle('is-hidden', native)
    dot.classList.toggle('is-hidden', native)

    var hot = !native && t.closest(HOT) !== null
    ring.classList.toggle('is-hot', hot)
    dot.classList.toggle('is-hot', hot)
  }

  document.addEventListener('mousemove', onMove, { passive: true })
  document.addEventListener('mouseover', onOver, { passive: true })

  document.addEventListener('mousedown', function () {
    ring.classList.add('is-down')
  })

  document.addEventListener('mouseup', function () {
    ring.classList.remove('is-down')
  })

  document.documentElement.addEventListener('mouseleave', function () {
    show(false)
    ring.classList.remove('is-down')
  })

  window.addEventListener('blur', function () {
    show(false)
  })
})()
