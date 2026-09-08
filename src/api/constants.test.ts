/**
 * 配置路径测试 —— 锁死「落盘位置不跟 cwd 跑」这个 bug。
 *
 * 以前 `stateFile` 默认写死相对路径 `data/state.json`，落盘位置跟着进程 cwd
 * 跑：从别的目录启动 `dsh web` 就静默换一套空数据，用户看到「配置丢了」。
 * 现在必须来自核心注入的绝对 `dataDir`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from './constants.ts'

test('有 dataDir → stateFile/authDir 钉在该目录下（绝对路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-data-'))
  const cfg = defaultConfig(dir)
  assert.equal(cfg.stateFile, join(dir, 'state.json'))
  assert.equal(cfg.authDir, join(dir, 'auths'))
})

test('无 dataDir → 退回相对路径（老核心/独立运行时的兼容分支）', () => {
  const cfg = defaultConfig()
  assert.equal(cfg.stateFile, 'data/state.json')
  assert.equal(cfg.authDir, 'auths')
})
