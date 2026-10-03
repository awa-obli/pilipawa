<div align="center">

<img src="public/pilipawa-logo.png" alt="pilipawa" width="400" />

<h1>噼哩啪哇 (゜-゜)つロ</h1>

<p>一个简洁、实用的第三方 bilibili 网页客户端。</p>

</div>

## 功能特性

- **推荐流**：首页推荐视频 / 热门视频，滚动到底自动加载
- **搜索**：视频 / UP 主搜索，支持排序与分类筛选、分页
- **动态**：关注动态流
- **播放**：画中画、截图、倍速、全屏、多清晰度切换、分 P、弹幕、评论、表情 / @ / 图片评论、点赞 / 投币 / 收藏、播放心跳
- **个人主页**：资料卡、投稿、历史记录、收藏夹管理、关注 / 粉丝列表
- **设置**：一键切换深色主题

## 环境要求

- Node.js >= 18
- 运行时依赖仅 [express](https://expressjs.com/) 与 [qrcode](https://github.com/soldair/node-qrcode)

## 快速开始

```bash
npm install
npm start
```

启动后访问 <http://localhost:3001> ，控制台会打印各页面入口。

## 目录结构

```
server.js              唯一后端：代理 B 站接口 + 会话管理 + 静态页路由
public/
  index.html           首页：推荐流
  search.html          搜索结果页
  dynamic.html         动态页：关注动态流
  player.html          播放页：播放器 / 弹幕 / 评论 / 点赞投币收藏
  account.html         个人主页：资料卡 / 投稿 / 历史 / 收藏夹 / 关注粉丝
  settings.html        设置页：外观（深色主题）
  common.css           公共样式与主题变量
  common.js            顶部导航、搜索历史与建议、扫码登录
  theme.js             主题读取与应用
data/sessions.json     登录会话持久化（自动创建，明文，见下）
```

## 页面与接口

页面路由：`/`（首页）、`/search`、`/dynamic`、`/player`、`/account`、`/settings`。

接口按模块分组，全部由服务端转发，前端不直连 B 站：

| 分组 | 接口 |
|---|---|
| 登录 | `/api/login/qrcode`<br>`/api/login/poll`<br>`/api/login/status`<br>`/api/login/logout` |
| 个人主页 | `/api/account/profile`<br>`/api/account/history`<br>`/api/account/favorites`<br>`/api/account/favorites/:mediaId`<br>`/api/account/favorites/remove`<br>`/api/account/favorites/transfer`<br>`/api/account/favorites/create`<br>`/api/account/favorites/edit`<br>`/api/account/favorites/delete`<br>`/api/account/followings`<br>`/api/account/followers` |
| 搜索与推荐 | `/api/search`<br>`/api/suggest`<br>`/api/recommend` |
| 动态 | `/api/dynamics`<br>`/api/action/dynamic-like` |
| 播放 | `/api/info`<br>`/api/play`<br>`/api/related`<br>`/api/up/info`<br>`/api/space/videos` |
| 弹幕与评论 | `/api/danmaku`<br>`/api/reply`<br>`/api/reply/replies`<br>`/api/reply/add`<br>`/api/reply/like`<br>`/api/reply/at`<br>`/api/reply/upload`<br>`/api/reply/del`<br>`/api/emote/panel` |
| 互动 | `/api/action/like`<br>`/api/action/coin`<br>`/api/action/favorite`<br>`/api/action/heartbeat`<br>`/api/action/status`<br>`/api/up/follow` |

## 安全提示

`data/sessions.json` 以**明文**保存 `SESSDATA` 与 `bili_jct`，等同于账号登录凭证：
不要提交到版本库，不要外传，也不要把本服务暴露到不受信任的网络或公网。

## 声明

本项目为非官方项目，与哔哩哔哩无任何关联。

仅供个人学习与技术研究使用，请勿滥用！

使用本程序产生的一切后果由使用者自行承担。

## 致谢

- 接口参考 [bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect)
- 播放器 [ArtPlayer](https://github.com/zhw2590582/ArtPlayer) 与 artplayer-plugin-danmuku

## License

[MIT License](LICENSE)

