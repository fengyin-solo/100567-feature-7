<template>
  <section class="page" data-module="primarynet">
    <header class="page-head">
      <div>
        <h2>一次管网管理</h2>
        <p class="page-desc">维护一次管网管段，围绕管段编号、起点、终点、公称管径做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记一次管网管段</button>
        <button class="btn" type="button" @click="exportRows">导出一次管网清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <span>已框选 {{ selectedIds.length }} 条管段</span>
      <button
        class="btn primary"
        type="button"
        :disabled="!selectedIds.length"
        @click="submitBatch"
      >
        批量报送检修
      </button>
      <button class="btn ghost" type="button" :disabled="!selectedIds.length" @click="clearSelection">
        清空选择
      </button>
      <span class="batch-hint">起点或终点空着的管段会被拦下挂起；检修按敷设方式分组安排。</span>
    </div>

    <div v-if="batchResult" class="batch-result">
      <header class="batch-result-head">
        <strong>{{ batchResult.message }}</strong>
        <button class="link" type="button" @click="batchResult = null">收起</button>
      </header>
      <div v-if="batchResult.groups.length" class="result-block">
        <h4>新建检修单（按敷设方式分组）</h4>
        <p v-for="group in batchResult.groups" :key="group.敷设方式">
          {{ group.敷设方式 }}（{{ group.orders.length }} 张）：
          {{ group.orders.map((order) => `${order.检修单号}·${order.管段编号}`).join('、') }}
        </p>
      </div>
      <div v-if="batchResult.suspended.length" class="result-block warn">
        <h4>已拦下挂起（起点/终点未填）</h4>
        <p v-for="item in batchResult.suspended" :key="item.id">
          {{ item.管段编号 }}：缺少「{{ item.missing.join('、') }}」格，补录后才能报送
        </p>
      </div>
      <div v-if="batchResult.skipped.length" class="result-block">
        <h4>未受理</h4>
        <p v-for="item in batchResult.skipped" :key="item.id">
          {{ item.管段编号 }}：{{ item.reason }}
        </p>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="checkbox-cell">
            <input
              type="checkbox"
              :checked="allSelected"
              title="全选当前列表"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr :class="{ 'row-suspended': row['挂起原因'] }">
            <td class="checkbox-cell">
              <input
                type="checkbox"
                :checked="selectedIds.includes(Number(row.id))"
                @change="toggleOne(Number(row.id))"
              />
            </td>
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>
              {{ row.status }}
              <span v-if="row['挂起原因']" class="tag warn" :title="String(row['挂起原因'])">
                挂起
              </span>
            </td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <button
                v-if="row['挂起原因']"
                class="link"
                type="button"
                @click="openSupplement(row)"
              >
                补录起终点
              </button>
            </td>
          </tr>
          <tr v-if="supplementingId === Number(row.id)" class="inline-form-row">
            <td :colspan="columns.length + 3">
              <form class="inline-form" @submit.prevent="submitSupplement">
                <span>补录 {{ row['管段编号'] }}：</span>
                <label>
                  起点
                  <input v-model="supplementForm.起点" placeholder="填写起点" />
                </label>
                <label>
                  终点
                  <input v-model="supplementForm.终点" placeholder="填写终点" />
                </label>
                <button class="btn primary" type="submit">确认补录</button>
                <button class="btn ghost" type="button" @click="supplementingId = null">取消</button>
              </form>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无一次管网数据，可先登记一次管网管段</td>
        </tr>
      </tbody>
    </table>

    <section class="repair-panel">
      <header class="repair-panel-head">
        <h3>检修单（按敷设方式分组安排）</h3>
        <span class="repair-summary">待实测 {{ repairPendingCount }} 张 · 已回填 {{ repairFilledCount }} 张</span>
      </header>
      <p class="page-desc">设计压力由检修队实测后回填，回填值与管段列表保持同一套。</p>

      <div v-for="group in repairGroups" :key="group.敷设方式" class="repair-group">
        <h4 class="group-title">{{ group.敷设方式 }}（{{ group.orders.length }} 张）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in repairColumns" :key="column">{{ column }}</th>
              <th>当前状态</th>
              <th>可执行动作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="order in group.orders" :key="String(order.id)">
              <td v-for="column in repairColumns" :key="column">
                <template v-if="column === '设计压力'">
                  <template v-if="backfillingId === Number(order.id)">
                    <input
                      v-model="backfillValue"
                      class="backfill-input"
                      placeholder="如 1.6MPa"
                      @keyup.enter="submitBackfill(Number(order.id))"
                    />
                  </template>
                  <span v-else-if="order['设计压力']">{{ order['设计压力'] }}</span>
                  <span v-else class="tag pending">待实测</span>
                </template>
                <template v-else>{{ order[column] ?? '—' }}</template>
              </td>
              <td>{{ order.status }}</td>
              <td class="row-actions">
                <template v-if="backfillingId === Number(order.id)">
                  <button class="link" type="button" @click="submitBackfill(Number(order.id))">确认回填</button>
                  <button class="link" type="button" @click="backfillingId = null">取消</button>
                </template>
                <button
                  v-else-if="order.status === '待实测'"
                  class="link"
                  type="button"
                  @click="openBackfill(order)"
                >
                  回填设计压力
                </button>
                <span v-else class="muted-text">已回填</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!repairGroups.length" class="empty-state">暂无检修单，框选管段后点击「批量报送检修」生成</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条一次管网记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  REPAIR_KEY,
  backfillDesignPressure,
  groupRepairOrders,
  submitRepairBatch,
  supplementEndpoints,
} from '@/api/repair-service'
import type { BatchRepairResult } from '@/api/repair-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('primarynet')
const columns = ["管段编号", "起点", "终点", "公称管径", "设计压力", "敷设方式", "保温形式", "管段状态"]
const actions = ["提交投运", "登记检修", "报废管段"]
const statuses = ["待投运", "运行中", "检修中", "已废弃"]
const repairColumns = ["检修单号", "批次号", "管段编号", "起点", "终点", "公称管径", "敷设方式", "设计压力", "检修队", "报送时间"]

const rows = ref<EntryRow[]>([])
const repairs = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const selectedIds = ref<number[]>([])
const batchResult = ref<BatchRepairResult | null>(null)
const supplementingId = ref<number | null>(null)
const supplementForm = ref<{ 起点: string; 终点: string }>({ 起点: '', 终点: '' })
const backfillingId = ref<number | null>(null)
const backfillValue = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '运行中管段', value: rows.value.filter((row) => String(row.status) === '运行中').length },
  { label: '检修中管段', value: rows.value.filter((row) => String(row.status) === '检修中').length },
  { label: '已废弃管段', value: rows.value.filter((row) => String(row.status) === '已废弃').length },
])
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)
const repairGroups = computed(() => groupRepairOrders(repairs.value))
const repairPendingCount = computed(
  () => repairs.value.filter((row) => String(row.status) === '待实测').length,
)
const repairFilledCount = computed(
  () => repairs.value.filter((row) => String(row.status) === '已回填').length,
)

function toggleOne(id: number) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleAll() {
  selectedIds.value = allSelected.value ? [] : rows.value.map((row) => Number(row.id))
}

function clearSelection() {
  selectedIds.value = []
}

function submitBatch() {
  errorMessage.value = ''
  batchResult.value = submitRepairBatch(selectedIds.value)
  clearSelection()
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  batchResult.value = null
  if (action === '登记检修') {
    // 单条登记也走批量通道：校验、落检修单、联动阀门井都一致。
    batchResult.value = submitRepairBatch([Number(row.id)])
    reload()
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openSupplement(row: EntryRow) {
  errorMessage.value = ''
  supplementingId.value = Number(row.id)
  supplementForm.value = { 起点: String(row['起点'] ?? ''), 终点: String(row['终点'] ?? '') }
}

function submitSupplement() {
  if (supplementingId.value === null) {
    return
  }
  const result = supplementEndpoints(supplementingId.value, supplementForm.value)
  if (!result.ok) {
    errorMessage.value = result.message
  } else {
    errorMessage.value = ''
    supplementingId.value = null
  }
  reload()
}

function openBackfill(order: EntryRow) {
  errorMessage.value = ''
  backfillingId.value = Number(order.id)
  backfillValue.value = String(order['设计压力'] ?? '')
}

function submitBackfill(repairId: number) {
  const result = backfillDesignPressure(repairId, backfillValue.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  backfillingId.value = null
  backfillValue.value = ''
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '一次管网管段登记入口尚未接入审批流'
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    repairs.value = listEntries(REPAIR_KEY).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '一次管网列表读取失败'
  }
}

onMounted(reload)
</script>
