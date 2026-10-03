import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 一次管网批量送检修：框选管段一次报送，按敷设方式分组落检修单，
// 缺起点/终点的管段拦下挂起，设计压力由检修队实测后回填并同步回管段列表。
export const SEGMENT_KEY = 'primarynet'
export const REPAIR_KEY = 'primaryrepair'
export const VALVEWELL_KEY = 'valvewell'

export const REPAIR_PENDING = '待实测'
export const REPAIR_FILLED = '已回填'

const ENDPOINT_FIELDS = ['起点', '终点'] as const

export type SuspendedSegment = {
  id: number
  管段编号: string
  missing: string[]
}

export type SkippedSegment = {
  id: number
  管段编号: string
  reason: string
}

export type RepairGroup = {
  敷设方式: string
  orders: EntryRow[]
}

export type BatchRepairResult = {
  ok: boolean
  message: string
  batchNo: string
  created: EntryRow[]
  groups: RepairGroup[]
  suspended: SuspendedSegment[]
  skipped: SkippedSegment[]
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** 管段缺哪几格（起点/终点），都填了返回空数组。 */
export function missingEndpointFields(row: EntryRow): string[] {
  return ENDPOINT_FIELDS.filter((field) => text(row[field]) === '')
}

function pad(num: number, width: number): string {
  return String(num).padStart(width, '0')
}

function datePart(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`
}

function timePart(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)} ${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}`
}

/** 检修单号递增：扫现有单号里同一日期的最大序号，下一张接着排。 */
function nextRepairSeq(repairs: EntryRow[], day: string): number {
  let max = 0
  for (const row of repairs) {
    const match = /^JX-(\d{8})-(\d+)$/.exec(text(row['检修单号']))
    if (match && match[1] === day) {
      max = Math.max(max, Number(match[2]))
    }
  }
  return max + 1
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function groupRepairOrders(orders: EntryRow[]): RepairGroup[] {
  const groups = new Map<string, EntryRow[]>()
  for (const order of orders) {
    const way = text(order['敷设方式']) || '未登记敷设方式'
    const bucket = groups.get(way) ?? []
    bucket.push(order)
    groups.set(way, bucket)
  }
  return [...groups.entries()].map(([敷设方式, ordersInGroup]) => ({
    敷设方式,
    orders: ordersInGroup,
  }))
}

/**
 * 批量报送检修：
 * - 起点/终点空着的管段拦下挂起，逐格说明缺在哪；
 * - 已有检修单或已在检修中的管段不重复落单；
 * - 其余状态（待投运等）越级报送一律拒收；
 * - 通过的管段按敷设方式分组生成检修单，管段推进到「检修中」，
 *   关联阀门井回到「待检查」清单。
 */
export function submitRepairBatch(ids: number[], now: Date = new Date()): BatchRepairResult {
  const segments = listRows(SEGMENT_KEY)
  const repairs = listRows(REPAIR_KEY)
  const wells = listRows(VALVEWELL_KEY)

  const day = datePart(now)
  const batchSeq =
    new Set(
      repairs.map((row) => text(row['批次号'])).filter((no) => no.startsWith(`PC-${day}-`)),
    ).size + 1
  const batchNo = `PC-${day}-${batchSeq}`

  const suspended: SuspendedSegment[] = []
  const skipped: SkippedSegment[] = []
  const eligible: EntryRow[] = []
  const repairedCodes = new Set(repairs.map((row) => text(row['管段编号'])))

  const nextSegments = [...segments]

  for (const id of [...new Set(ids)]) {
    const index = nextSegments.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      skipped.push({ id, 管段编号: `#${id}`, reason: '没有找到这条管段' })
      continue
    }
    const row = nextSegments[index]
    const code = text(row['管段编号']) || `#${id}`

    const missing = missingEndpointFields(row)
    if (missing.length > 0) {
      const reason = `缺少${missing.join('、')}`
      nextSegments[index] = { ...row, 挂起原因: reason }
      suspended.push({ id, 管段编号: code, missing })
      continue
    }
    if (repairedCodes.has(code)) {
      const existing = repairs.find((item) => text(item['管段编号']) === code)
      skipped.push({
        id,
        管段编号: code,
        reason: `已存在检修单 ${text(existing?.['检修单号'])}，重复报送不再落单`,
      })
      continue
    }
    const status = text(row.status)
    if (status === '检修中') {
      skipped.push({ id, 管段编号: code, reason: '管段已在检修中，重复报送不再落单' })
      continue
    }
    if (status !== '运行中') {
      skipped.push({
        id,
        管段编号: code,
        reason: `当前状态「${status}」不能越级送检修，须先推进到「运行中」`,
      })
      continue
    }
    eligible.push(row)
  }

  const created: EntryRow[] = []
  let seq = nextRepairSeq(repairs, day)
  let repairId = nextId(repairs)
  const eligibleIds = new Set(eligible.map((row) => Number(row.id)))
  const eligibleCodes = new Set(eligible.map((row) => text(row['管段编号'])))

  for (const row of eligible) {
    created.push({
      id: repairId++,
      status: REPAIR_PENDING,
      pending: true,
      abnormal: false,
      检修单号: `JX-${day}-${pad(seq++, 3)}`,
      批次号: batchNo,
      管段编号: text(row['管段编号']),
      起点: text(row['起点']),
      终点: text(row['终点']),
      公称管径: text(row['公称管径']),
      敷设方式: text(row['敷设方式']),
      设计压力: text(row['设计压力']),
      检修队: '待指派',
      报送时间: timePart(now),
    })
  }

  const finalSegments = nextSegments.map((row) =>
    eligibleIds.has(Number(row.id))
      ? { ...row, status: '检修中', pending: true, 管段状态: '检修中' }
      : row,
  )
  const finalWells = wells.map((row) =>
    eligibleCodes.has(text(row['所属管段'])) && text(row.status) !== '待检查'
      ? { ...row, status: '待检查', pending: true }
      : row,
  )

  saveRows(SEGMENT_KEY, finalSegments)
  saveRows(REPAIR_KEY, [...repairs, ...created])
  saveRows(VALVEWELL_KEY, finalWells)

  const groups = groupRepairOrders(created)
  const parts = [`新建检修单 ${created.length} 张（批次 ${batchNo}）`]
  if (suspended.length > 0) {
    parts.push(`挂起 ${suspended.length} 条`)
  }
  if (skipped.length > 0) {
    parts.push(`未受理 ${skipped.length} 条`)
  }
  return {
    ok: true,
    message: parts.join('，'),
    batchNo,
    created,
    groups,
    suspended,
    skipped,
  }
}

/** 检修队实测后回填设计压力：检修单与管段列表两处写同一套值。 */
export function backfillDesignPressure(repairId: number, raw: string): ActionResult {
  const repairs = listRows(REPAIR_KEY)
  const index = repairs.findIndex((row) => Number(row.id) === repairId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${repairId} 的检修单` }
  }
  const order = repairs[index]
  if (text(order.status) === REPAIR_FILLED) {
    return { ok: false, message: `检修单 ${text(order['检修单号'])} 已回填过，勿重复提交` }
  }
  const value = text(raw)
  const match = /^(\d+(?:\.\d+)?)\s*(MPa)?$/i.exec(value)
  if (!match) {
    return { ok: false, message: '设计压力需为数值（可带 MPa 单位），例如 1.6 或 1.6MPa' }
  }
  const normalized = `${match[1]}MPa`

  const nextRepairs = [...repairs]
  nextRepairs[index] = { ...order, 设计压力: normalized, status: REPAIR_FILLED, pending: false }
  saveRows(REPAIR_KEY, nextRepairs)

  const code = text(order['管段编号'])
  const segments = listRows(SEGMENT_KEY)
  saveRows(
    SEGMENT_KEY,
    segments.map((row) =>
      text(row['管段编号']) === code ? { ...row, 设计压力: normalized } : row,
    ),
  )
  return {
    ok: true,
    message: `检修单 ${text(order['检修单号'])} 设计压力已回填为 ${normalized}，管段列表同步更新`,
  }
}

/** 给挂起的管段补录起点/终点，补齐后解除挂起。 */
export function supplementEndpoints(
  segmentId: number,
  patch: { 起点?: string; 终点?: string },
): ActionResult {
  const segments = listRows(SEGMENT_KEY)
  const index = segments.findIndex((row) => Number(row.id) === segmentId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${segmentId} 的一次管网管段` }
  }
  const row = segments[index]
  const updated: EntryRow = { ...row }
  for (const field of ENDPOINT_FIELDS) {
    const value = text(patch[field])
    if (value !== '') {
      updated[field] = value
    }
  }
  const missing = missingEndpointFields(updated)
  if (missing.length === 0) {
    delete updated['挂起原因']
  } else {
    updated['挂起原因'] = `缺少${missing.join('、')}`
  }
  const next = [...segments]
  next[index] = updated
  saveRows(SEGMENT_KEY, next)
  const code = text(row['管段编号'])
  return missing.length === 0
    ? { ok: true, message: `管段 ${code} 起点终点已补齐，挂起解除，可重新报送检修` }
    : { ok: false, message: `管段 ${code} 仍缺少${missing.join('、')}，继续挂起` }
}
