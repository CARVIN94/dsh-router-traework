# dsh-router-traework

DSH 插件：为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 `traework` 供应商（免费 SOLO 聊天通道）。

本项目是 [traework2api](https://github.com/Sliverkiss/traework2api) 的 DSH 插件版，上游参考 [dsh-router](https://github.com/CARVIN94/dsh-router)。

## 安装

```bash
npm install dsh-router-traework
# 或
pnpm add dsh-router-traework
```

确保 [dsh-router](https://github.com/CARVIN94/dsh-router) 已安装。本插件通过 `cordis.patch.yml` 自动挂载到 DSH bundle stack，并以 cordis service `router.suppliers` 向 dsh-router 注册 `traework` 供应商工厂。

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
