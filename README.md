# xsbhxh · 新手保护联盟官网

WingsMS 服务器新手保护联盟的家族官网。

**在线地址：** https://miaojunhuai.github.io/xsbhxh/

## 站点结构

| 路径 | 页面 | 说明 |
|---|---|---|
| `index.html` | 官网首页 | 横幅、关于我们（活动合影）+ 导航栏（申请入会 / 工具 / 远征规则 / 关于我们） |
| `apply/index.html` | 入会申请面试 | v1.0.25，随机 20 题，80 分合格 |
| `tools/leader-checklist.html` | 实习团长检查清单 | v1.0.3，9 个阶段 31 项检查点 |
| `tools/price-formatter.html` | 商店价格规范器 | v1.0.1，千分位 + 中文单位 |
| `tools/tribute-puzzle.html` | 贤者贡品 · 四象祭坛 | v1.1.23，家务贡品关卡试玩，四件贡品换成像素图标（兵法卷轴 / 勇猛勋章 / 蛇酒 / 过期食物）；破纪录时「破纪录！」逐字波浪弹跳并下图标雨 + 礼花彩带；触摸设备「重置答案」长按 0.8 秒（进度条横跨状态条）；排行榜按「题型 × 轮数 − 秒数」算分排序，分数由服务器端计算并粗筛作弊，手动练习 + 自动驾驶（1~4 分格点选 / 滑动，格 1 左半为 0）；排行榜（Supabase 免费层，按昵称合并同名、保留最好成绩；通关破纪录时自动收起贡品记录并滚到结果区，提交前用本地缓存预估名次，提交后定位并高亮自己那一行；榜单缓存 5 分钟 + 刷新节流 3 秒）；导航配色跟随页面木色；已优化 iOS 点按延迟 |
| `rules/one-dragon.html` | 远征一条龙规则 | 含 KOOK 语音频道与车队二维码 |
| `rules/tayza.html` | 泰扎副本规则 | 报名、门槛、分红、罚款 |
| `assets/banner.webp` / `banner.jpg` | 首页横幅 | 原图压缩版（1600 宽） |
| `assets/family-icon.png` | 家族图标 | 导航栏左侧图标（像素风，按原图直接显示，不加底色和圆角） |
| `assets/favicon.ico` | 网页图标（多尺寸） | 16 / 32 / 48 三帧 ICO，浏览器标签页优先取用 |
| `assets/favicon-32.png` / `favicon-16.png` | 网页图标（单尺寸） | 补充给按指定尺寸取图标的浏览器 |
| `assets/apple-touch-icon.png` | iOS 主屏图标 | 180×180，iPhone / iPad「添加到主屏」时使用 |
| `assets/icon-192.png` / `icon-512.png` | 安卓 / PWA 图标 | 由 `site.webmanifest` 引用 |
| `site.webmanifest` | 站点清单 | 站点名称、主题色与主屏图标 |
| `assets/activity-1.webp` / `.jpg` | 第一届活动合影 | 压缩版（1200 宽） |
| `assets/activity-2.webp` / `.jpg` | 第二届活动合影 | 压缩版（1200 宽） |

首页导航栏的四项对应首页里的四个分区，点击后滚动到该分区，再从卡片进入具体页面。
每个子页面顶部都有同一套官网导航栏：PC 端常驻，移动端向下滚动时收起、向上滚动时重新出现，
点击导航即可回到首页对应分类。

## 页面来源

| 仓库文件 | 原文件（工作区「现有网页」文件夹） |
|---|---|
| `apply/index.html` | `新手保护协会_入会面试_v1.0.25.html` |
| `tools/leader-checklist.html` | `实习团长检查清单1.0.3.html` |
| `tools/price-formatter.html` | `自用商店价格规范器1.0.1.html` |
| `tools/tribute-puzzle.html` | `家务贡品关卡试玩练习1.0.1.html` |
| `rules/one-dragon.html` | `村内一条家族规则.html` |
| `rules/tayza.html` | `村内泰扎家族规则.html` |
| `assets/banner.webp` | `新手保护联盟横幅.png`（压缩后） |
| `assets/activity-1.webp` | `第一届活动合影.png`（压缩后） |
| `assets/activity-2.webp` | `第二届活动合影.png`（压缩后） |

### 网页图标

整套 favicon 都由工作区「现有网页」里的 `家族图标.png` 生成，没有另画图：

| 项目 | 做法 |
|---|---|
| 源图 | `现有网页\家族图标.png`，15×15 像素风 |
| 放大方式 | 最近邻放大（NEAREST），保持像素方块锐利，不做平滑插值 |
| 生成尺寸 | 16 / 32 / 48 / 180 / 192 / 512 |
| 引用位置 | 首页与 6 个子页面的 `<head>`，子页面路径用 `../assets/` |
| 生成脚本 | `_preview\make-favicon.py`（Pillow，可重跑） |

换了家族图标后要重新生成：改 `make-favicon.py` 里的 `SRC` 再运行一次，然后覆盖 `assets` 下的同名文件即可。

## 以后更新页面

1. 把「现有网页」里的新版本文件内容覆盖到上表对应的仓库文件；
2. 如果新增或改名了页面，记得同步修改首页 `index.html` 里的卡片链接和文字；
3. 子页面顶部的官网导航栏是整合时加的一段代码，覆盖文件后需要重新加上（或保留原文件里的这一段）。

## 关于自动同步

本仓库与本机 `E:\新手保护协会\同步GitHub` 文件夹保持同步：
该文件夹里的改动会在几分钟内自动提交并上传到这里，无需手动操作。
