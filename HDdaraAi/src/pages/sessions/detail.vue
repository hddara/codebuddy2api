<script setup lang="ts">
import type { TranscriptEntry } from '@/api/sessions'
import { onLoad, onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { fetchTranscripts, MAX_TRANSCRIPT_PAGE } from '@/api/sessions'
import StateBlock from '@/components/StateBlock.vue'
import { describeError } from '@/utils/errors'
import { formatRelative } from '@/utils/format'
import { toSnippet } from '@/utils/markdown'

definePage({
  name: 'session-detail',
  style: { navigationBarTitleText: '会话详情' },
})

/**
 * Conversation overview only.
 *
 * This page used to render the live reply *and* every stored turn inline, which
 * made it a long mixed feed where neither the newest output nor a specific past
 * answer was easy to reach. It is now an index: one entry per destination, each
 * showing just enough to decide whether to open it.
 */
const conversationId = ref('')
const entries = ref<TranscriptEntry[]>([])
const loading = ref(true)
const errorMessage = ref('')
const totalStored = ref(0)

/**
 * Rows fetched per page, and the most the endpoint will ever return.
 *
 * A conversation on real traffic held 684 turns while the list showed 40 of them
 * with no way to reach the rest — the footnote admitted the cut but offered
 * nothing to act on. Paging is what turns that note into a usable history.
 */
const PAGE_SIZE = 40
/** The endpoint's own page ceiling, so a request past it can never be a no-op. */
const MAX_PREVIEW = MAX_TRANSCRIPT_PAGE
const previewLimit = ref(PAGE_SIZE)
const loadingMore = ref(false)

/**
 * Whether intermediate tool steps are listed next to the exchanges.
 *
 * Off by default. A task the IDE runs issues dozens of steps on the way to one
 * answer, and on real traffic they made up 142 of 500 stored turns — each a
 * fragment like "Now re-run the RV to confirm…" filed as if it were a question
 * and its answer, which is what made the history unreadable.
 *
 * They are hidden rather than dropped: they are still the record of what the
 * gateway saw, and they are one tap away when that is what you are after.
 */
const showToolTurns = ref(false)

/** Steps inside the fetched page, i.e. how many the toggle would add. */
const pageToolTurns = computed(
  () => entries.value.filter(entry => entry.toolTurn).length,
)

const visibleEntries = computed(() => (showToolTurns.value
  ? entries.value
  : entries.value.filter(entry => !entry.toolTurn)))

/**
 * Steps across the whole conversation, as counted by the gateway.
 *
 * Separate from `pageToolTurns`: the header reports the conversation, the
 * toggle reports what is actually on screen. Zero for turns stored before the
 * gateway marked them, which is why it is a count and not a claim.
 */
const toolTurnTotal = ref(0)

/**
 * Shortened conversation id shown in the header.
 *
 * The full value is long and not useful to read, but it is what a person needs
 * when correlating the app with a gateway log, so it is copyable rather than
 * merely truncated.
 */
const shortId = computed(() =>
  conversationId.value ? `${conversationId.value.slice(0, 20)}…` : '',
)

function copyConversationId() {
  if (!conversationId.value)
    return

  uni.setClipboardData({
    data: conversationId.value,
    success: () => uni.showToast({ icon: 'none', title: '已复制会话标识' }),
  })
}

/** Reloads after a failure; previously the only way out was leaving the page. */
function retry() {
  loading.value = true
  void load()
}

/**
 * Identifies the newest `load()`.
 *
 * `onShow` reloads on every return, and `onPullDownRefresh` and `retry` do too,
 * with nothing stopping them from overlapping — leave and re-enter quickly and
 * two requests are in flight at once. Whichever resolved last used to win, which
 * is not necessarily the newest, so the list could settle on a stale response
 * and stay there until the next show. Only the request that is still current is
 * allowed to write.
 */
let loadToken = 0

async function load(options: { more?: boolean } = {}) {
  if (!conversationId.value) {
    errorMessage.value = '缺少会话标识'
    loading.value = false
    return
  }

  const token = (loadToken += 1)

  if (options.more) {
    loadingMore.value = true
  }
  else {
    loading.value = true
  }

  try {
    const payload = await fetchTranscripts(
      conversationId.value,
      previewLimit.value,
    )

    if (token !== loadToken)
      return

    entries.value = payload.entries ?? []
    totalStored.value = payload.totals?.stored ?? entries.value.length
    toolTurnTotal.value = payload.totals?.toolTurns ?? 0
    errorMessage.value = ''
  }
  catch (error) {
    if (token !== loadToken)
      return

    errorMessage.value = describeError(error, '加载记录失败')
  }
  finally {
    // Guarded too: a superseded request finishing must not clear the spinner
    // while the current one is still in flight.
    if (token === loadToken) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

/**
 * Whether another page is both available and reachable.
 *
 * `totalStored` counts the whole conversation while a page is capped at
 * `MAX_PREVIEW`: past that, the button would fetch the same rows again and read
 * as a control that does nothing.
 */
const canLoadMore = computed(
  () => entries.value.length > 0
    && totalStored.value > entries.value.length
    && previewLimit.value < MAX_PREVIEW,
)

/**
 * Widens the page and reloads.
 *
 * `more` keeps the existing rows on screen: the plain path flips `loading`,
 * which replaces the list with the spinner, and a reader asking for the next
 * page would watch the list they were reading disappear.
 */
function showMore() {
  previewLimit.value = Math.min(previewLimit.value + PAGE_SIZE, MAX_PREVIEW)
  void load({ more: true })
}

function openLive() {
  uni.navigateTo({
    url: `/pages/sessions/live?conversationId=${encodeURIComponent(conversationId.value)}`,
  })
}

function openTranscript(entry: TranscriptEntry) {
  uni.navigateTo({
    url: `/pages/sessions/transcript?conversationId=${encodeURIComponent(conversationId.value)}`
      + `&entryId=${encodeURIComponent(entry.id)}`,
  })
}

onLoad((query) => {
  const raw = String((query as Record<string, string>)?.conversationId ?? '')

  // A malformed escape (`%`, or `%ZZ`) throws `URIError` and the value arrives
  // straight from the route, so an edited URL or a bad deep link is enough to
  // get one. Uncaught it aborts `onLoad` and the page stays blank instead of
  // reporting that the id is bad.
  try {
    conversationId.value = decodeURIComponent(raw)
  }
  catch {
    conversationId.value = raw
  }
})

// Refreshed on every show so returning from a question shows the new turn.
onShow(() => {
  void load()
})
</script>

<template>
  <view class="page">
    <view class="head">
      <view class="head-row">
        <text class="head-id">{{ shortId }}</text>
        <button class="head-copy" @tap="copyConversationId">
          复制
        </button>
      </view>
      <text class="head-caption">会话标识</text>
    </view>

    <StateBlock
      v-if="errorMessage"
      tone="danger"
      :text="errorMessage"
      retry-text="重试"
      @retry="retry"
    />

    <!-- Entry 1: live output, kept separate from stored history because it is
         transient and is the thing you want while waiting on an answer.

         A <button>, not a tappable <view>: on the App runtime a tap landing on a
         child <text> does not reliably reach a handler bound to the parent view,
         so these rows silently ignored presses. That is the same defect the
         login screen documents, and it is why "点不动" kept being reported. -->
    <button class="entry entry-primary" @tap="openLive">
      <view class="entry-body">
        <text class="entry-title">实时回复</text>
        <text class="entry-sub">
          查看正在输出的内容，或直接向这个会话提问
        </text>
      </view>
      <text class="entry-arrow">›</text>
    </button>

    <!-- Entry 2: stored turns, one row each, preview only. -->
    <view class="section-head">
      <text class="section-title">历史问答</text>
      <text class="section-count">
        {{ totalStored ? `共 ${totalStored} 条${toolTurnTotal ? `，含 ${toolTurnTotal} 条中间步骤` : ''}` : '' }}
      </text>
    </view>

    <StateBlock v-if="loading" :loading="true" text="加载中…" />

    <StateBlock
      v-else-if="!entries.length"
      text="还没有记录"
      hint="网关会保存每次问答，可在设置里调整保留天数与条数。"
    />

    <view v-else class="list">
      <button
        v-for="entry in visibleEntries"
        :key="entry.id"
        class="entry"
        @tap="openTranscript(entry)"
      >
        <view class="entry-body">
          <text class="entry-question">
            {{ toSnippet(entry.question, 80) || '(无提问文本)' }}
          </text>
          <view class="entry-meta">
            <text class="entry-time">{{ formatRelative(entry.completedAt) }}</text>
            <text
              class="entry-status"
              :class="[`status-${entry.status}`]"
            >
              {{ entry.status === 'failed' ? '失败' : '完成' }}
            </text>
          </view>
        </view>
        <text class="entry-arrow">›</text>
      </button>
    </view>

    <!-- Intermediate steps: hidden by default because they are what buried the
         answers, but still the record of what happened, so they stay one tap
         away instead of being dropped. -->
    <button
      v-if="pageToolTurns || showToolTurns"
      class="footnote-action"
      @tap="showToolTurns = !showToolTurns"
    >
      {{ showToolTurns ? '隐藏中间步骤' : `显示本页中间步骤（${pageToolTurns} 条）` }}
    </button>

    <!-- A <button>, not a note: the previous version only admitted the cut, so
         the rest of the conversation was unreachable from the phone. -->
    <button
      v-if="canLoadMore"
      class="footnote-action"
      :disabled="loadingMore"
      @tap="showMore"
    >
      {{ loadingMore ? '加载中…' : `加载更多（已显示 ${entries.length} / ${totalStored} 条）` }}
    </button>

    <!-- Past the ceiling the button would fetch the same page again and appear
         to do nothing, so say where the list stops instead. -->
    <view v-else-if="entries.length && totalStored > entries.length" class="footnote">
      仅显示最近 {{ entries.length }} 条，共 {{ totalStored }} 条。
    </view>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  padding: 20rpx $gap-page 60rpx;
  box-sizing: border-box;
  background-color: $color-page;
}

.head {
  padding: 8rpx 4rpx 20rpx;
}

.head-row {
  display: flex;
  align-items: center;
  gap: $gap-inline;
}

.head-id {
  flex: 1;
  min-width: 0;
  font-size: $font-meta;
  color: $color-text-secondary;
  word-break: break-all;
}

.head-copy {
  flex: none;
  font-size: $font-meta;
  color: $color-primary;
  /* Inline text affordance: uni-app's <button> defaults to full width with its
     own border and background, none of which belong here. */
  display: inline-block;
  width: auto;
  margin: 0;
  padding: 4rpx 12rpx;
  line-height: 1.5;
  background-color: transparent;
}

.head-copy::after {
  border: none;
}

.head-caption {
  display: block;
  margin-top: 4rpx;
  font-size: $font-micro;
  color: $color-text-faint;
}

/* Reset the platform button chrome so a row still reads as a list item:
   uni gives <button> its own background, border, radius and centring, and its
   ::after pseudo-element draws an extra hairline border. */
.entry {
  display: flex;
  align-items: center;
  gap: 16rpx;
  width: 100%;
  margin: 0 0 16rpx;
  padding: 26rpx 24rpx;
  border: none;
  border-radius: $radius-card;
  background-color: $color-surface;
  font-weight: normal;
  line-height: normal;
  text-align: left;
}

.entry::after {
  border: none;
}

.entry-primary {
  background-color: #eef5ff;
}

.entry-body {
  flex: 1;
  min-width: 0;
}

.entry-title {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
  color: $color-primary;
}

.entry-sub {
  display: block;
  margin-top: 6rpx;
  font-size: $font-meta;
  color: #6b7280;
  line-height: 1.6;
}

.entry-question {
  /* Two lines max: the list is for scanning, the full text lives in the detail. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: $font-section;
  color: $color-text;
  line-height: 1.6;
}

.entry-meta {
  display: flex;
  align-items: center;
  gap: 14rpx;
  margin-top: 10rpx;
}

.entry-time {
  font-size: $font-micro;
  color: $color-text-faint;
}

.entry-status {
  font-size: $font-micro;
}

.status-completed {
  color: $color-success;
}

.status-failed {
  color: $color-danger;
}

.entry-arrow {
  flex: none;
  font-size: 40rpx;
  color: #c8ccd2;
  line-height: 1;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 16rpx 4rpx 12rpx;
}

.section-title {
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
}

.section-count {
  font-size: 23rpx;
  color: #8a8f99;
}

.hint {
  padding: 36rpx 24rpx;
  border-radius: 20rpx;
  background-color: #ffffff;
  font-size: 26rpx;
  color: #8a8f99;
  line-height: 1.8;
}

.footnote {
  padding-top: 16rpx;
  font-size: 22rpx;
  color: #a8adb5;
  text-align: center;
}

/* Reset the platform button chrome so this reads as a footnote that happens to
   be tappable, not as a full-width primary action. */
.footnote-action {
  display: block;
  width: 100%;
  margin: 0;
  padding: 20rpx 0 0;
  border: none;
  background-color: transparent;
  font-size: 22rpx;
  font-weight: normal;
  line-height: 1.6;
  color: $color-primary;
  text-align: center;
}

.footnote-action::after {
  border: none;
}

.footnote-action[disabled] {
  color: $color-text-faint;
}
</style>
