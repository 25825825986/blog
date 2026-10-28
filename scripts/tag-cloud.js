/*!
 * 标签页：把主题的彩色标签云改写成标签索引
 *
 * 背景：
 *   主题 scripts/helpers/page.js 的 cloudTags 会给每个标签随机取一个 RGB 底色
 *   （getRandomColor），字号又按标签名长度浮动 1.2~1.5em。结果标签页是一排
 *   深浅不一的彩色胶囊，跟全站的天蓝主色对不上，而且每次 hexo g 颜色都会变。
 *
 * 为什么不用「重新注册 cloudTags」：
 *   Hexo 加载脚本时先扫 scripts/、再扫 themes/xxx/scripts/（实测如此，且是并发），
 *   站点脚本注册的同名 helper 会被主题的实现盖掉。所以改用 after_render:html
 *   过滤器——渲染已经完成，改的是最终 HTML，不依赖加载顺序，也不动 themes/。
 *
 * 输出：
 *   一行统计 + 若干条 <a class="tag-cloud-item">，样式见 custom.css「标签页」一节。
 */

'use strict'

const { escapeHTML, unescapeHTML } = require('hexo-util')

const CLOUD_BLOCK = /<div class="tag-cloud-list[^"]*">([\s\S]*?)<\/div>/
const ANCHOR = /<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g

hexo.extend.filter.register('after_render:html', function (str) {
  if (!str || !str.includes('tag-cloud-list')) return str

  const block = CLOUD_BLOCK.exec(str)
  if (!block) return str

  // 主题已经把标签链接渲染好了（路径、编码都对），这里只取 href 复用
  const hrefs = new Map()
  let anchor
  ANCHOR.lastIndex = 0
  while ((anchor = ANCHOR.exec(block[1])) !== null) {
    hrefs.set(unescapeHTML(anchor[2]).trim(), anchor[1])
  }

  const allTags = hexo.locals.get('tags')
  if (!allTags) return str
  const tags = allTags.toArray()
  if (!tags.length) return str

  // 文章数降序、同数按名称：主题默认随机排序，每次构建顺序都会变
  tags.sort((a, b) => (b.length - a.length) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))

  const items = tags.map(tag => {
    const href = hrefs.get(tag.name) || `/tags/${encodeURIComponent(tag.name)}/`
    return `<a class="tag-cloud-item" href="${href}">` +
      `<span class="tag-cloud-item__name">${escapeHTML(tag.name)}</span>` +
      `<span class="tag-cloud-item__count">${tag.length} 篇</span>` +
      '</a>'
  })

  const html = `<div class="tag-cloud-list">` +
    `<p class="tag-cloud-meta">共 ${tags.length} 个标签</p>` +
    items.join('') +
    '</div>'

  return str.replace(CLOUD_BLOCK, () => html)
})
