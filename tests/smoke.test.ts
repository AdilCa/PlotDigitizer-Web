import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// M0-2 验收：C++ 项目样例图作为固定测试夹具可被 vitest 读取
const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))

describe('test fixtures', () => {
  it('fixtures 目录存在且包含样例图', () => {
    const files = readdirSync(fixturesDir)
    expect(files).toContain('test1.png')
    expect(files).toContain('test2.png')
  })

  it.each(['test1.png', 'test2.png'])('%s 非空可读', (name) => {
    const stat = statSync(new URL(`./fixtures/${name}`, import.meta.url))
    expect(stat.size).toBeGreaterThan(0)
  })
})
