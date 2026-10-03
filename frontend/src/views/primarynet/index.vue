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
      <button
        class="btn primary"
        type="button"
        :disabled="!selectedIds.length"
        @click="submitBatch"
      >
        批量报送检修（已框选 {{ selectedIds.length }} 条）
      </button>
      <button v-if="selectedIds.length" class="btn ghost" type="button" @click="clearSelection">
        清空选择
      </button>
      <span class="batch-hint">
        框选后一次报送，检修单按敷设方式分组生成；起点或终点没填的会先拦下挂起，设计压力由检修队实测后回填。
      </span>
    </div>

    <div v-if="batchResult" class="batch-result">
      <p><strong>{{ batchResult.message }}</strong></p>
      <p v-for="order in batchResult.orders" :key="String(order.id)">
        检修单 {{ order['检修单号'] }}（{{ order['敷设方式'] }}）：{{ order['管段清单'] }}
      </p>
      <p v-for="item in batchResult.blocked" :key="`blocked-${item.id}`" class="error-text">
        {{ item.code }} 已挂起：{{ item.missing.map((field) => `「${field}」`).join('、') }}一格没填，补录后再报送
      </p>
      <p v-for="item in batchResult.rejected" :key="`rejected-${item.id}`" class="error-text">
        {{ item.code }} 已拒收：{{ item.reason }}
      </p>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="check-col">
            <input
              type="checkbox"
              :checked="allChecked"
              title="框选当前列表全部管段"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-suspended': row.abnormal }">
          <td class="check-col">
            <input v-model="selectedIds" type="checkbox" :value="Number(row.id)" />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="tag warn" :title="String(row['挂起原因'] ?? '')">挂起</span>
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
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无一次管网数据，可先登记一次管网管段</td>
        </tr>
      </tbody>
    </table>

    <section class="order-panel">
      <h3>检修单（按敷设方式分组安排）</h3>
      <p v-if="orderMessage" class="order-message">{{ orderMessage }}</p>
      <div v-for="group in orderGroups" :key="group.laying" class="order-group">
        <h4>{{ group.laying }}（{{ group.orders.length }} 单）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>检修单号</th>
              <th>管段清单</th>
              <th>管段数量</th>
              <th>公称管径</th>
              <th>设计压力</th>
              <th>报送时间</th>
              <th>当前状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="order in group.orders" :key="String(order.id)">
              <td>{{ order['检修单号'] }}</td>
              <td>{{ order['管段清单'] }}</td>
              <td>{{ order['管段数量'] }}</td>
              <td>{{ order['公称管径'] }}</td>
              <td>
                <span v-if="order['设计压力']">{{ order['设计压力'] }}（已同步管段列表）</span>
                <span v-else class="pressure-cell">
                  <input
                    v-model="pressureDrafts[Number(order.id)]"
                    placeholder="实测后回填，如 1.6"
                  />
                  <button class="btn" type="button" @click="backfill(order)">回填</button>
                </span>
              </td>
              <td>{{ order['报送时间'] }}</td>
              <td>{{ order.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!orders.length" class="empty-state">暂无检修单，框选管段后批量报送即可生成。</p>
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
  backfillDesignPressure,
  listRepairOrders,
  submitSegmentsToRepair,
  type BatchRepairResult,
} from '@/api/primary-repair'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('primarynet')
const columns = ["管段编号", "起点", "终点", "公称管径", "设计压力", "敷设方式", "保温形式", "管段状态"]
const actions = ["提交投运", "登记检修", "报废管段"]
const statuses = ["待投运", "运行中", "检修中", "已废弃"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const selectedIds = ref<number[]>([])
const batchResult = ref<BatchRepairResult | null>(null)
const orders = ref<EntryRow[]>([])
const orderMessage = ref('')
const pressureDrafts = ref<Record<number, string>>({})

const stats = computed(() => [
  { label: '运行中管段', value: rows.value.filter((row) => String(row.status) === '运行中').length },
  { label: '检修中管段', value: rows.value.filter((row) => String(row.status) === '检修中').length },
  { label: '已废弃管段', value: rows.value.filter((row) => String(row.status) === '已废弃').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const allChecked = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)
const orderGroups = computed(() => {
  const groups = new Map<string, EntryRow[]>()
  for (const order of orders.value) {
    const laying = String(order['敷设方式'] ?? '未登记敷设方式')
    groups.set(laying, [...(groups.get(laying) ?? []), order])
  }
  return [...groups.entries()].map(([laying, groupOrders]) => ({ laying, orders: groupOrders }))
})

function toggleAll() {
  selectedIds.value = allChecked.value ? [] : rows.value.map((row) => Number(row.id))
}

function clearSelection() {
  selectedIds.value = []
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

function submitBatch() {
  errorMessage.value = ''
  batchResult.value = submitSegmentsToRepair(selectedIds.value)
  clearSelection()
  reload()
  reloadOrders()
}

function backfill(order: EntryRow) {
  errorMessage.value = ''
  orderMessage.value = ''
  const result = backfillDesignPressure(Number(order.id), pressureDrafts.value[Number(order.id)] ?? '')
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  pressureDrafts.value[Number(order.id)] = ''
  orderMessage.value = result.message
  reload()
  reloadOrders()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  batchResult.value = null
  // 登记检修走批量同一套校验：缺起点终点挂起、越级拒收、重复只落一条
  if (action === '登记检修') {
    batchResult.value = submitSegmentsToRepair([Number(row.id)])
    reload()
    reloadOrders()
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '一次管网列表读取失败'
  }
}

function reloadOrders() {
  orders.value = listRepairOrders()
}

onMounted(() => {
  reload()
  reloadOrders()
})
</script>
