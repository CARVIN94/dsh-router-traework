# dsh-router-traework

DSH 插件：为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 `traework` 供应商（免费 SOLO 聊天通道）。

本项目是 [traework2api](https://github.com/Sliverkiss/traework2api) 的 DSH 插件版，上游参考 [dsh-router](https://github.com/CARVIN94/dsh-router)。

## 安装(DSH)

先装核心 [dsh-router-core](https://github.com/CARVIN94/dsh-router)(dsh-router 仓库,提供面板 + 内置供应商),再装本插件:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-router-core
pnpm add dsh-router-traework
```

装完确认 `~/.dsh/profiles/web/package.json`:
- `dependencies` 含 `dsh-router-core` 和 `dsh-router-traework`(npm 版本号);
- `dsh.profile.bundles` 含 `dsh-router` 和 `dsh-router-traework`——
  插件的 `cordis.patch.yml` 会自动插入 bundle,一般无需手改。

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
  api/           供应商实现（上游客户端、账号池、调度器、登录等）
```

## License

MIT
