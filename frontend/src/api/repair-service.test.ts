import { beforeEach, describe, expect, it } from 'vitest'

import {
  REPAIR_KEY,
  SEGMENT_KEY,
  VALVEWELL_KEY,
  backfillDesignPressure,
  groupRepairOrders,
  missingEndpointFields,
  submitRepairBatch,
  supplementEndpoints,
} from '@/api/repair-service'
import { listRows, resetRows } from '@/data/local-store'

const NOW = new Date('2026-10-03T10:30:00')

function segmentByCode(code: string) {
  const row = listRows(SEGMENT_KEY).find((item) => item['管段编号'] === code)
  if (!row) {
    throw new Error(`测试数据里找不到管段 ${code}`)
  }
  return row
}

beforeEach(() => {
  resetRows(SEGMENT_KEY)
  resetRows(REPAIR_KEY)
  resetRows(VALVEWELL_KEY)
})

describe('批量报送检修', () => {
  it('框选多条运行中管段一次报送，按敷设方式分组落检修单', () => {
    const result = submitRepairBatch([1, 2, 4], NOW)

    expect(result.created).toHaveLength(3)
    expect(result.batchNo).toBe('PC-20261003-1')
    expect(result.created.map((row) => row['检修单号'])).toEqual([
      'JX-20261003-001',
      'JX-20261003-002',
      'JX-20261003-003',
    ])

    const ways = result.groups.map((group) => [group.敷设方式, group.orders.length])
    expect(ways).toEqual([
      ['直埋敷设', 2],
      ['管沟敷设', 1],
    ])

    // 检修单沿用既有管段口径核定，起终点不用手抄
    const first = result.created[0]
    expect(first['管段编号']).toBe('PRIM-0001')
    expect(first['起点']).toBe('热源厂出口')
    expect(first['终点']).toBe('解放路阀门井')
    expect(first['公称管径']).toBe('DN500')
    expect(first.status).toBe('待实测')

    // 管段推进到检修中
    for (const code of ['PRIM-0001', 'PRIM-0002', 'PRIM-0004']) {
      expect(segmentByCode(code).status).toBe('检修中')
    }
  })

  it('起点或终点没填的管段被拦下挂起，并说明缺在哪一格', () => {
    const result = submitRepairBatch([5, 6], NOW)

    expect(result.created).toHaveLength(0)
    expect(result.suspended).toEqual([
      { id: 5, 管段编号: 'PRIM-0005', missing: ['起点'] },
      { id: 6, 管段编号: 'PRIM-0006', missing: ['终点'] },
    ])
    expect(segmentByCode('PRIM-0005')['挂起原因']).toBe('缺少起点')
    expect(segmentByCode('PRIM-0006')['挂起原因']).toBe('缺少终点')
    // 挂起的管段状态不动，也不落检修单
    expect(segmentByCode('PRIM-0005').status).toBe('运行中')
    expect(listRows(REPAIR_KEY)).toHaveLength(1)
  })

  it('待投运管段越级送检修被拒收', () => {
    const result = submitRepairBatch([7], NOW)

    expect(result.created).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain('越级')
    expect(segmentByCode('PRIM-0007').status).toBe('待投运')
  })

  it('重复提交送检修只落一条', () => {
    // PRIM-0003 已有检修单 JX-20260920-001，再报送不重复落单
    const again = submitRepairBatch([3], NOW)
    expect(again.created).toHaveLength(0)
    expect(again.skipped[0].reason).toContain('重复报送')
    expect(listRows(REPAIR_KEY)).toHaveLength(1)

    // 同一批管段提交两次，第二次全部不再落单
    const first = submitRepairBatch([1, 2], NOW)
    expect(first.created).toHaveLength(2)
    const second = submitRepairBatch([1, 2], NOW)
    expect(second.created).toHaveLength(0)
    expect(second.skipped).toHaveLength(2)
    expect(listRows(REPAIR_KEY)).toHaveLength(3)
  })

  it('送检结果反映到阀门井待检查清单', () => {
    submitRepairBatch([1, 2], NOW)

    const wells = listRows(VALVEWELL_KEY)
    const byCode = (code: string) => wells.find((row) => row['井编号'] === code)
    // PRIM-0001 上的两口井都回到待检查
    expect(byCode('VALV-0001')?.status).toBe('待检查')
    expect(byCode('VALV-0004')?.status).toBe('待检查')
    // PRIM-0002 上的井也回到待检查
    expect(byCode('VALV-0002')?.status).toBe('待检查')
    // 不在本次送检范围内的井不受影响
    expect(byCode('VALV-0003')?.status).toBe('待检查')
  })
})

describe('设计压力回填', () => {
  it('回填后检修单与管段列表是同一套值', () => {
    const result = backfillDesignPressure(1, '1.4')

    expect(result.ok).toBe(true)
    const order = listRows(REPAIR_KEY).find((row) => Number(row.id) === 1)
    expect(order?.['设计压力']).toBe('1.4MPa')
    expect(order?.status).toBe('已回填')
    expect(segmentByCode('PRIM-0003')['设计压力']).toBe('1.4MPa')
  })

  it('非数值压力被拒收，两处数据都不动', () => {
    const result = backfillDesignPressure(1, 'abc')

    expect(result.ok).toBe(false)
    const order = listRows(REPAIR_KEY).find((row) => Number(row.id) === 1)
    expect(order?.['设计压力']).toBe('')
    expect(order?.status).toBe('待实测')
  })

  it('已回填的检修单不能重复回填', () => {
    expect(backfillDesignPressure(1, '1.4MPa').ok).toBe(true)
    const again = backfillDesignPressure(1, '1.5MPa')
    expect(again.ok).toBe(false)
    expect(again.message).toContain('勿重复提交')
  })
})

describe('挂起管段补录起终点', () => {
  it('补齐后解除挂起，可重新报送检修', () => {
    submitRepairBatch([5], NOW)
    expect(segmentByCode('PRIM-0005')['挂起原因']).toBe('缺少起点')

    const result = supplementEndpoints(5, { 起点: '纺织路架空段起点' })
    expect(result.ok).toBe(true)
    expect(segmentByCode('PRIM-0005')['挂起原因']).toBeUndefined()

    const retry = submitRepairBatch([5], NOW)
    expect(retry.created).toHaveLength(1)
    expect(retry.created[0]['起点']).toBe('纺织路架空段起点')
  })

  it('没补齐的格继续挂起并说明缺哪格', () => {
    submitRepairBatch([6], NOW)
    const result = supplementEndpoints(6, { 起点: '随便填一个不改终点' })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('终点')
    expect(segmentByCode('PRIM-0006')['挂起原因']).toBe('缺少终点')
  })
})

describe('辅助函数', () => {
  it('missingEndpointFields 逐格报告缺口', () => {
    expect(missingEndpointFields(segmentByCode('PRIM-0001'))).toEqual([])
    expect(missingEndpointFields(segmentByCode('PRIM-0005'))).toEqual(['起点'])
    expect(missingEndpointFields(segmentByCode('PRIM-0006'))).toEqual(['终点'])
  })

  it('groupRepairOrders 按敷设方式分组，空方式归入未登记', () => {
    const groups = groupRepairOrders([
      { id: 1, status: '待实测', pending: true, abnormal: false, 敷设方式: '直埋敷设' },
      { id: 2, status: '待实测', pending: true, abnormal: false, 敷设方式: '' },
    ])
    expect(groups.map((group) => group.敷设方式)).toEqual(['直埋敷设', '未登记敷设方式'])
  })
})
