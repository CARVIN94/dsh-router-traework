<h1 align="center">dsh-router-traework</h1>

<p align="center">dsh-router 的 TRAE SOLO 供应商插件</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-router-traework"><img src="https://img.shields.io/npm/v/dsh-router-traework?style=flat-square&logo=npm&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本：0.2.0+" src="https://img.shields.io/badge/DSH-0.2.0%2B-4d6bfe" /></a>
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

需要 **DSH `0.2.0` 及以上**（核心已单面 0.2.0，0.1.x 宿主不再支持）。先装核心，再装本插件，然后**重启 `dsh web`**：

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
- 积分只报**值**，不落盘（持久化归核心 `supplier-config.json`）：启动时用核心
  缓存预热，拿不到时报 `-1`（不是 0），核心保留上次持久化的值

**本插件不做自动调度**：不挂后台定时器。签到是核心在用户点「签到」时逐个
链接触发的（`POST /suppliers/:id/checkin` → `checkinNow(uid)`）。曾移植自
traework2api 的每日自动签到 `Scheduler` 已删除（核心没有定时入口，放着是死代码）。

**token 刷新是共享前置**：所有打上游的路（`chatOnce` / 获取模型 / 拉积分 /
签到）都先过一个 `freshAuth`，临到期或已过期就刷一次并落盘。闲置账号的
accessToken 早就过期了（实测本机三个号全是），哪条路少这一步，那条路就会
静默失效——「获取模型点了没反应」「积分一直是未知」「一直没用过的号签到必
失败」都是这么来的。同一账号的并发刷新会去重：refreshToken 是**轮换**的，
两个并发刷新互相覆盖可能写坏轮换链。

完整契约见 [dsh-router 的 `docs/suppliers.md`](https://github.com/CARVIN94/dsh-router/blob/main/docs/suppliers.md)。

## 获取模型

模型名录取自上游两处，**合并后是纯增量**（不会从用户手里拿走今天还能用的模型）：

1. **远端名录**（`solo.trae.cn/api/remote/v1/models`，按 function 分组）——
   厂商给 Trae IDE 模型选择器看的那一份，作为骨架与展示名/窗口来源
2. **详细表**（`get_detail_param`，逐 function 查询）——给出每个 config_name
   **归属于哪个 function**、以及 `max_tokens`

要点：

- **归属 function 必须回放**：上游把可调用名录按 function 拆开，一个模型只有用
  **列出它的那个 function** 才调得动。发错时上游 **HTTP 200 但流内 `code=4001`**
  （「参数无效」），看起来像请求写错了。2026-10-10 实测：只发 `solo_work_lite`
  时 `glm-5.1` / `qwen-3.5` / `kimi-k2.5` / `minimax-m2.7` / `qwen-3.6-plus` /
  `glm-5v-turbo` / `Doubao-Seed-Code` 全部 4001，换成各自归属的 function 后
  全部正常应答。插件把「模型 → function」记下来，chat 时回放（见
  `DirectoryFunctions` 的顺序即归属优先级）
- **`context_length` 必须下标**，单位是 **K**（核心 `comboContextWindow` 会换算回
  token）。以前 `fetchModels` 恒填 `contextWindow: 0`，于是核心那条
  `if (m.contextWindow > 0)` 永不成立 → 窗口永远拿不到 → 自动压缩一直跳过。
  现在 32+ 个模型都带上真实窗口（`context_window_tokens.dev`）
- 远端名录拿不到时，退回**主 function 一家的表**（改动前的历史行为），不是把
  详细表并集原样端出去——并集里有一半是其它 function 独有的内部件
  （`title_generation` / `fast_apply` / `*‑auto` 变体…）

### 模型覆盖与已知边界

- **签到判定**（见下）与 chat 是两套上游身份，模型表只服务 chat
- 详细表里**不在**远端名录、也不在主 function 表里的行 **不发布**：实测
  `computer_use_subagent` / `file_search_agent` 直接回 `code=3003`（不是对话模型）。
  但 `explore_sub_agent_v2` / `summary` / `glm-5-turbo` / `aquila` / `sagitta` /
  `seed-code-pro-0430` 实测都能正常出内容，故一并保留——**宁多留一个，不误杀可用模型**
- 天花板与升级路径：若将来要严格对齐 IDE 名录（只发远端那 32 个），删掉
  `fetchModels` 里「并上主 function 那一家」的那一段即可，一行级改动
- 远端名录的窗口在同一模型多组间可能不一致，取**最大**值，避免面板窗口随上游
  分组顺序变化

## 签到判定

上游 `checkin_credits/*` **一律返回 HTTP 200**，成败只藏在 body 的 `code` 里：

| code   | 含义                     | 处理                                                       |
| ------ | ------------------------ | ---------------------------------------------------------- |
| `0`    | 成功                     | ok（**注意**：已签到后重复调用也返回 0，是幂等、不加积分） |
| `9095` | **该设备**今日已参与签到 | 见下——**不是**幂等成功（本机名额被别的账号用掉时，当前账号拿到它却一分没领到） |
| `9074` | 「当前参与用户太多」     | **账号级稳定拒绝**，不是抖动——只重试一次（等 1s）就判失败  |
| `1001` | token/会话失效           | session_dead（与 chat 401 同义）                           |

据此定下的判定规则：

- **不能只看 HTTP 状态**（一律 200，会误报成功）
- **不能只看 `code 0` 就以为签上了** —— claim 后要**回查
  `checkin_credits/status` 的 `checked_in`** 才算数
- **不能拿积分当签到凭据** —— `ide_user_ent_usage` 是所有包的聚合剩余额度，
  签到前后可能是同一个数
- **签到前先刷 token**：闲置账号的 accessToken 早已过期，不刷必然拿 1001
  认证失败（chat 那条路一直有刷，签到以前没有——「一直没用过的号点签到」
  就是这么失败的）

关于 `9095`（**证据分级，别当成已实测**）：上游 `ug` 族的 NLS 文案是
「该设备今日已参与签到」，口径指向**设备**；本插件的处理是防御式的——
**不论 claim 回什么 code，都以回查 `checked_in` 为唯一凭据**：

- 回查到 `checked_in=true` → 成功（`code 0` 那次是本次领到的，否则是本来就有的幂等）
- 回查 `false` 且 claim 回 `9095` → 报独立的 `device_used` 并说明原因，
  **不报 already**（把「没领到」说成「已领到」是这里唯一不能犯的错）
- 其余 → 通用 error

本机实测到的是：已领账号（`checked_in=true`）再 claim 一律回 `code 0`、与
deviceId 无关（账号级幂等先行），所以 `9095` 那条分支**本机没能复现**——
它只在「账号未领 + 设备名额已用」时出现，而本机三个账号当天都领过了。
代码按上面的防御式处理，不改判定凭据（始终是 `checked_in`）。

### `checked_in` 与 `did_checked_in` 是两个维度

这两个字段常被当成一回事，判定维度其实不同（2026-10-10 实测复核）：

| 字段             | 判定维度                       | 含义                                               |
| ---------------- | ------------------------------ | -------------------------------------------------- |
| `checked_in`     | **账号**                       | 该账号今天的签到奖励包已到账。换 deviceId 读数不变  |
| `did_checked_in` | **设备**（`x-device-id` 的值） | 这台机器今天的名额已用，**不区分是哪个账号用的**   |

实测：同一账号带本机真实设备号读是 `did_checked_in=true`、带另一个号读是
`false`；重复读不会自己变 `true`（只有真 claim 才置位）；而 `checked_in` 只随
账号变。

于是有 `!checkedIn && didCheckedIn` 这一态：本机名额已被用掉（可能是另一个账号
领的），**而这个账号一分没领到**。这时 claim 只会被 9095 拒，插件如实报
`device_used`，不谎报成功。

（曾把 `checked_in` 记成「当前登录态设备的读数、换 deviceId 会短暂变 false」——
那是 `did_checked_in` 的行为，记反了。）

### 剩余积分的计算

`ide_user_ent_usage` 返回 `user_entitlement_pack_list`，剩余 = Σ(`credits_limit`

- `credits_amount`)。实测要点：

- **请求体必须是 `{"require_usage":true,"req_source":2}`**，发 `{}` 拿不到完整 usage
- **过期包必须跳过**：签到积分是当日发放、**31 天后过期**的独立包
  （`entitlement_id` 形如 `checkin_20260902_<uid>`，每个 200 额度）。不滤掉
  就是把历史所有签到包累加进「剩余」，面板越签越多、永远用不完
- 请求头与 chat 链路**不是同一套身份**：签到/积分走 VSCode 插件进程
  （UA `VSCode 1.107.1 (TRAE SOLO CN)`），chat 走 IDE 主进程
- `x-device-id` 必须是 **16 位纯数字**（真实客户端实测值如 `1711320556112436`），
  发 hex32 / UUID 在风控眼里不是设备号

### 9074 的真相（账号级稳定拒绝，不是抖动）

9074 **不是短时抖动，是账号级稳定拒绝**。诊断实验（直连上游）：

- 同一账号 40 余次请求（间隔 0~15s 递增）**全部 9074**，一次没过
- 刷新 token、换全新 deviceId、换 UA/region/请求体 **均无效**
- 决定性对照：把失败账号的 deviceId 借给成功账号 → 成功账号照样 `code 0`；
  把成功账号的 deviceId 借给失败账号 → 失败账号仍 9074
  —— **失败跟着账号走，不跟着设备走**

所以保留的 1s 重试只是兜「上游万一恢复成真抖动」，落空即判失败、不空耗 8s。
从 `ide_user_ent_usage` 的「签到奖励」包看，被拒账号会整段缺签（可能连续多天没
签上）——这是上游对账号的发放策略，客户端绕不过，只能如实报失败，别谎报成功。

## 架构

通过 cordis service `router.suppliers` 向 dsh-router 注册 `traework` 供应商工厂。

```
src/
  index.ts       插件入口（提供 router.suppliers service）
  contract.ts    供应商契约
  types.ts       类型定义
  api/           供应商实现（上游客户端、账号凭证池、登录、签到能力等）
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
  直接移植来源：上游客户端、登录流程与常量表都来自它（其内置的每日自动签到
  `Scheduler` 因本插件不做自动调度已删除）;
- [rockswang/wild-work](https://github.com/rockswang/wild-work) —— 签到语义的参考:
  `checkin_credits` 的业务码含义、以及「成败只看 body code、积分不能当凭据」
  这些判定规则的来源;
- [star620/TRAE-Automatic-sign-in](https://github.com/star620/TRAE-Automatic-sign-in) ——
  TRAE 每日自动签到助手的参考。

## 许可证

[MIT](LICENSE)

## 免责声明

本项目仅用于学习与技术研究，请勿用于商业用途。
