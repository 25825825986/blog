---
# 2025.4.26
---
问题：
- 搜索图标未显示
- 网页加载缓慢，图片加载失败（可能：图片太大了，未使用cdn，或者versual部署有误）
- 白天黑夜切换时，特效未清除
- 想要在白天模式添加雪花特效
- 按钮ui样式不好看，如：博客下面的页数标签，侧边栏的背景
- 公告的小标签不喜欢
---

# 2025.5.12
---
解决：
- 网页加载缓慢的问题，github中绑定个人域名，使用cloudfare加速访问
- 日夜间特效切换，通过更换背景布清除夜间流星特效
---

# 部署说明（GitHub Pages）

线上地址：<https://25825825986.github.io/>

- 本站源码仓库：`25825825986/blog`（Hexo 源文件）
- 站点产物仓库：`25825825986/25825825986.github.io`（构建后的 `public/`，默认分支 `master`）
- 自动部署：推送到 `main` 分支后，`.github/workflows/deploy-pages.yml` 会自动构建并发布到站点仓库。

首次启用需要在 `blog` 仓库的 Settings → Secrets and variables → Actions 中添加：

- `PAGES_DEPLOY_TOKEN`：一个具备目标仓库 `Contents: Read and write` 权限的 GitHub Token（PAT）

本地运行：

```bash
npm install
npx hexo clean && npx hexo generate
npx hexo server -p 4000
```

注意：`themes/butterfly` 在仓库中是失效的 submodule 引用（缺少 `.gitmodules`），
本地首次使用需手动拉取主题：

```bash
git clone https://github.com/jerryc127/hexo-theme-butterfly.git themes/butterfly
```

自定义样式与特效位于 `source/css/custom.css`、`source/css/universe.css`、`source/js/universe.js`，
通过 `_config.butterfly.yml` 的 `inject` 注入，与主题解耦，升级主题不会丢失。
