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

首次启用需要配置一把 **Deploy Key**（比 PAT 更省心：一次配好、不会过期、不用管作用域）：

1. 生成密钥对（已生成的放在 `.deploy-key/`，已被 `.gitignore` 忽略）：

   ```bash
   ssh-keygen -t ed25519 -C "deploy-key@25825825986.github.io" -f .deploy-key/id_ed25519 -N ""
   ```

2. **公钥**（`.deploy-key/id_ed25519.pub`）→ 加到**目标仓库** `25825825986/25825825986.github.io` 的
   Settings → **Deploy keys** → Add deploy key，**务必勾选 `Allow write access`**。

3. **私钥**（`.deploy-key/id_ed25519`，含首尾 `BEGIN/END` 行）→ 存到**本仓库** `25825825986/blog` 的
   Settings → Secrets and variables → Actions，Name 填 **`DEPLOY_KEY`**。

配好后重跑 Actions 即可。工作流在部署前会先做一次 SSH 认证预检，配错了会给出明确报错而不是难懂的 git 403。

本地运行：

```bash
npm install
npx hexo clean && npx hexo generate
npx hexo server -p 4000
```

主题 `themes/butterfly` 是 git submodule（见 `.gitmodules`），首次克隆后需初始化：

```bash
git submodule update --init --recursive
```

CI 里由 `actions/checkout` 的 `submodules: recursive` 自动拉取。

自定义样式与特效位于 `source/css/custom.css`、`source/css/universe.css`、`source/js/universe.js`，
通过 `_config.butterfly.yml` 的 `inject` 注入，与主题解耦，升级主题不会丢失。
