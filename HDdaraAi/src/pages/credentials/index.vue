<script setup lang="ts">
import type {
  CredentialDraft,
  CredentialLimit,
  CredentialListItem,
  CredentialModels,
  CurrentCredential,
} from '@/api/credentials'
import { onShow } from '@dcloudio/uni-app'

import { computed, ref } from 'vue'
import { consoleErrorMessage } from '@/api/core/console'
import {
  clearCredentialLimits,
  deleteCredential,
  describeCredential,
  draftFromCredential,
  fetchCredentialLimits,
  fetchCredentialModels,
  fetchCredentials,
  fetchCurrentCredential,
  refreshCredentialModels,
  saveCredential,
  saveCredentialModels,
  selectCredential,
} from '@/api/credentials'
import { ensureUnlocked } from '@/utils/app-guard'
import { formatDateTime } from '@/utils/format'

definePage({
  name: 'credentials',
  style: { navigationBarTitleText: '凭证管理' },
})

const credentials = ref<CredentialListItem[]>([])
const current = ref<CurrentCredential | null>(null)
const limits = ref<CredentialLimit[]>([])
const models = ref<CredentialModels>({})
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')
/** Filename of the row a write is in flight for; empty when idle. */
const pending = ref('')
/** Index awaiting a delete confirmation. */
const confirmIndex = ref<number | null>(null)
/** Filename whose model list is expanded. */
const modelsOpenFor = ref('')
/**
 * Edited-but-unsaved model lists, keyed by filename.
 *
 * A missing entry means "not touched", which is what lets the textarea fall back
 * to what the server has — and what lets the save button know there is nothing
 * to send.
 */
const modelDrafts = ref<Record<string, string | undefined>>({})

/**
 * The credential being created or edited.
 *
 * `null` when the form is closed. `editingIndex` distinguishes the two modes,
 * because the server decides between create and update from the presence of an
 * integer `index` — and that branch has to be explicit rather than inferred
 * from whether a filename happens to be filled in.
 */
const draft = ref<(CredentialDraft & { index?: number }) | null>(null)
const draftAdvanced = ref(false)

const limitByFilename = computed(() => {
  const map = new Map<string, CredentialLimit>()

  for (const limit of limits.value) {
    map.set(limit.filename, limit)
  }

  return map
})

const nextFilename = computed(() => {
  const value = current.value

  if (!value || value.status === 'no_credentials') {
    return null
  }

  return value.next_filename ?? null
})

const limitedCount = computed(() => limits.value.length)

/**
 * Whether the draft has enough to be worth sending.
 *
 * A new credential without a token authenticates nothing, and the server would
 * store a file that only ever fails. An edit is allowed through with just the
 * descriptive fields, because that is how a user fixes a wrong domain.
 */
const canSaveDraft = computed(() => {
  const value = draft.value

  if (!value) {
    return false
  }

  const hasToken = Boolean(value.bearer_token?.trim() || value.access_token?.trim())

  return value.index === undefined ? hasToken : true
})

const editing = computed(() => draft.value?.index !== undefined)

async function load() {
  loading.value = true
  errorMessage.value = ''

  try {
    const [list, cursor, limitList, modelMap] = await Promise.all([
      fetchCredentials(),
      fetchCurrentCredential().catch(() => null),
      fetchCredentialLimits().catch(() => [] as CredentialLimit[]),
      fetchCredentialModels().catch(() => ({}) as CredentialModels),
    ])

    credentials.value = list
    current.value = cursor
    limits.value = limitList
    models.value = modelMap
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '读取凭据失败')
  }
  finally {
    loading.value = false
  }
}

function beginCreate() {
  notice.value = ''
  errorMessage.value = ''
  draftAdvanced.value = false
  modelsOpenFor.value = ''
  draft.value = {
    domain: 'copilot.tencent.com',
    token_type: 'Bearer',
    upstream_protocol: 'chat',
  }
}

function beginEdit(item: CredentialListItem) {
  notice.value = ''
  errorMessage.value = ''
  draftAdvanced.value = true
  modelsOpenFor.value = ''
  // Seeded from the list so a user editing the domain does not have to retype
  // the identifiers — and so nothing the server would otherwise keep is blanked
  // by an empty field.
  draft.value = { ...draftFromCredential(item), index: item.index }
}

function cancelDraft() {
  draft.value = null
  draftAdvanced.value = false
}

async function submitDraft() {
  const value = draft.value

  if (!value || !canSaveDraft.value || pending.value) {
    return
  }

  pending.value = '*'
  errorMessage.value = ''
  notice.value = ''

  try {
    // Which one happened is known from the request, not the reply: the server
    // answers `{ filename, success }` either way.
    const wasEditing = value.index !== undefined
    const result = await saveCredential(value)

    notice.value = wasEditing ? '已保存' : `已添加 ${result.filename}`
    cancelDraft()
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '保存失败')
  }
  finally {
    pending.value = ''
  }
}

async function useNext(item: CredentialListItem) {
  if (pending.value) {
    return
  }

  pending.value = item.filename
  notice.value = ''
  errorMessage.value = ''

  try {
    const result = await selectCredential(item.index)

    if (!result.success) {
      errorMessage.value = result.message || '切换失败'

      return
    }

    notice.value = `下一次请求将使用 ${item.email || item.filename}`
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '切换失败')
  }
  finally {
    pending.value = ''
  }
}

async function remove(item: CredentialListItem) {
  if (pending.value) {
    return
  }

  if (confirmIndex.value !== item.index) {
    confirmIndex.value = item.index

    return
  }

  confirmIndex.value = null
  pending.value = item.filename
  notice.value = ''
  errorMessage.value = ''

  try {
    const result = await deleteCredential(item.index)

    if (!result.success) {
      errorMessage.value = result.message || '删除失败'

      return
    }

    notice.value = '凭据已删除'
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '删除失败')
  }
  finally {
    pending.value = ''
  }
}

async function clearLimits(item?: CredentialListItem) {
  if (pending.value) {
    return
  }

  pending.value = item?.filename ?? '*'
  notice.value = ''
  errorMessage.value = ''

  try {
    const result = await clearCredentialLimits(item?.filename)

    notice.value = result.cleared
      ? `已解除 ${result.cleared} 个限流标记`
      : '没有需要解除的限流'
    await load()
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '解除限流失败')
  }
  finally {
    pending.value = ''
  }
}

/**
 * Pulls the model list from upstream.
 *
 * Slow — a real round trip to the provider — so it is a separate press rather
 * than something that runs on every visit.
 */
async function refreshModels(item: CredentialListItem) {
  if (pending.value) {
    return
  }

  pending.value = item.filename
  notice.value = ''
  errorMessage.value = ''

  try {
    const next = await refreshCredentialModels(item.filename)

    models.value = { ...models.value, ...next }
    // Any unsaved edit is dropped: the user just asked for upstream's list, and
    // keeping the old text would silently discard what they fetched.
    delete modelDrafts.value[item.filename]
    notice.value = `已刷新 ${item.email || item.filename} 的模型列表`
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '刷新模型失败')
  }
  finally {
    pending.value = ''
  }
}

/**
 * Saves a hand-edited model list.
 *
 * The override exists because upstream sometimes advertises models it will not
 * serve; a user who knows which two work can say so.
 */
async function saveModels(item: CredentialListItem, text: string) {
  if (pending.value) {
    return
  }

  pending.value = item.filename
  notice.value = ''
  errorMessage.value = ''

  try {
    const next = await saveCredentialModels(item.filename, text)

    models.value = { ...models.value, ...next }
    // Cleared so the textarea falls back to what the server now holds, rather
    // than reporting unsaved changes that are already saved.
    delete modelDrafts.value[item.filename]
    notice.value = '模型列表已保存'
  }
  catch (error) {
    errorMessage.value = consoleErrorMessage(error, '保存模型失败')
  }
  finally {
    pending.value = ''
  }
}

function modelText(item: CredentialListItem): string {
  return (models.value[item.filename]?.models ?? []).map(entry => entry.id).join('\n')
}

function toggleModels(item: CredentialListItem) {
  modelsOpenFor.value = modelsOpenFor.value === item.filename ? '' : item.filename
}

function subtitle(item: CredentialListItem): string {
  const parts = [describeCredential(item)]

  if (item.domain) {
    parts.push(item.domain)
  }

  if (item.user_id) {
    parts.push(item.user_id)
  }

  return parts.join(' · ')
}

function limitText(limit: CredentialLimit): string {
  const kind = limit.kind === 'quota' ? '配额受限' : '频率受限'
  const until = limit.resumeAt ? `，${formatDateTime(limit.resumeAt)} 恢复` : ''

  return `${kind}${until}`
}

function openAccessKeys() {
  uni.navigateTo({ url: '/pages/credentials/keys' })
}

onShow(() => {
  if (!ensureUnlocked()) {
    return
  }

  void load()
})
</script>

<template>
  <view class="page">
    <StateBlock
      v-if="errorMessage"
      tone="danger"
      icon="i-carbon:warning-alt"
      :text="errorMessage"
      retry-text="重试"
      @retry="load"
    />

    <AppSkeleton v-else-if="loading" :rows="4" />

    <template v-else>
      <view class="section">
        <text class="section-title">轮询状态</text>
        <view class="row">
          <text class="row-label">凭据总数</text>
          <text class="row-value">{{ credentials.length }} 个</text>
        </view>
        <view class="row">
          <text class="row-label">下次使用</text>
          <text class="row-value">{{ nextFilename || '未指定' }}</text>
        </view>
        <view class="row row-last">
          <text class="row-label">限流中</text>
          <text class="row-value">{{ limitedCount }} 个</text>
        </view>

        <text v-if="nextFilename" class="section-hint hint-block">
          网关在多个账号间自动轮询；「设为下次」只改变下一轮从哪个账号开始，
          不会打断正在进行的回答。
        </text>

        <AppButton
          v-if="limitedCount"
          variant="tonal"
          block
          :disabled="Boolean(pending)"
          @tap="clearLimits()"
        >
          {{ pending === '*' ? '处理中…' : `全部解除限流（${limitedCount}）` }}
        </AppButton>
      </view>

      <view v-if="notice" class="notice">
        <view class="notice-icon i-carbon:checkmark" />
        <text>{{ notice }}</text>
      </view>

      <!-- The add/edit form. One form for both because the fields are the same
           and the server branches on `index`; two screens would drift. -->
      <view v-if="draft" class="section">
        <view class="section-head">
          <text class="section-title">{{ editing ? '编辑账号' : '添加上游账号' }}</text>
          <button class="section-toggle" @tap="cancelDraft">
            取消
          </button>
        </view>

        <template v-if="editing">
          <text class="section-hint">
            {{ draft.filename }}
          </text>
        </template>
        <text v-else class="section-hint">
          令牌来自上游的登录凭据。填好后网关会把它纳入轮询。
        </text>

        <view class="field">
          <text class="field-label">
            {{ editing ? '新的令牌（留空则不修改）' : '访问令牌' }}
          </text>
          <textarea
            v-model="draft.bearer_token"
            class="textarea"
            placeholder="eyJhbGciOi..."
          />
        </view>

        <template v-if="draftAdvanced">
          <view class="field">
            <text class="field-label">用户标识</text>
            <input
              v-model="draft.user_id"
              class="input"
              placeholder="用于生成文件名，可留空"
              type="text"
            >
          </view>

          <view class="field">
            <text class="field-label">域名</text>
            <input
              v-model="draft.domain"
              class="input"
              placeholder="copilot.tencent.com"
              type="text"
            >
          </view>

          <view class="field">
            <text class="field-label">上游协议</text>
            <view class="segmented">
              <button
                class="segment"
                :class="draft.upstream_protocol === 'chat' ? 'segment-on' : ''"
                @tap="draft.upstream_protocol = 'chat'"
              >
                chat
              </button>
              <button
                class="segment"
                :class="draft.upstream_protocol === 'responses' ? 'segment-on' : ''"
                @tap="draft.upstream_protocol = 'responses'"
              >
                responses
              </button>
            </view>
            <text class="field-hint">
              由上游决定。选错会得到解析失败，而不是 404。
            </text>
          </view>

          <view class="field">
            <text class="field-label">企业 / 租户标识</text>
            <input
              v-model="draft.enterprise_id"
              class="input"
              placeholder="可留空"
              type="text"
            >
          </view>
        </template>

        <button
          v-else
          class="link-row"
          @tap="draftAdvanced = true"
        >
          展开更多字段
        </button>

        <AppButton
          variant="solid"
          block
          :disabled="!canSaveDraft || Boolean(pending)"
          @tap="submitDraft"
        >
          {{ pending === '*' ? '保存中…' : '保存' }}
        </AppButton>
      </view>

      <AppButton
        v-else-if="!draft"
        variant="solid"
        block
        class="create-button"
        @tap="beginCreate"
      >
        添加上游账号
      </AppButton>

      <StateBlock
        v-if="!credentials.length && !draft"
        icon="i-carbon:user-multiple"
        text="还没有上游账号"
        hint="添加后网关才能在多个账号间轮询。"
      />

      <view
        v-for="item in credentials"
        :key="item.filename"
        class="card"
      >
        <view class="card-head">
          <text class="card-title">{{ item.name || item.email }}</text>
          <StatusTag
            :tone="limitByFilename.get(item.filename) ? 'warning' : (item.is_expired ? 'danger' : 'success')"
          >
            {{ describeCredential(item) }}
          </StatusTag>
        </view>

        <text class="card-subtitle">{{ subtitle(item) }}</text>

        <view v-if="limitByFilename.get(item.filename)" class="limit">
          <view class="limit-icon i-carbon:warning-alt" />
          <text class="limit-text">
            {{ limitText(limitByFilename.get(item.filename)!) }}
          </text>
        </view>

        <view class="card-actions">
          <AppButton
            variant="tonal"
            size="sm"
            :disabled="Boolean(pending) || item.filename === nextFilename"
            @tap="useNext(item)"
          >
            {{ item.filename === nextFilename ? '当前下次' : '设为下次' }}
          </AppButton>
          <AppButton
            variant="tonal"
            size="sm"
            :disabled="Boolean(pending)"
            @tap="beginEdit(item)"
          >
            编辑
          </AppButton>
          <AppButton
            variant="tonal"
            size="sm"
            :disabled="Boolean(pending)"
            @tap="toggleModels(item)"
          >
            {{ modelsOpenFor === item.filename ? '收起模型' : `模型（${(models[item.filename]?.models ?? []).length}）` }}
          </AppButton>
          <AppButton
            v-if="limitByFilename.get(item.filename)"
            variant="tonal"
            size="sm"
            :disabled="Boolean(pending)"
            @tap="clearLimits(item)"
          >
            解除限流
          </AppButton>
          <AppButton
            :variant="confirmIndex === item.index ? 'solid' : 'tonal'"
            :tone="confirmIndex === item.index ? 'danger' : 'neutral'"
            size="sm"
            :disabled="Boolean(pending)"
            @tap="remove(item)"
          >
            {{ confirmIndex === item.index ? '确认删除' : '删除' }}
          </AppButton>
        </view>

        <!-- Model editing lives inline rather than on its own page: the list is
             what tells a user a credential is misconfigured, and sending them
             elsewhere to fix it loses that context. -->
        <view v-if="modelsOpenFor === item.filename" class="models">
          <text class="models-hint">
            每行一个模型 id。上游有时会声明它并不提供的模型，这里的手动列表会覆盖它。
          </text>
          <!-- Edited locally and saved on a press. Binding straight to a save on
               every keystroke fired one request per character, which the gateway
               reads as a burst and which made a typo expensive. -->
          <textarea
            class="textarea models-text"
            :value="modelDrafts[item.filename] ?? modelText(item)"
            @input="(event: any) => (modelDrafts[item.filename] = event.detail.value)"
          />
          <view class="models-actions">
            <AppButton
              variant="tonal"
              size="sm"
              :disabled="Boolean(pending) || modelDrafts[item.filename] === undefined"
              @tap="saveModels(item, modelDrafts[item.filename]!)"
            >
              保存列表
            </AppButton>
            <AppButton
              variant="tonal"
              size="sm"
              :disabled="Boolean(pending)"
              @tap="refreshModels(item)"
            >
              {{ pending === item.filename ? '刷新中…' : '从上游刷新' }}
            </AppButton>
          </view>
          <text
            v-if="models[item.filename]?.error"
            class="models-error"
          >
            {{ models[item.filename]?.error }}
          </text>
        </view>
      </view>

      <view class="section">
        <text class="section-title">关于凭证与密钥</text>
        <text class="section-hint">
          这里的每一项是一个真实的上游账号，网关在它们之间轮询。
          「访问密钥」是另一回事：它是给客户端用的 cb2_ 令牌，绑定一组账号后决定客户端能用哪些模型。
        </text>
        <AppButton variant="tonal" block @tap="openAccessKeys">
          管理访问密钥
        </AppButton>
      </view>
    </template>
  </view>
</template>

<style scoped lang="scss">
@use '@/styles/tokens.scss' as *;

.page {
  min-height: 100vh;
  padding: $gap-page;
  box-sizing: border-box;
  background-color: $color-page;
}

.section {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
}

.section-title {
  flex: 1;
  min-width: 0;
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
}

.section-toggle {
  flex: none;
  width: auto;
  margin: 0;
  padding: 4rpx 12rpx;
  font-size: $font-meta;
  line-height: 1.5;
  color: $color-primary;
  background-color: transparent;
}

.section-toggle::after {
  border: none;
}

.section-hint {
  display: block;
  margin-bottom: 16rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-text-muted;
  word-break: break-all;
}

.hint-block {
  margin-top: 16rpx;
  margin-bottom: $gap-section;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
  padding: $gap-inline 0;
  border-bottom: 1rpx solid $color-border-strong;
}

.row-last {
  border-bottom: none;
}

.row-label {
  flex: none;
  font-size: $font-label;
  color: $color-text-secondary;
}

.row-value {
  flex: 1;
  min-width: 0;
  font-size: $font-label;
  color: $color-text;
  text-align: right;
  word-break: break-all;
}

.field {
  margin-top: 20rpx;
}

.field-label {
  display: block;
  margin-bottom: $gap-inline;
  font-size: $font-label;
  color: $color-text-secondary;
}

.field-hint {
  display: block;
  margin-top: 10rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-text-muted;
}

.input {
  width: 100%;
  height: $height-control;
  padding: 0 22rpx;
  box-sizing: border-box;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
  font-size: $font-body;
  color: $color-text;
}

.textarea {
  width: 100%;
  height: 180rpx;
  padding: 18rpx 22rpx;
  box-sizing: border-box;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
  font-size: $font-label;
  line-height: 1.6;
  color: $color-text;
}

.link-row {
  width: 100%;
  margin: $gap-section 0 0;
  padding: 12rpx 0;
  border: none;
  background-color: transparent;
  font-size: $font-meta;
  line-height: 1.5;
  color: $color-primary;
  text-align: left;
}

.link-row::after {
  border: none;
}

.segmented {
  display: flex;
  gap: 8rpx;
  padding: 6rpx;
  border-radius: $radius-control;
  background-color: $color-surface-sunken;
}

.segment {
  flex: 1;
  margin: 0;
  padding: 14rpx 0;
  border: none;
  border-radius: 12rpx;
  background-color: transparent;
  font-size: $font-label;
  line-height: 1.4;
  color: $color-text-secondary;
}

.segment::after {
  border: none;
}

.segment-on {
  color: $color-text;
  background-color: $color-surface;
}

.create-button {
  margin-bottom: $gap-page;
}

.card {
  margin-bottom: $gap-page;
  padding: $gap-page;
  border-radius: $radius-card;
  background-color: $color-surface;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $gap-inline;
}

.card-title {
  flex: 1;
  min-width: 0;
  font-size: $font-section;
  font-weight: 600;
  color: $color-text;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-subtitle {
  display: block;
  margin-top: 8rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-text-muted;
  word-break: break-all;
}

.limit {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-top: 14rpx;
  padding: 12rpx 16rpx;
  border-radius: $radius-control;
  background-color: $color-warning-surface;
}

.limit-icon {
  flex: none;
  width: 28rpx;
  height: 28rpx;
  color: $color-warning;
}

.limit-text {
  flex: 1;
  min-width: 0;
  font-size: $font-meta;
  color: $color-warning;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: $gap-inline;
  margin-top: $gap-section;
}

.models {
  margin-top: $gap-section;
  padding-top: $gap-section;
  border-top: 1rpx solid $color-border-strong;
}

.models-hint {
  display: block;
  margin-bottom: 12rpx;
  font-size: $font-meta;
  line-height: 1.6;
  color: $color-text-muted;
}

.models-text {
  height: 260rpx;
  margin-bottom: $gap-inline;
}

.models-actions {
  display: flex;
  flex-wrap: wrap;
  gap: $gap-inline;
}

.models-error {
  display: block;
  margin-top: 10rpx;
  font-size: $font-meta;
  color: $color-danger;
}

.notice {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-bottom: $gap-page;
  font-size: $font-meta;
  color: $color-success;
}

.notice-icon {
  flex: none;
  width: 28rpx;
  height: 28rpx;
}
</style>
