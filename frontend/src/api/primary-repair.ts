import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 一次管网批量送检修：框选管段一次报送，按敷设方式分组生成检修单，
// 设计压力由检修队实测后回填，回填时管段列表与检修单两处写同一套数。
const SEGMENT_KEY = 'primarynet'
const ORDER_KEY = 'primaryrepair'
const WELL_KEY = 'valvewell'

// 管段状态推进顺序：只能逐级往前走，越级拒收。
const FLOW = ['待投运', '运行中', '检修中', '已废弃']
const REPAIR_STATUS = '检修中'
const REPAIR_ACTION = '登记检修'

export type BlockedRow = { id: number; code: string; missing: string[] }
export type RejectedRow = { id: number; code: string; reason: string }

export type BatchRepairResult = {
  ok: boolean
  message: string
  submitted: { id: number; code: string }[]
  blocked: BlockedRow[]
  rejected: RejectedRow[]
  orders: EntryRow[]
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function nextNumber(rows: EntryRow[], field: string, prefix: string): number {
  let max = 0
  for (const row of rows) {
    const text = String(row[field] ?? '')
    if (text.startsWith(prefix)) {
      const num = Number(text.slice(prefix.length))
      if (Number.isFinite(num) && num > max) {
        max = num
      }
    }
  }
  return max + 1
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function isOpenOrder(order: EntryRow): boolean {
  return String(order.status) !== '已完工'
}

function orderHasSegment(order: EntryRow, code: string): boolean {
  return String(order['管段清单'] ?? '')
    .split('、')
    .filter(Boolean)
    .includes(code)
}

export function listRepairOrders(): EntryRow[] {
  return listRows(ORDER_KEY)
}

/**
 * 批量报送检修：
 * - 起点/终点没填的先拦下挂起，并说明缺在哪一格；
 * - 状态只能 运行中→检修中，越级（如待投运直接送修）拒收；
 * - 已在检修中或已挂在未完工检修单里的，重复报送只落一条；
 * - 通过的按敷设方式分组，每组落一张检修单，并联动阀门井待检查清单。
 */
export function submitSegmentsToRepair(ids: number[]): BatchRepairResult {
  const segments = listRows(SEGMENT_KEY)
  const orders = listRows(ORDER_KEY)
  const wells = listRows(WELL_KEY)

  const uniqueIds = [...new Set(ids.map((id) => Number(id)))]
  const submitted: BatchRepairResult['submitted'] = []
  const blocked: BlockedRow[] = []
  const rejected: RejectedRow[] = []
  const accepted: EntryRow[] = []
  const nextSegments = segments.map((row) => ({ ...row }))

  for (const id of uniqueIds) {
    const row = nextSegments.find((item) => Number(item.id) === id)
    if (!row) {
      rejected.push({ id, code: `#${id}`, reason: '没有找到这条管段' })
      continue
    }
    const code = String(row['管段编号'] ?? `#${id}`)

    // 起点/终点缺失：拦下挂起，说明缺在哪一格
    const missing = ['起点', '终点'].filter((field) => String(row[field] ?? '').trim() === '')
    if (missing.length > 0) {
      row.abnormal = true
      row['挂起原因'] = `缺${missing.join('、')}`
      blocked.push({ id, code, missing })
      continue
    }

    // 状态校验：只允许 运行中→检修中，越级拒收
    const current = String(row.status)
    if (current === REPAIR_STATUS) {
      rejected.push({ id, code, reason: '已在检修中，重复报送只落一条，本次不再落单' })
      continue
    }
    if (FLOW.indexOf(current) !== FLOW.indexOf(REPAIR_STATUS) - 1) {
      rejected.push({
        id,
        code,
        reason: `当前「${current}」，须按 ${FLOW.join('→')} 逐级推进，越级报送已拒收`,
      })
      continue
    }

    // 已挂在未完工检修单里的，重复报送只落一条
    const openOrder = orders.find((order) => isOpenOrder(order) && orderHasSegment(order, code))
    if (openOrder) {
      rejected.push({
        id,
        code,
        reason: `已挂在检修单 ${String(openOrder['检修单号'])}，重复报送只落一条`,
      })
      continue
    }

    accepted.push(row)
    submitted.push({ id, code })
  }

  // 按敷设方式分组，每组落一张检修单
  const groups = new Map<string, EntryRow[]>()
  for (const row of accepted) {
    const laying = String(row['敷设方式'] ?? '').trim() || '未登记敷设方式'
    const group = groups.get(laying) ?? []
    group.push(row)
    groups.set(laying, group)
  }

  const createdOrders: EntryRow[] = []
  const nextOrders = orders.map((order) => ({ ...order }))
  let orderSeq = nextNumber(orders, '检修单号', 'RO-')
  let orderId = nextId(orders)
  for (const [laying, groupRows] of groups) {
    const orderNo = `RO-${String(orderSeq).padStart(4, '0')}`
    orderSeq += 1
    const calibers = [...new Set(groupRows.map((row) => String(row['公称管径'] ?? '')).filter(Boolean))]
    const order: EntryRow = {
      id: orderId,
      status: '待实测',
      pending: true,
      abnormal: false,
      检修单号: orderNo,
      敷设方式: laying,
      管段清单: groupRows.map((row) => String(row['管段编号'])).join('、'),
      管段数量: groupRows.length,
      公称管径: calibers.join('、'),
      设计压力: '',
      报送时间: today(),
    }
    orderId += 1
    createdOrders.push(order)
    nextOrders.push(order)
  }

  // 管段推进到检修中，管段状态列与当前状态保持同一套
  for (const row of accepted) {
    row.status = REPAIR_STATUS
    row['管段状态'] = REPAIR_STATUS
    row.pending = true
    row.abnormal = false
    delete row['挂起原因']
  }

  // 送检结果联动阀门井：所属管段在送检清单里的井回到待检查，没登记的补一条待检查
  const nextWells = wells.map((well) => ({ ...well }))
  let wellSeq = nextNumber(wells, '井编号', 'VALV-')
  let wellId = nextId(wells)
  for (const item of submitted) {
    const well = nextWells.find((item2) => String(item2['所属管段']) === item.code)
    if (well) {
      if (String(well.status) !== '待检查') {
        well.status = '待检查'
        well['井体状态'] = '待检查'
        well.pending = true
      }
      continue
    }
    nextWells.push({
      id: wellId,
      status: '待检查',
      pending: true,
      abnormal: false,
      井编号: `VALV-${String(wellSeq).padStart(4, '0')}`,
      所属管段: item.code,
      井盖状况: '待登记',
      阀门型号: '待登记',
      检查人: '',
      检查日期: '',
      养护措施: '',
      井体状态: '待检查',
    })
    wellSeq += 1
    wellId += 1
  }

  saveRows(SEGMENT_KEY, nextSegments)
  saveRows(ORDER_KEY, nextOrders)
  saveRows(WELL_KEY, nextWells)

  const parts = [
    `已报送 ${submitted.length} 条，按敷设方式分 ${createdOrders.length} 组落检修单`,
    blocked.length > 0 ? `挂起 ${blocked.length} 条（起点/终点未填）` : '',
    rejected.length > 0 ? `拒收 ${rejected.length} 条` : '',
  ].filter(Boolean)
  return {
    ok: true,
    message: parts.join('；'),
    submitted,
    blocked,
    rejected,
    orders: createdOrders,
  }
}

/**
 * 检修队实测后回填设计压力：检修单与管段列表两处写同一套数，
 * 口径沿用既有管段的公称管径核定，不重新登记。
 */
export function backfillDesignPressure(orderId: number, raw: string): ActionResult {
  const orders = listRows(ORDER_KEY)
  const order = orders.find((item) => Number(item.id) === orderId)
  if (!order) {
    return { ok: false, message: `没有找到编号为 ${orderId} 的检修单` }
  }
  if (String(order['设计压力'] ?? '').trim() !== '') {
    return {
      ok: false,
      message: `检修单 ${String(order['检修单号'])} 已回填设计压力 ${String(order['设计压力'])}，不重复填写`,
    }
  }
  const value = Number(String(raw).trim().replace(/mpa/i, ''))
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: '设计压力需为大于 0 的数字（单位 MPa），由检修队实测后回填' }
  }
  const text = `${value}MPa`

  const nextOrders = orders.map((item) =>
    Number(item.id) === orderId
      ? { ...item, 设计压力: text, status: REPAIR_STATUS, pending: true }
      : { ...item },
  )
  saveRows(ORDER_KEY, nextOrders)

  const codes = String(order['管段清单'] ?? '').split('、').filter(Boolean)
  const segments = listRows(SEGMENT_KEY)
  let synced = 0
  const nextSegments = segments.map((row) => {
    if (codes.includes(String(row['管段编号'] ?? ''))) {
      synced += 1
      return { ...row, 设计压力: text }
    }
    return { ...row }
  })
  saveRows(SEGMENT_KEY, nextSegments)

  return {
    ok: true,
    message: `检修单 ${String(order['检修单号'])} 按既有口径 ${String(order['公称管径'])} 核定，设计压力 ${text} 已同步管段列表 ${synced} 条`,
  }
}
