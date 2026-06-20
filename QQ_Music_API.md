# QQ 音乐依赖说明

这个项目当前用到的 QQ 音乐相关仓库和接口如下。

## 使用到的仓库

### `goodday1024/QQMusicApi1`

项目优先使用这个仓库提供的 QQ 音乐能力，主要用于：

- QQ 扫码登录
- QQ 歌单列表
- QQ 收藏歌单 / 收藏歌曲
- QQ 歌单详情
- QQ 歌词
- QQ 搜索
- QQ 歌曲直链

项目里对应的环境变量是：

- `QQMUSIC_API1_BASE_URL`

### `qq-music-api`

作为兼容回退使用，主要用于：

- 登录态补充
- 歌单 / 歌曲接口回退
- 部分歌词回退

### `wp_MusicApi`

作为 QQ 音乐播放链接解析的备用仓库。

### `CharlesPikachu/musicdl`

项目没有直接引入原仓库，但实现了兼容它思路的 QQ 音乐播放解析策略。

## 播放链接接口

### `musicsquare tang detail`

项目在解析 QQ 音乐播放链接时，会优先尝试这个接口。

详细请求地址：

```text
https://tang.api.s01s.cn/music_open_api.php?msg={keyword}&type=json&mid={mid}
```

参数说明：

- `msg`：搜索关键词，通常是“歌名 歌手”
- `type=json`：固定为 `json`
- `mid`：QQ 歌曲 `mid`

它对应的逻辑在后端里是：

- 先按歌曲 `id` 和 `keyword` 去请求 tang detail
- 如果能拿到可播放链接，就直接返回
- 如果失败，再继续走其他 QQ 音乐解析回退方案

这个策略的目标是：

- 尽量拿到可播放原曲
- 提高 QQ 歌曲解析成功率
- 在主解析失败时不影响继续播放

## 相关环境变量

- `QQMUSIC_API1_BASE_URL`
- `WP_MUSIC_API_BASE_URL`
- `QQMUSIC_CHARLES_MUSICDL_FALLBACK`
- `QQMUSIC_CHARLES_MUSICDL_APIS`
- `QQMUSIC_NKI_API_KEYS`
- `QQMUSIC_XIANYUW_API_KEYS`
- `QQMUSIC_CY_API_KEYS`
- `QQMUSIC_LXMUSIC_REQUEST_KEY`

## 结论

当前项目里，QQ 音乐能力主要依赖：

1. `QQMusicApi1`
2. `qq-music-api`
3. `wp_MusicApi`
4. `musicsquare tang detail` 播放链接接口
5. 兼容 `musicdl` 思路的备用解析链路
