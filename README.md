# dsh-router-traework

DSH 插件：为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 `traework` 供应商（免费 SOLO 聊天通道）。

本项目是 [traework2api](https://github.com/Sliverkiss/traework2api) 的 DSH 插件版，
上游协议与签到语义参考 [wild-work](https://github.com/rockswang/wild-work)，
宿主参考 [dsh-router](https://github.com/CARVIN94/dsh-router)。

## 安装(DSH)

先装核心 [dsh-router-core](https://github.com/CARVIN94/dsh-router)(dsh-router 仓库,提供面板 + 内置供应商),再装本插件:

```bash
dsh plugin --profile web add dsh-router-core
dsh plugin --profile web add dsh-router-traework
```

`dsh plugin add` 会在 profile 里 `pnpm add`,并自动把声明了 `dsh.bundle.patch`
的包加入 `dsh.profile.bundles`(本插件即声明了,即 `cordis.patch.yml`)。

然后**重启 `dsh web`**。本插件以 cordis service `router.suppliers` 向 dsh-router
注册 `traework` 供应商,面板「供应商」出现 traework 卡片,加账号即用。

> 本地开发版:不用 npm,直接 `dependencies` 加
> `"dsh-router-traework": "link:/path/to/dsh-router-traework"` 指向本地仓库。

## 目录

```
src/
  index.ts       插件入口（提供 router.suppliers service）
  contract.ts    供应商契约
  types.ts       类型定义
  api/           供应商实现（上游客户端、账号凭证池、调度器、登录等）
```

## 与 dsh-router 核心的分工

本插件只管**对单个账号调通上游**：SOLO 协议、token 刷新、SSE 转换、签到、积分。

**策略全在核心**（`AccountPool`）：选号、冷却、禁用、连续错误累计、遍历回退、
响应写入。所以：

- `chatOnce(uid, req)` 一次只服务一个账号，**不遍历账号、不维护冷却表、不写响应**
- 失败时返回语义状态（`rate_limit` / `quota` / `session_dead` / `unavailable` /
  `transport` / `unknown`），由核心决定冷却多久、是否禁用、要不要换号
- `status()` 只报「现在状态」（凭证 + 积分），冷却/禁用由核心叠加后给面板

## 签到

上游 `checkin_credits/*` **一律返回 HTTP 200**，成败只藏在 body 的 `code` 里：

| code | 含义 | 处理 |
|---|---|---|
| `0` | 成功 | ok（**注意**：已签到后重复调用也返回 0，是幂等、不加积分） |
| `9095` | 今日已签到 | already（幂等成功，不是失败） |
| `9074` | 「当前参与用户太多」 | **等 8s 重试一次**——上游短时抖动，重试就过 |

据此定下的判定规则：

- **不能只看 HTTP 状态**（一律 200，会误报成功）
- **不能只看 `code 0` 就以为签上了** —— claim 后要**回查
  `checkin_credits/status` 的 `checked_in`** 才算数
- **不能拿积分当签到凭据** —— `ide_user_ent_usage` 是所有包的聚合剩余额度，
  签到前后可能是同一个数
- `checked_in` 是**当前登录态设备**的读数，换 deviceId 会短暂变 `false`，
  那是缓存假象，不代表「这个账号今天还能再签一次」
- 判重维度是**账号**不是设备：换 deviceId 后 `checked_in` 依然是 `true`

调度器一天只跑一次，所以 9074 必须重试 —— 不重试等于当天签到直接废掉。

## 致谢

- [Sliverkiss/traework2api](https://github.com/Sliverkiss/traework2api) —— 本插件的
  直接移植来源：上游客户端、登录流程、定时任务与常量表都来自它;
- [rockswang/wild-work](https://github.com/rockswang/wild-work) —— 签到语义的参考:
  `checkin_credits` 的业务码含义、以及「成败只看 body code、积分不能当凭据」
  这些判定规则的来源;
- [CARVIN94/dsh-router](https://github.com/CARVIN94/dsh-router) —— 宿主核心:
  供应商契约、账号池策略与面板都来自它,本插件只是按契约实现一个供应商。

## License

MIT
