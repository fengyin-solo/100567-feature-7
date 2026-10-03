import { beforeEach, describe, expect, it } from 'vitest'

import { runAction } from '@/api/local-service'
import { listRows, resetRows } from '@/data/local-store'

const KEY = 'primarynet'

function statusOf(id: number): string {
  const row = listRows(KEY).find((item) => Number(item.id) === id)
  return String(row?.status)
}

beforeEach(() => {
  resetRows(KEY)
})

describe('状态逐级推进', () => {
  it('按待投运→运行中→检修中→已废弃逐级推进', () => {
    expect(runAction(KEY, 7, '提交投运').ok).toBe(true)
    expect(statusOf(7)).toBe('运行中')
    expect(runAction(KEY, 7, '登记检修').ok).toBe(true)
    expect(statusOf(7)).toBe('检修中')
    expect(runAction(KEY, 7, '报废管段').ok).toBe(true)
    expect(statusOf(7)).toBe('已废弃')
  })

  it('越级报送一律拒收', () => {
    // 待投运 → 检修中：越级
    const jump = runAction(KEY, 7, '登记检修')
    expect(jump.ok).toBe(false)
    expect(jump.message).toContain('越级')
    expect(statusOf(7)).toBe('待投运')

    // 待投运 → 已废弃：越级
    expect(runAction(KEY, 7, '报废管段').ok).toBe(false)

    // 运行中 → 已废弃：越级
    expect(runAction(KEY, 1, '报废管段').ok).toBe(false)
    expect(statusOf(1)).toBe('运行中')
  })

  it('倒退走也拒收', () => {
    const back = runAction(KEY, 3, '提交投运')
    expect(back.ok).toBe(false)
    expect(statusOf(3)).toBe('检修中')
  })

  it('已到目标状态不重复操作', () => {
    const same = runAction(KEY, 1, '登记检修')
    // PRIM-0001 是运行中，登记检修是合法逐级推进
    expect(same.ok).toBe(true)
    const again = runAction(KEY, 1, '登记检修')
    expect(again.ok).toBe(false)
    expect(again.message).toContain('不用重复操作')
  })
})
