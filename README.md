<h1 align="center">dsh-router-traework</h1>

<p align="center">dsh-router 的 TRAE SOLO 供应商插件</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-router-traework"><img src="https://img.shields.io/npm/v/dsh-router-traework?style=flat-square&logo=npm&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#快速安装">快速安装</a> ·
  <a href="#签到判定">签到判定</a> ·
  <a href="https://github.com/CARVIN94/dsh-router#readme">dsh-router 核心</a>
</p>

为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 `traework` 供应商（免费 SOLO 聊天通道）。
单独装它没用——它只是向核心注册一个供应商，面板、账号池、组合回退都在核心里。

本项目是 [traework2api](https://github.com/Sliverkiss/traework2api) 的 DSH 插件版,
上游协议与签到语义参考 [wild-work](https://github.com/rockswang/wild-work)。

## 快速安装

先装核心，再装本插件，然后**重启 `dsh web`**：

```bash
dsh plugin --profile web add dsh-router-core
dsh plugin --profile web add dsh-router-traework
```

`dsh plugin add` 会在 profile 里 `pnpm add`，并自动把声明了 `dsh.bundle.patch`
的包加入 `dsh.profile.bundles`（本插件即声明了，即 `cordis.patch.yml`）。

重启后本插件以 cordis service `router.suppliers` 向 dsh-router 注册 `traework`
供应商，面板「供应商」出现 traework 卡片，加账号即用。

> 本地开发版：不用 npm，直接 `dependencies` 加
> `"dsh-router-traework": "link:/path/to/dsh-router-traework"` 指向本地仓库。

## 与核心的分工

本插件只管**对单个账号调通上游**：SOLO 协议、token 刷新、SSE 转换、签到、积分。

**策略全在核心**（`AccountPool`）：选号、冷却、禁用、连续错误累计、遍历回退、
响应写入。所以：

- `chatOnce(uid, req)` 一次只服务一个账号，**不遍历账号、不维护冷却表、不写响应**
- 失败时返回语义状态（`rate_limit` / `quota` / `session_dead` / `unavailable` /
  `transport` / `unknown`），由核心决定冷却多久、是否禁用、要不要换号
- `status()` 只报「现在状态」（凭证 + 积分），冷却/禁用由核心叠加后给面板

完整契约见 [dsh-router 的 `docs/suppliers.md`](https://github.com/CARVIN94/dsh-router/blob/main/docs/suppliers.md)。

## 签到判定

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

## 架构

通过 cordis service `router.suppliers` 向 dsh-router 注册 `traework` 供应商工厂。

```
src/
  index.ts       插件入口（提供 router.suppliers service）
  contract.ts    供应商契约
  types.ts       类型定义
  api/           供应商实现（上游客户端、账号凭证池、调度器、登录等）
```

## 开发

```bash
pnpm install
pnpm build        # lib/index.js
pnpm typecheck
pnpm test         # node --test "src/**/*.test.ts"
```

## 致谢

- [Sliverkiss/traework2api](https://github.com/Sliverkiss/traework2api) —— 本插件的
  直接移植来源：上游客户端、登录流程、定时任务与常量表都来自它;
- [rockswang/wild-work](https://github.com/rockswang/wild-work) —— 签到语义的参考:
  `checkin_credits` 的业务码含义、以及「成败只看 body code、积分不能当凭据」
  这些判定规则的来源。

## 许可证

[MIT](LICENSE)
