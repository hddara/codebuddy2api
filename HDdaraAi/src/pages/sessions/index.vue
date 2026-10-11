<script setup lang="ts">
import type { SessionRow } from '@/api/sessions'
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import {
  backfillSessionTitles,
  fetchSessions,
  renameSession,
} from '@/api/sessions'
import StateBlock from '@/components/StateBlock.vue'
import { useAuthStore } from '@/store/authStore'
import { parseStored } from '@/store/persist'
import { ensureUnlocked } from '@/utils/app-guard'
import { describeError } from '@/utils/errors'
import { formatCount, formatRelative } from '@/utils/format'

definePage({
  name: 'sessions',
  style: { navigationBarTitleText: '会话' },
})

const auth = useAuthStore()
const loading = ref(false)
const errorMessage = ref('')
const sessions = ref<SessionRow[]>([])
const totals = ref({ calls: 0, sessions: 0, totalTokens: 0 })
const ungroupedEvents = ref(0)
const windowMinutes = ref(24 * 60)

const windowOptions = [
  { label: '1 小时', value: 60 },
  { label: '6 小时', value: 6 * 60 },
  { label: '24 小时', value: 24 * 60 },
  { label: '7 天', value: 7 * 24 * 60 },
]

const windowLabel = computed(
  () =>
    windowOptions.find(option => option.value === windowMinutes.value)
      ?.label ?? '',
)

/**
 * Whether a credential is available, consulting persistent storage.
 *
 * `auth.hasCredentials` alone is not enough on a cold start: the store is
 * hydrated by a Pinia plugin that runs after `plus` is up, while this page's
 * `onShow` can fire first — so the in-memory state was still empty and the page
 * short-circuited with "not signed in", never sending the request. Reading the
 * snapshot (and syncing the store once it is found) makes the page independent
 * of that ordering.
 */
function hasCredential(): boolean {
  if (auth.hasCredentials)
    return true

  const persisted = parseStored(uni.getStorageSync('auth'))

  if (persisted?.adminCookie || persisted?.apiKey) {
    // Hydrate the store too, so the request interceptor can attach the header.
    // Use the setters rather than `$patch`: they keep `isLoggedIn` in sync by
    // construction, and `$patch` does not accept an untyped record here.
    auth.setAdminCookie((persisted.adminCookie as string | undefined) ?? '')
    auth.setApiKey((persisted.apiKey as string | undefined) ?? '')

    return true
  }

  return false
}

/**
 * Waits for a credential to become readable.
 *
 * On a cold start the storage backend is not up when the page first shows, so a
 * single check reports "not signed in" even though the snapshot is on disk —
 * the settings page reads it fine a moment later. Polling briefly turns that
 * startup race into a short delay instead of a misleading empty state.
 */
async function awaitCredential(timeoutMs = 5_000): Promise<boolean> {
  if (hasCredential())
    return true

  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    if (hasCredential())
      return true
  }

  return false
}

/**
 * Identifies the newest `load()`.
 *
 * Tapping through the time-range chips starts overlapping requests, and the one
 * that resolved last used to win — which is not necessarily the one just asked
 * for. The list could therefore settle on the previous range's sessions while
 * the newly selected chip stayed highlighted, and it stayed wrong until the
 * page was left and reopened. Only the current request may write.
 */
let loadToken = 0

async function load() {
  const token = (loadToken += 1)

  loading.value = true

  if (!(await awaitCredential())) {
    if (token === loadToken) {
      errorMessage.value = '尚未登录，请先到「设置」填写控制台凭据'
      sessions.value = []
      loading.value = false
    }

    return
  }

  errorMessage.value = ''

  try {
    const payload = await fetchSessions(windowMinutes.value)

    if (token !== loadToken)
      return

    sessions.value = payload.sessions ?? []
    totals.value = payload.totals ?? {
      calls: 0,
      sessions: 0,
      totalTokens: 0,
    }
    ungroupedEvents.value = payload.ungroupedEvents ?? 0

    // Deliberately not awaited: naming the older rows can take a few seconds,
    // and the list is already usable with the id fallback. The result is matched
    // back by conversation id, so a refresh landing mid-flight is harmless.
    void backfillTitles(payload.sessions ?? [])
  }
  catch (error) {
    if (token !== loadToken)
      return

    // The gateway's own wording ("Admin session required") describes the
    // server's view, not what the user should do about it. A stale cookie is by
    // far the most common cause — sessions expire while the app keeps holding
    // the old value — so it is translated into an actionable instruction.
    errorMessage.value = describeError(error, '加载会话失败')
    sessions.value = []
  }
  finally {
    if (token === loadToken) {
      loading.value = false
    }
  }
}

/**
 * One line of context per row.
 *
 * The id alone identifies nothing to a reader — every row looked identical. The
 * model and the console key are what a person actually uses to tell sessions
 * apart.
 */
function describeSession(item: SessionRow): string {
  const parts = [item.models.join(', ') || '未知模型']

  if (item.accessKeyName)
    parts.push(item.accessKeyName)

  return parts.join(' · ')
}

/**
 * What the row's heading should read.
 *
 * Falls back to the shortened id so a conversation without a title still shows
 * something stable — the gateway only starts naming conversations from the first
 * question it sees, so older ones legitimately have none.
 */
function rowTitle(item: SessionRow): string {
  if (item.title)
    return item.title

  return `${item.conversationId.slice(0, 12)}…`
}

/** Marks a renamed row, so it is clear the model did not choose that name. */
function isRenamed(item: SessionRow): boolean {
  return item.titleSource === 'manual'
}

/**
 * Asks the gateway to name conversations that predate titles.
 *
 * Only conversations actually on screen are sent, and the gateway caps the batch
 * itself. Runs in the background and folds the result into the visible rows so
 * names appear without a reload — a failure here is invisible, because the rows
 * already render fine with the id fallback.
 */
async function backfillTitles(rows: SessionRow[]) {
  const untitled = rows
    .filter(item => !item.title)
    .map(item => item.conversationId)

  if (!untitled.length)
    return

  try {
    const result = await backfillSessionTitles(untitled)

    if (!result?.titles)
      return

    // `sessions` is replaced wholesale by a reload, so match by id rather than
    // by index: a refresh that lands between the request and its reply would
    // otherwise write names onto the wrong rows.
    sessions.value = sessions.value.map((item) => {
      const title = result.titles[item.conversationId]

      return title ? { ...item, title, titleSource: 'ai' as const } : item
    })
  }
  catch {
    // Best-effort: an unnamed row is a cosmetic shortcoming, not an error worth
    // interrupting the list for.
  }
}

/**
 * Renames a conversation through a modal prompt.
 *
 * `uni.showModal` with `editable` is the only text input available without
 * building a page for it, and the app already uses it for confirmations. The
 * result is applied optimistically from the server's response rather than from
 * the typed value, so any trimming the gateway did is what the row shows.
 */
function promptRename(item: SessionRow) {
  uni.showModal({
    content: rowTitle(item),
    editable: true,
    placeholderText: '给这个会话起个名字',
    success: async (result: { confirm?: boolean, content?: string }) => {
      if (!result.confirm)
        return

      const title = (result.content ?? '').trim()

      if (!title)
        return

      try {
        const response = await renameSession(item.conversationId, title)
        const saved = response?.session?.title ?? title

        sessions.value = sessions.value.map(row =>
          row.conversationId === item.conversationId
            ? { ...row, title: saved, titleSource: 'manual' as const }
            : row,
        )
        uni.showToast({ icon: 'none', title: '已重命名' })
      }
      catch (error) {
        uni.showToast({
          icon: 'none',
          title: describeError(error, '重命名失败'),
        })
      }
    },
    title: '重命名会话',
  } as never)
}

async function changeWindow(value: number) {
  windowMinutes.value = value
  await load()
}

/**
 * Retries after a failure without leaving the page.
 *
 * Also clears the error first: the block that shows it is what carries the retry
 * affordance, so leaving it up during the reload would keep a stale message on
 * screen next to a spinner.
 */
function retry() {
  errorMessage.value = ''
  void load()
}

function openDetail(item: SessionRow) {
  // The title rides along so the detail header is correct on its first paint;
  // refetching it would show the id for a moment and then swap.
  const params = [`conversationId=${encodeURIComponent(item.conversationId)}`]

  if (item.title)
    params.push(`title=${encodeURIComponent(item.title)}`)

  if (item.titleSource)
    params.push(`titleSource=${encodeURIComponent(item.titleSource)}`)

  uni.navigateTo({
    url: `/pages/sessions/detail?${params.join('&')}`,
  })
}

onShow(() => {
  // Guarded on every show, not just at launch: a tab switch or a restored
  // stack can reach this page without the lock screen having run.
  if (!ensureUnlocked())
    return

  void load()
})

onPullDownRefresh(async () => {
  await load()
  uni.stopPullDownRefresh()
})
</script>

<template>
  <view class="page">
    <view class="toolbar">
      <!-- Each option is a <button>: as a plain <view> inside a horizontal
           scroll-view, a tap lost the race against the scroll gesture and the
           time range could not be changed at all. -->
      <scroll-view class="chips" scroll-x>
        <button
          v-for="option in windowOptions"
          :key="option.value"
          class="chip" :class="[option.value === windowMinutes ? 'chip-active' : '']"
          @tap="changeWindow(option.value)"
        >
          {{ option.label }}
        </button>
      </scroll-view>
    </view>

    <view class="summary">
      <text class="summary-main">
        {{ totals.sessions }} 个会话 / {{ totals.calls }} 次请求
      </text>
      <text v-if="ungroupedEvents > 0" class="summary-sub">
        另有 {{ ungroupedEvents }} 条请求未带 conversation-id
      </text>
    </view>

    <StateBlock
      v-if="errorMessage"
      tone="danger"
      icon="i-carbon:warning-alt"
      :text="errorMessage"
      retry-text="重试"
      @retry="retry"
    />

    <!-- A skeleton rather than a centred spinner: the list keeps its shape while
         loading, so the content does not appear by shoving the page around. -->
    <AppSkeleton v-else-if="loading" :rows="4" />

    <StateBlock
      v-else-if="!sessions.length"
      icon="i-carbon:search"
      text="该时间范围内没有会话"
      hint="换个时间范围看看，或在 IDE 里发起一次请求。"
    />

    <view v-else class="list">
      <!-- A <button>: taps on a child <text> do not reliably reach a handler on
           a plain <view> in the App runtime, which made these cards ignore
           presses. Same reason the rows on the detail page are buttons. -->
      <button
        v-for="item in sessions"
        :key="item.conversationId"
        class="row"
        @tap="openDetail(item)"
        @longpress="promptRename(item)"
      >
        <view class="row-head">
          <text class="row-title" :class="{ 'row-title-renamed': isRenamed(item) }">
            {{ rowTitle(item) }}
          </text>
          <text class="row-time">{{ formatRelative(item.lastActiveAt) }}</text>
        </view>
        <view class="row-meta">
          <!-- Clamped to one line: a session can carry several models and the
               joined list used to push the card taller than its neighbours. -->
          <text class="row-model">{{ describeSession(item) }}</text>
        </view>
        <view class="row-stats">
          <text>{{ item.callCount }} 次请求</text>
          <!-- Shortened: a real session reports 517158574 tokens, which wrapped
               onto a second line and pushed the row out of the card. -->
          <text>{{ formatCount(item.totalTokens) }} tokens</text>
        </view>
      </button>
    </view>

    <view class="footer-hint">
      当前范围：{{ windowLabel }}
    </view>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  background-color: $color-page;
  padding: $gap-page;
  box-sizing: border-box;
}

.toolbar {
  margin-bottom: 16rpx;
}

.chips {
  white-space: nowrap;
}

.chip {
  display: inline-block;
  padding: 12rpx 28rpx;
  margin-right: 16rpx;
  border-radius: $radius-pill;
  background-color: $color-surface;
  color: $color-text-secondary;
  font-size: $font-label;
  line-height: 1.5;
  /* uni-app gives every <button> a default border, background and full width;
     all three fight the pill styling above. */
  border: none;
}

.chip::after {
  border: none;
}

.chip-active {
  background-color: $color-primary;
  color: $color-surface;
}

.summary {
  display: flex;
  flex-direction: column;
  padding: 8rpx 4rpx 20rpx;
}

.summary-main {
  font-size: $font-label;
  color: $color-text-secondary;
}

.summary-sub {
  margin-top: 6rpx;
  font-size: $font-meta;
  color: $color-text-muted;
}

/* Reset the platform button chrome so a row still reads as a card. */
.row {
  display: block;
  width: 100%;
  margin: 0 0 $gap-section;
  padding: $gap-section;
  border: none;
  border-radius: $radius-card;
  background-color: $color-surface;
  font-weight: normal;
  line-height: normal;
  text-align: left;
}

.row::after {
  border: none;
}

.row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
}

.row-title {
  flex: 1;
  min-width: 0;
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
  /* A title is a phrase, so it wraps at spaces; the id fallback has no spaces
     and needs breaking anywhere or it pushes the timestamp off the row. */
  word-break: break-word;
}

/* A user-chosen name is marked, so it is distinguishable from a generated one
   without having to remember which rows were renamed by hand. */
.row-title-renamed {
  color: $color-primary;
}

.row-time {
  flex: none;
  font-size: $font-meta;
  color: $color-text-muted;
}

.row-meta {
  margin-top: 10rpx;
  font-size: $font-meta;
  color: $color-text-secondary;
}

/* One line, ellipsised. A session can list several models and the unclamped
   value made one card taller than the rest of the list. */
.row-model {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.row-stats {
  margin-top: 14rpx;
  display: flex;
  gap: 32rpx;
  font-size: $font-meta;
  color: $color-text-muted;
}

.footer-hint {
  padding: $gap-section 0 40rpx;
  text-align: center;
  font-size: $font-micro;
  color: $color-text-faint;
}
</style>
