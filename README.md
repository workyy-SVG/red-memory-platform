# 红色记忆 · 免费公开展示版

用于 Cloudflare Pages 静态托管，发布目录为 `dist`。本仓库保持私有，部署后的网站可以公开访问。

## 保留的功能

五章主题展、来源与证据卡、人物照片及署名、153 条记忆资源分类检索、时空点位示意、知识图谱、动态讲解、浏览器语音与 PWA。语音及安装能力依设备和浏览器而异。地图没有配置服务商密钥时为示意图。

收藏和观展进度保存在当前浏览器 localStorage 中；无账号同步，清除网站数据后会丢失。在线 AI、管理后台、数据库写入和媒体上传不在这个静态版本中。免费展示版不等同于本机 Python/MySQL 完整 Demo。

## Cloudflare Pages 部署

1. 使用免费 Cloudflare 账号，完成邮箱验证。
2. 在 Workers & Pages 中选择创建 Pages 项目，连接 GitHub。
3. 授权时仅选择 `workyy-SVG/red-memory-platform` 仓库。
4. 生产分支 `main`；框架预设 `None`；构建命令留空；构建输出目录 `dist`；根目录留空。
5. 保存并部署，成功后使用控制台实际返回的 `https://<项目名称>.pages.dev` 地址。
6. 在手机和电脑上测试该实际网址后，再生成二维码。不要把本机 localhost 地址做成分享二维码。

初次连接 GitHub 的 Pages 项目使用 Git 集成更新，后续推送 main 自动部署。还可以使用另一个 Direct Upload 项目上传 dist 中的文件或其 ZIP；两种项目创建方式不要混淆。

## 免费条件与访问

Cloudflare 官方 Pages 页面说明可以免费开始、无需信用卡。保持免费套餐，不启用需付费/绑卡的产品。本站无需 R2、Workers 付费套餐或自购域名。免费额度、验证要求以实际控制台和当期官方规则为准。不同网络访问 pages.dev 的速度和可用性需要实测，不能承诺所有地区均正常。

## 内容及维护

2026-10-21 从本机 MySQL 只读导出公开内容快照，保留现有媒体与署名。未包含数据库连接信息、模型密钥、管理员资料、访客会话或备份。本仓库并非整个本机工作目录的镜像。

新增资料需要更新公开内容快照和对应素材后重新部署。核校状态沿用原条目，公开发布不代表所有史实已经通过第二人复核。图片许可见 dist/media/credits.json 及页面来源说明。

参考：https://developers.cloudflare.com/pages/get-started/git-integration/ ，https://www.cloudflare.com/products/pages/
