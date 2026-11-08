/*!
 * 按访问者本地时间自动切换明暗主题
 *
 * 08:00 进入明色，19:00 进入暗色。首屏由 Butterfly 的
 * darkmode.autoChangeMode 提前设定，避免页面闪烁；这里只负责
 * 页面持续打开、跨过时间边界时同步主题。
 *
 * 手动切换仍可在两个边界之间生效，到下一个边界会恢复自动模式。
 */
;(function () {
  'use strict'

  var LIGHT_START = 8
  var DARK_START = 19

  var timer = null
  var scheduledMode = null

  function desiredMode (date) {
    var hour = date.getHours()
    return hour >= LIGHT_START && hour < DARK_START ? 'light' : 'dark'
  }

  function currentMode () {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  }

  function clearManualMode () {
    try {
      localStorage.removeItem('theme')
    } catch (e) {}
  }

  function switchMode (mode) {
    if (currentMode() === mode) return

    var button = document.getElementById('darkmode')
    if (button) {
      button.click()
      return
    }

    if (window.btf && window.btf.activateDarkMode && window.btf.activateLightMode) {
      mode === 'dark' ? window.btf.activateDarkMode() : window.btf.activateLightMode()
    }
  }

  function nextBoundary (now) {
    var boundary = desiredMode(now) === 'light' ? DARK_START : LIGHT_START
    var next = new Date(now.getTime())

    next.setHours(boundary, 0, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)

    return next
  }

  function applyAutoMode () {
    var mode = desiredMode(new Date())

    scheduledMode = mode
    clearManualMode()
    switchMode(mode)
  }

  function scheduleNextBoundary () {
    if (timer !== null) window.clearTimeout(timer)

    var now = new Date()
    var wait = nextBoundary(now).getTime() - now.getTime() + 1000
    timer = window.setTimeout(function () {
      applyAutoMode()
      scheduleNextBoundary()
    }, Math.max(1000, wait))
  }

  scheduledMode = desiredMode(new Date())
  scheduleNextBoundary()

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return
    if (desiredMode(new Date()) !== scheduledMode) {
      applyAutoMode()
      scheduleNextBoundary()
    }
  })
})()
