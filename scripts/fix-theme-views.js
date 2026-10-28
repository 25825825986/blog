/*!
 * 修复 Hexo 视图误注册问题（Hexo 7.3.0 / 8.1.2 均存在，hexo-util 3.3.0 与 4.0.0 均未修复）
 *
 * 背景：
 *   Hexo 用 Pattern('layout/*path') 识别主题布局文件。hexo-util 的
 *   Pattern 在编译正则时没有加首尾锚定，导致 'layout/*path' 被编译成
 *   /layout\/(.*)?/ —— 只要路径里出现 "layout/" 子串就会命中。
 *
 *   蝴蝶主题的样式目录 themes/butterfly/source/css/_layout/ 正好含有
 *   "layout/" 子串，于是 post.styl、sidebar.styl 等样式表被当成布局注册：
 *     views['post'] = { '.styl': ..., '.pug': ... }
 *
 *   Theme.getView('post') 取 Object.keys()[0]，而主题处理器按
 *   [config, i18n, source, view] 顺序执行，.styl 永远排在 .pug 前面，
 *   结果文章页拿样式表当模板渲染 -> Stylus 报错 -> 输出 0 字节 / 本地
 *   预览请求挂起。
 *
 * 处理：
 *   在每次生成前清掉这些被误注册的样式视图。布局必须是模板文件，
 *   正常情况下主题不会用 .styl/.css 当布局，所以移除是安全的。
 */
hexo.extend.filter.register('before_generate', () => {
  const views = hexo.theme && hexo.theme.views;
  if (!views) return;

  const STYLE_EXTS = ['.styl', '.stylus', '.css', '.scss', '.less'];
  let removed = 0;

  Object.keys(views).forEach(name => {
    const byExt = views[name];
    if (!byExt) return;

    STYLE_EXTS.forEach(ext => {
      if (byExt[ext]) {
        delete byExt[ext];
        removed += 1;
      }
    });

    if (Object.keys(byExt).length === 0) delete views[name];
  });

  if (removed > 0) {
    hexo.log.debug(`[fix-theme-views] 已移除 ${removed} 个被误注册为布局的样式视图`);
  }
}, 1);
