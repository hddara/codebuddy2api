import type { NextRequest } from 'next/server';

import { resolveRequestAccessKey } from './auth';
import {
  HARNESS_IDENTITY_PLACEHOLDER,
  isHarnessIdentityRewriteEnabled,
  rewriteHarnessIdentity,
} from './harness-identity';
import {
  compressMessages,
  isHistoryCompressionEnabled,
  measureImageBytes,
  measureMessagesBytes,
  pruneToolDefinitions,
} from './history-compression';
import {
  getCodeBuddyApiEndpoint,
  getCredentialLimitCooldownMs,
  getDefaultModel,
} from '../domain/config';
import {
  type CredentialData,
  type CredentialRecord,
  findEligibleCredentialRecordByFilename,
  findCredentialRecordByFilename,
  getCredentialSupportedModels,
  getCredentialProxySettings,
  listEligibleCredentialRecords,
  markCredentialLimited,
  resolveCredentialForRequest,
} from '../domain/credentials';
import {
  enqueueUpstreamResponseSnapshot,
  setDebugTraceCredential,
  setDebugTraceError,
  setDebugUpstreamRequest,
  type DebugTrace,
} from '../domain/debug';
import { resolveModelAlias } from '../domain/model-aliases';
import {
  publishSessionCompleted,
  publishSessionDelta,
  publishSessionStarted,
} from '../domain/session-stream';
import { extractQuestionText } from '../domain/session-transcripts';
import { getMemorySnapshot } from '../shared/diagnostics';
import {
  createErrorResponse,
  DispatchCeilingExceededError,
  getDispatchCeilingBytes,
  getRequestHeaderMap,
  getEffectiveTargetBytes,
  readCappedResponseText,
  waitForStreamDemand,
} from '../shared/http';
import { logEvent, summarizeLogHeaders, truncateLogText } from '../shared/log';
import { parseRateLimitSignal } from '../shared/rate-limit';
import { runWithRequestContext } from '../shared/request-context';
import { findToolCallLeak } from './tool-call-integrity';
import { recordUsageEvent, type UsageSnapshot } from '../domain/usage';

interface OpenAIMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface CacheableTextBlock {
  cache_control?: { type: 'ephemeral' };
  text: string;
  type: 'text';
}

const MIN_AUTO_CACHE_TEXT_LENGTH = 1024;
const MAX_STREAM_FRAME_LENGTH = 1_000_000;
/**
 * Characters of reply text held while a turn is streaming.
 *
 * The gateway only needs the finished answer for the transcript, so the buffer
 * is capped: past this point the oldest chunks are dropped and the stored turn
 * keeps the tail. Without a cap a single long answer would grow with the model's
 * output size instead of with the request.
 */
const MAX_ANSWER_CHARS = 200_000;
/**
 * Ceiling when an SSE reply has to be folded into a single JSON body.
 *
 * The upstream is always asked for `stream: true`, so a non-streaming caller
 * still receives an SSE body that has to be buffered in full. `.text()` has no
 * limit; a misbehaving upstream would be held entirely in memory.
 */
const MAX_AGGREGATED_STREAM_BYTES = 8 * 1024 * 1024;
/**
 * How much assistant prose is inspected for a tool call that escaped into text.
 *
 * The marker carries no relation to answer length: a model that loses its call
 * writes the markup at the start of its turn, then usually stops. Bounding the
 * scan keeps the check O(1) in the size of a legitimate answer.
 */
const TOOL_LEAK_SCAN_CHARS = 20_000;
/**
 * Hard ceiling for in-request credential rotation. Rotation keeps the requested
 * model and only swaps the account, walking every untried credential: each retry
 * excludes the accounts already used, and credential selection returns nothing
 * once the pool is exhausted. The real attempt count is therefore the number of
 * eligible credentials; this constant only guards against an unbounded loop.
 */
const MAX_UPSTREAM_ATTEMPTS = 16;
const CODEBUDDY_CLI_VERSION = '2.137.1';
const CODEBUDDY_USER_AGENT = `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`;

export interface ChatRequestBody {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: unknown;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  thinking?: Record<string, unknown>;
  reasoning_effort?: string;
}

interface ChatStreamDelta {
  content?: string;
  role?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      arguments?: string;
      name?: string;
    };
  }>;
}

interface ChatStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  error?: unknown;
  model?: string;
  usage?: unknown;
  choices?: Array<{
    delta?: ChatStreamDelta;
    finish_reason?: string | null;
    index?: number;
  }>;
}

type ToolCallChunk = NonNullable<ChatStreamDelta['tool_calls']>[number];

interface ToolCallMapping {
  id: string;
  index: number;
}

interface ToolCallNormalizationState {
  mappings: Map<string, ToolCallMapping>;
  nextIndex: number;
  /**
   * Ids of tool calls whose opening chunk already carried `function.name`.
   *
   * The schema only allows the name on the chunk that opens a call; echoing it
   * (or echoing `''`) on later chunks makes a strict reader either re-declare
   * the call or clear the name it already collected.
   */
  namedToolCalls: Set<string>;
}

interface ResolvedAuth {
  type: 'bearer';
  bearerToken: string;
  userId: string;
  credentialData: Record<string, unknown>;
}

export interface ProxyContext {
  accessKeyId: string | null;
  accessKeyName: string | null;
  auth: ResolvedAuth;
  credentialFilename: string | null;
  /**
   * Model name the client asked for, before the access key alias table is
   * applied. `null` when the caller sent no model at all.
   */
  requestedModel?: string | null;
  /**
   * Model name that must be sent upstream (the alias target when the access key
   * declares one). Credential filtering and usage accounting both use this name.
   */
  resolvedModel?: string | null;
  /**
   * Measured once at the request entry point. The usage recorders run inside
   * stream callbacks that no longer hold the request or body, so anything the
   * usage rows need from the request has to travel on the context.
   */
  requestDetails: ProxyRequestDetails;
  preferences: {
    firstMessageRoleToSystem: boolean;
    firstSystemMessageRoleToUser: boolean;
    upstreamProtocol: 'chat' | 'responses';
  };
}

export interface ProxyRequestDetails {
  /** Upstream conversation id, present when the caller sends `x-conversation-id`. */
  conversationId: string | null;
  /** Characters of the prompt as sent upstream. */
  promptChars: number;
  /**
   * The user prompt that triggered this turn. Lifted onto the context because
   * the stream callbacks that publish session events no longer hold the request
   * body, and the transcript recorder needs a readable question.
   */
  question: string;
}

const toProxyRequestDetails = (
  request: NextRequest,
  body?: object,
): ProxyRequestDetails => {
  const incoming = getRequestHeaderMap(request.headers);
  const conversationId = incoming['x-conversation-id']?.trim();

  return {
    conversationId: conversationId ? conversationId : null,
    promptChars: body ? measurePromptChars(body) : 0,
    question: extractQuestionText(body),
  };
};

export interface DiscoveredModel {
  displayName: string;
  id: string;
}

const getCredentialAffinityKey = (
  request: NextRequest,
  accessKeyId: string | null,
): string | undefined => {
  const incoming = getRequestHeaderMap(request.headers);
  const conversationId = incoming['x-conversation-id']?.trim();

  if (!conversationId) {
    return undefined;
  }

  if (accessKeyId) {
    return `access-key:${accessKeyId}:conversation:${conversationId}`;
  }

  return `global:conversation:${conversationId}`;
};

const toUsageSnapshot = (usage: unknown): UsageSnapshot | null => {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  return usage as UsageSnapshot;
};

const recordProxyUsage = async ({
  completionChars,
  model,
  proxyContext,
  route,
  usage,
}: {
  completionChars?: number;
  model: string;
  proxyContext: ProxyContext;
  route: string;
  usage: unknown;
}): Promise<void> => {
  try {
    await recordUsageEvent({
      accessKeyId: proxyContext.accessKeyId,
      accessKeyName: proxyContext.accessKeyName,
      completionChars: completionChars ?? 0,
      conversationId: proxyContext.requestDetails.conversationId,
      credentialFilename: proxyContext.credentialFilename,
      model,
      promptChars: proxyContext.requestDetails.promptChars,
      route,
      usage: toUsageSnapshot(usage) ?? {},
    });
  } catch (error) {
    // Billing is a downstream step: the failure has to be visible on its own
    // line, otherwise a broken usage write is indistinguishable from a broken
    // upstream call in the caller-facing error.
    void logEvent({
      level: 'ERROR',
      message: 'Failed to record proxy usage',
      payload: {
        ...getMemorySnapshot(),
        accessKeyId: proxyContext.accessKeyId,
        credentialFilename: proxyContext.credentialFilename,
        error: error instanceof Error ? error.message : error,
        model,
        route,
      },
    });

    throw error;
  }
};

/**
 * Counts the characters the caller sends and receives. Token counts come from
 * upstream, but they carry no notion of the conversation, so the raw sizes are
 * what ties a usage row back to a session.
 */
const countMessageChars = (value: unknown): number => {
  if (typeof value === 'string') {
    return value.length;
  }

  if (!Array.isArray(value)) {
    return 0;
  }

  return value.reduce((total, item) => {
    const record =
      item && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : null;

    if (!record) {
      return total;
    }

    return (
      total + countMessageChars(record.text ?? record.content ?? record.data)
    );
  }, 0);
};

const measurePromptChars = (body: Record<string, unknown> | object): number => {
  const record = body as Record<string, unknown>;
  const messages = record.messages ?? record.input;

  return countMessageChars(messages);
};

const measureCompletionChars = (text: unknown): number =>
  typeof text === 'string' ? text.length : 0;

const extractResponsesUsage = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as {
    response?: {
      usage?: unknown;
    };
    usage?: unknown;
  };

  return payload.response?.usage ?? payload.usage ?? null;
};

const mapResponsesUsageToChat = (
  usage: unknown,
): Record<string, unknown> | null => {
  if (!usage || typeof usage !== 'object') return null;

  const value = usage as {
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    input_tokens?: unknown;
    input_tokens_details?: {
      cache_creation_tokens?: unknown;
      cached_tokens?: unknown;
    };
    output_tokens?: unknown;
    output_tokens_details?: {
      reasoning_tokens?: unknown;
    };
    total_tokens?: unknown;
  };
  const inputTokens = Number(value.input_tokens ?? 0);
  const outputTokens = Number(value.output_tokens ?? 0);
  const cachedTokens = Number(
    value.input_tokens_details?.cached_tokens ??
      value.cache_read_input_tokens ??
      0,
  );
  const cacheCreationTokens = Number(
    value.input_tokens_details?.cache_creation_tokens ??
      value.cache_creation_input_tokens ??
      0,
  );
  const reasoningTokens = Number(
    value.output_tokens_details?.reasoning_tokens ?? 0,
  );

  return {
    completion_tokens: outputTokens,
    completion_tokens_details: {
      reasoning_tokens: reasoningTokens,
    },
    prompt_tokens: inputTokens,
    prompt_tokens_details: {
      cache_creation_tokens: cacheCreationTokens,
      cached_tokens: cachedTokens,
    },
    total_tokens: Number(value.total_tokens ?? inputTokens + outputTokens),
  };
};

const extractResponsesId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const payload = value as {
    id?: unknown;
    response?: { id?: unknown };
  };
  const id = payload.response?.id ?? payload.id;
  return typeof id === 'string' && id ? id : null;
};

/**
 * Upstream can report a rejection as an in-stream error frame while the HTTP
 * status stays 200, which would otherwise leave no server-side trace at all.
 */
const describeStreamError = (failure: unknown, fallback: string): string => {
  if (typeof failure === 'string' && failure) {
    return failure;
  }

  if (failure && typeof failure === 'object') {
    const message = (failure as { message?: unknown }).message;

    if (typeof message === 'string' && message) {
      return message;
    }

    try {
      return JSON.stringify(failure);
    } catch {
      return fallback;
    }
  }

  return fallback;
};

const extractStreamErrorEvent = (
  value: unknown,
): { detail: string; type: string | null } | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as {
    error?: unknown;
    response?: unknown;
    type?: unknown;
  };
  const failure =
    payload.error ??
    (payload.response && typeof payload.response === 'object'
      ? (payload.response as { error?: unknown }).error
      : undefined);
  const type = typeof payload.type === 'string' ? payload.type : null;
  const isErrorType =
    type === 'error' || type === 'response.failed' || type === 'response.error';

  if (!failure && !isErrorType) {
    return null;
  }

  return {
    detail: describeStreamError(failure, type ?? 'unknown upstream error'),
    type,
  };
};

const parseUsageHeader = (response: Response): unknown => {
  const usageHeader = response.headers.get('x-codebuddy-usage');

  if (!usageHeader) {
    return null;
  }

  try {
    return JSON.parse(usageHeader) as unknown;
  } catch {
    return null;
  }
};

const trackResponsesUsageStream = async ({
  fallbackUsage,
  model,
  onResponseId,
  proxyContext,
  upstreamResponse,
}: {
  fallbackUsage: unknown;
  model: string;
  onResponseId?: (responseId: string) => Promise<void>;
  proxyContext: ProxyContext;
  upstreamResponse: Response;
}): Promise<Response> => {
  if (!upstreamResponse.body) {
    await recordProxyUsage({
      model,
      proxyContext,
      route: '/v1/responses',
      usage: fallbackUsage,
    });

    return new Response(null, {
      headers: upstreamResponse.headers,
      status: upstreamResponse.status,
    });
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  let latestUsage = fallbackUsage;
  let responseBinding: Promise<void> | null = null;
  let usageRecorded = false;
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };
  const recordStreamUsage = async (): Promise<void> => {
    if (usageRecorded) return;
    usageRecorded = true;
    try {
      await recordProxyUsage({
        model,
        proxyContext,
        route: '/v1/responses',
        usage: latestUsage,
      });
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to record Responses stream usage', {
        error,
        route: '/v1/responses',
      });
    }
  };
  const bindResponseId = (id: string): Promise<void> => {
    if (!onResponseId) return Promise.resolve();
    responseBinding ??= onResponseId(id).catch((error) => {
      console.error(
        '[CodeBuddy2API] Failed to bind upstream Responses session',
        {
          error,
          responseId: id,
        },
      );
    });
    return responseBinding;
  };
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      let responseId: string | null = null;

      const inspectFrame = async (frame: string): Promise<void> => {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }

          const raw = line.slice(5).trim();

          if (!raw || raw === '[DONE]') {
            continue;
          }

          try {
            const event = JSON.parse(raw) as unknown;
            const streamError = extractStreamErrorEvent(event);

            if (streamError) {
              void logEvent({
                level: 'WARN',
                message: 'Upstream Responses stream reported an error frame',
                payload: {
                  credentialFilename: proxyContext.credentialFilename,
                  detail: truncateLogText(streamError.detail),
                  eventType: streamError.type,
                  model,
                  route: '/v1/responses',
                },
              });
            }

            latestUsage = extractResponsesUsage(event) ?? latestUsage;
            responseId = extractResponsesId(event) ?? responseId;
            if (responseId) await bindResponseId(responseId);
          } catch {
            // Preserve malformed upstream frames without recording them.
          }
        }
      };

      const pump = async (): Promise<void> => {
        while (true) {
          const { done, value } = await upstreamReader.read();

          if (cancelled) {
            return;
          }

          if (done) {
            if (buffer) {
              await inspectFrame(buffer);
              await waitForStreamDemand(controller, () => cancelled);
              controller.enqueue(encoder.encode(buffer));
            }

            await recordStreamUsage();
            await responseBinding;
            releaseReader();
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          buffer += text;
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
            buffer = '';
          }

          for (const frame of frames) {
            if (frame.length > MAX_STREAM_FRAME_LENGTH) {
              continue;
            }
            await inspectFrame(frame);
            if (cancelled) return;
            await waitForStreamDemand(controller, () => cancelled);
            if (cancelled) return;
            controller.enqueue(encoder.encode(`${frame}\n\n`));
          }
        }
      };

      void pump().catch(async (error) => {
        if (cancelled) return;
        console.error('[CodeBuddy2API] Responses upstream stream failed', {
          error,
          route: '/v1/responses',
        });
        await responseBinding;
        await recordStreamUsage();
        releaseReader();
        controller.error(error);
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      try {
        await reader?.cancel(reason);
      } finally {
        await responseBinding;
        await recordStreamUsage();
        releaseReader();
      }
    },
  });

  return new Response(stream, {
    headers: upstreamResponse.headers,
    status: upstreamResponse.status,
  });
};

const logUpstreamFailure = ({
  attempt,
  channelHeaders,
  credentialFilename,
  detail,
  elapsedMs,
  error,
  model,
  requestHeaders,
  responseHeaders,
  route,
  status,
  stream,
  url,
}: {
  attempt?: number;
  credentialFilename?: string | null;
  detail?: string;
  elapsedMs?: number;
  error?: unknown;
  model?: string;
  /**
   * Historical field kept for the outer catch blocks, which have no header set
   * in hand. The channel-relevant comparison rides on `channelHeaders`.
   */
  requestHeaders?: Record<string, string>;
  /**
   * Headers the channel check most likely reads, from the attempt that failed.
   * Compared against `Upstream request accepted` to find what differs.
   */
  channelHeaders?: Record<string, string>;
  responseHeaders?: Headers;
  route: string;
  status?: number;
  stream?: boolean;
  url: string;
}): void => {
  const payload: Record<string, unknown> = {
    route,
    url,
  };

  if (requestHeaders) {
    payload.requestHeaders = requestHeaders;
  }

  if (channelHeaders) {
    payload.channelHeaders = channelHeaders;
  }

  if (typeof attempt === 'number') {
    payload.attempt = attempt;
  }

  if (credentialFilename) {
    payload.credentialFilename = credentialFilename;
  }

  if (typeof status === 'number') {
    payload.status = status;
  }

  if (typeof elapsedMs === 'number') {
    payload.elapsedMs = elapsedMs;
  }

  if (model) {
    payload.model = model;
  }

  if (typeof stream === 'boolean') {
    payload.stream = stream;
  }

  const upstreamHeaders = summarizeLogHeaders(responseHeaders);

  if (upstreamHeaders) {
    payload.upstreamHeaders = upstreamHeaders;
  }

  if (detail) {
    payload.detail = truncateLogText(detail);
  }

  if (error) {
    payload.error = error;
  }

  // Memory rides along with the failure so a crash that follows a burst of
  // failures can be read from the same stream without a metrics backend.
  Object.assign(payload, getMemorySnapshot());

  void logEvent({
    level: 'ERROR',
    message: 'Upstream request failed',
    payload,
  });
};

/**
 * Continues the same client request on another credential while keeping the
 * requested model unchanged. Returns null when rotation is disabled or when the
 * pool holds no untried credential left, which ends the retry loop.
 */
const rotateToNextCredential = async ({
  allowRotation,
  context,
  model,
  reason,
  request,
  requestBody,
  triedFilenames,
}: {
  allowRotation: boolean;
  context: ProxyContext;
  model?: string;
  reason: string;
  request: NextRequest;
  requestBody?: object;
  triedFilenames: string[];
}): Promise<ProxyContext | null> => {
  if (!allowRotation) {
    return null;
  }

  try {
    const nextContext = await resolveProxyContext(request, model, requestBody, {
      excludeCredentialFilenames: triedFilenames,
    });
    const nextFilename = nextContext.credentialFilename;

    // Rotation has to land on a genuinely different account: retrying the one
    // that just failed would burn an attempt without changing the outcome.
    if (!nextFilename || nextFilename === context.credentialFilename) {
      void logEvent({
        level: 'WARN',
        message: 'No credential available for rotation retry',
        payload: {
          fromCredentialFilename: context.credentialFilename,
          reason,
        },
      });

      return null;
    }

    void logEvent({
      level: 'WARN',
      message: 'Retrying upstream request with another credential',
      payload: {
        fromCredentialFilename: context.credentialFilename,
        reason,
        triedCredentialFilenames: triedFilenames,
        toCredentialFilename: nextFilename,
      },
    });

    return nextContext;
  } catch (error) {
    void logEvent({
      level: 'WARN',
      message: 'No credential available for rotation retry',
      payload: {
        fromCredentialFilename: context.credentialFilename,
        reason: error instanceof Error ? error.message : error,
      },
    });

    return null;
  }
};

/**
 * Upstream refusal that means "this call did not look like it came from an
 * official client", rather than "this credential is out of quota".
 *
 * `code: 11128` ("Illegal API invocation from an unapproved channel") is
 * answered before the request is routed to a model, and it is probabilistic:
 * production logged 55 successes and 46 refusals for byte-identical request
 * shapes in the same hour. Treating it as a terminal 400 turned one unlucky
 * draw into a user-visible failure, and the client's own retry then re-sent the
 * whole body — the 43-errors-per-minute bursts in the logs.
 *
 * It is deliberately *not* a rate limit: the credential is healthy, so it is
 * not marked limited, it is only skipped for this one call.
 */
const CHANNEL_REJECTION_CODE = 11128;
const CHANNEL_REJECTION_PATTERN = /unapproved channel/i;
const MAX_CHANNEL_REJECTION_RETRIES = 2;

const isChannelRejection = (detail: string | undefined): boolean => {
  if (!detail) {
    return false;
  }

  if (CHANNEL_REJECTION_PATTERN.test(detail)) {
    return true;
  }

  try {
    const payload = JSON.parse(detail) as { code?: unknown };

    return payload.code === CHANNEL_REJECTION_CODE;
  } catch {
    return false;
  }
};

/**
 * Marks the credential behind a failed upstream call as rate limited so the
 * next request rotates away from it. Only HTTP 429 counts: treating 5xx or
 * network failures as limits would blacklist every credential on an upstream
 * outage.
 *
 * When `allowRotation` is set, the same client request continues on another
 * credential. The upstream answers 429 before any byte reaches the caller, so
 * both streaming and non-streaming requests can be retried safely.
 */ const handleUpstreamRateLimit = async ({
  allowRotation,
  context,
  detail,
  model,
  request,
  requestBody,
  responseHeaders,
  status,
  triedFilenames,
}: {
  allowRotation: boolean;
  context: ProxyContext;
  detail: string;
  model?: string;
  request: NextRequest;
  requestBody?: object;
  responseHeaders: Headers;
  status: number;
  triedFilenames: string[];
}): Promise<ProxyContext | null> => {
  const signal = parseRateLimitSignal({
    detail,
    maxCooldownMs: await getCredentialLimitCooldownMs(),
    retryAfter: responseHeaders.get('retry-after'),
    status,
  });

  if (!signal) {
    return null;
  }

  if (context.credentialFilename) {
    try {
      await markCredentialLimited({
        code: signal.code,
        filename: context.credentialFilename,
        kind: signal.kind,
        reason: signal.reason,
        resumeAt: signal.resumeAt,
        status,
      });
    } catch (error) {
      void logEvent({
        level: 'WARN',
        message: 'Failed to mark credential as rate limited',
        payload: {
          credentialFilename: context.credentialFilename,
          error,
          status,
        },
      });
    }
  }

  return rotateToNextCredential({
    allowRotation,
    context,
    model,
    reason: `rate limited until ${new Date(signal.resumeAt).toISOString()}`,
    request,
    requestBody,
    triedFilenames,
  });
};

interface UpstreamPlan {
  body: unknown;
  headers: Headers;
  url: string;
}

interface UpstreamCallResult {
  attempts: number;
  context: ProxyContext;
  detail?: string;
  response: Response;
}

/**
 * Upper bound for waiting on the upstream response headers. Only the header
 * wait is bounded: once the upstream starts answering, a streaming body may
 * legitimately run for minutes, so the timer is cleared as soon as `fetch`
 * resolves.
 */
const DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS = 60_000;
const UPSTREAM_RESPONSE_TIMEOUT_ENV = 'CODEBUDDY_UPSTREAM_TIMEOUT_MS';

const getUpstreamResponseTimeoutMs = (): number => {
  const raw = Number(process.env[UPSTREAM_RESPONSE_TIMEOUT_ENV] ?? '');

  return Number.isFinite(raw) && raw >= 1_000
    ? Math.round(raw)
    : DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS;
};

/** Our own abort timer is the only source of an AbortError on this path. */
const isUpstreamTimeout = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const buildUpstreamTimeoutResponse = (
  timeoutMs: number,
  attempts = 1,
): Response =>
  new Response(
    JSON.stringify({
      error: {
        message:
          `Upstream did not respond within ${timeoutMs}ms` +
          ` (after ${attempts} credential attempt(s))`,
        type: 'upstream_timeout',
      },
    }),
    {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      status: 504,
    },
  );

/**
 * Reports the end of every streaming response.
 *
 * A stream can end in three ways — upstream finished, client hung up, upstream
 * errored — and none of them used to leave a trace, so a request that died
 * mid-stream looked exactly like one that never arrived. The byte count and
 * duration also tell a truncated answer apart from a short one, and the memory
 * sample tells whether the stream was the reason the process grew.
 */
const instrumentStreamResponse = (
  response: Response,
  meta: {
    credentialFilename?: string | null;
    model: string;
    route: string;
  },
): Response => {
  const body = response.body;

  if (!body) return response;

  const reader = body.getReader();
  const startedAt = Date.now();
  let bytes = 0;
  let finished = false;

  const logFinished = (outcome: 'cancelled' | 'completed' | 'failed'): void => {
    if (finished) return;

    finished = true;
    void logEvent({
      level: outcome === 'failed' ? 'ERROR' : 'INFO',
      message: 'Response stream finished',
      payload: {
        ...getMemorySnapshot(),
        bytes,
        credentialFilename: meta.credentialFilename ?? null,
        durationMs: Date.now() - startedAt,
        model: meta.model,
        outcome,
        route: meta.route,
      },
    });
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      async cancel(reason) {
        logFinished('cancelled');
        await reader.cancel(reason);
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            logFinished('completed');
            controller.close();
            return;
          }

          bytes += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          logFinished('failed');
          controller.error(error);
        }
      },
    }),
    {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
};

/**
 * Turns the final upstream failure into a response that explains why the
 * request failed, in the field clients actually render.
 *
 * A throttled credential is answered with a payload such as
 * `{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-20 10:55:51 UTC+8 重置，您也可以切换其他模型继续使用。"}`
 * and the pool then rotates. When *every* eligible account is throttled the
 * rotated request still ends in a bare 429 whose detail is a nested JSON
 * string, so a caller only sees "Upstream CodeBuddy request failed" and has no
 * way to tell that the accounts are out of quota rather than the model being
 * broken. This folds the upstream reason, the number of accounts tried and the
 * recovery instant into `error.message`, repeats them as structured fields and
 * adds `Retry-After`.
 */
const buildUpstreamErrorResponse = async ({
  attempts,
  detail,
  response,
}: {
  attempts: number;
  detail?: string;
  response: Response;
}): Promise<Response> => {
  if (response.status !== 429) {
    return createErrorResponse(
      response.status,
      'Upstream CodeBuddy request failed',
      detail,
    );
  }

  const signal = parseRateLimitSignal({
    detail,
    maxCooldownMs: await getCredentialLimitCooldownMs(),
    retryAfter: response.headers.get('retry-after'),
    status: response.status,
  });
  const resumeAt = signal?.resumeAt ?? Date.now();
  const resumeAtIso = new Date(resumeAt).toISOString();
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((resumeAt - Date.now()) / 1_000),
  );
  const reason = signal?.reason ?? 'upstream rate limit';
  // A pinned caller only ever gets one credential tried, so claiming "all" of
  // them are limited would be wrong there.
  const exhaustion =
    attempts > 1
      ? `All ${attempts} tried credentials are rate limited`
      : 'The upstream credential is rate limited';
  const message =
    `${exhaustion}. Earliest recovery at ${resumeAtIso}.` +
    ` Upstream said: ${reason}`;

  return createErrorResponse(
    response.status,
    message,
    {
      attempts,
      reason,
      resumeAt: resumeAtIso,
      retryAfterSeconds,
      upstreamDetail: detail ?? null,
    },
    {
      code: 'upstream_credentials_exhausted',
      headers:
        retryAfterSeconds > 0
          ? { 'Retry-After': String(retryAfterSeconds) }
          : undefined,
      type: 'rate_limit_error',
    },
  );
};

/**
 * Calls the upstream and, while attempts remain, rotates to another credential
 * whenever the answer is a rate limit or the upstream stops responding. The
 * result always carries the credential that produced the returned response,
 * because the caller records usage and stream bindings against it.
 */
const fetchUpstreamWithRotation = async ({
  buildPlan,
  debugTrace,
  initialContext,
  model,
  request,
  requestBody,
  rotationEnabled,
  route,
  stream,
}: {
  buildPlan: (context: ProxyContext) => Promise<UpstreamPlan>;
  debugTrace?: DebugTrace;
  initialContext: ProxyContext;
  model?: string;
  request: NextRequest;
  requestBody?: object;
  rotationEnabled: boolean;
  route: string;
  stream?: boolean;
}): Promise<UpstreamCallResult> => {
  const maxAttempts = rotationEnabled ? MAX_UPSTREAM_ATTEMPTS : 1;
  const timeoutMs = getUpstreamResponseTimeoutMs();
  const triedFilenames = initialContext.credentialFilename
    ? [initialContext.credentialFilename]
    : [];
  let context = initialContext;
  let attempts = 0;
  let channelRetries = 0;

  for (;;) {
    attempts += 1;
    const plan = await buildPlan(context);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    const payloadText = JSON.stringify(plan.body);
    // Byte length, not string length: every number in this pipeline is a byte
    // count, and comparing a `.length` here against the cap logs produced the
    // "the body is under the limit but the socket disagrees" confusion that
    // cost a day of debugging CJK traffic.
    const payloadBytes = Buffer.byteLength(payloadText, 'utf8');

    void logEvent({
      level: 'DEBUG',
      message: 'Upstream request dispatched',
      payload: {
        ...getMemorySnapshot(),
        attempt: attempts,
        credentialFilename: context.credentialFilename,
        model,
        // The one measurement taken after every size stage has run, so this is
        // the number that can be compared against the cap that would refuse it.
        payloadBytes,
        route,
        stream,
        targetBytes: getEffectiveTargetBytes(),
        timeoutMs,
        url: plan.url,
      },
    });

    try {
      response = enqueueUpstreamResponseSnapshot(
        debugTrace,
        await fetch(plan.url, {
          body: payloadText,
          cache: 'no-store',
          headers: plan.headers,
          method: 'POST',
          signal: controller.signal,
        }),
      );
    } catch (error) {
      if (!isUpstreamTimeout(error)) {
        // Connection errors keep their historical behaviour: surface them as an
        // unexpected upstream failure instead of silently rotating away.
        throw error;
      }

      const elapsedMs = Date.now() - startedAt;

      void logEvent({
        level: 'WARN',
        message:
          'Upstream request timed out while waiting for response headers',
        payload: {
          attempt: attempts,
          credentialFilename: context.credentialFilename,
          elapsedMs,
          error: error instanceof Error ? error.message : error,
          model,
          route,
          stream,
          timeoutMs,
          url: plan.url,
        },
      });

      // A hung account is exactly what rotation exists for: keep the model and
      // continue on another credential instead of leaving the caller waiting.
      const retryContext = await rotateToNextCredential({
        allowRotation: attempts < maxAttempts,
        context,
        model,
        reason: `upstream timeout after ${elapsedMs}ms`,
        request,
        requestBody,
        triedFilenames,
      });

      if (!retryContext) {
        return {
          attempts,
          context,
          detail: `Upstream did not respond within ${timeoutMs}ms`,
          response: buildUpstreamTimeoutResponse(timeoutMs, attempts),
        };
      }

      if (retryContext.credentialFilename) {
        triedFilenames.push(retryContext.credentialFilename);
      }

      context = retryContext;
      continue;
    } finally {
      // Clearing here keeps long streaming bodies alive: the abort timer only
      // covers the wait for response headers.
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      // Recorded on success too: the channel check can reject a call that looks
      // identical to one it just accepted, and only a side-by-side of the two
      // header sets shows which field differed.
      void logEvent({
        level: 'INFO',
        message: 'Upstream request accepted',
        payload: {
          attempt: attempts,
          channelHeaders: describeChannelHeaders(plan.headers),
          credentialFilename: context.credentialFilename,
          model,
          route,
          status: response.status,
        },
      });
      logUpstreamSuccess({
        credentialFilename: context.credentialFilename,
        elapsedMs: Date.now() - startedAt,
        model,
        route,
        status: response.status,
        stream,
        url: plan.url,
      });

      return { attempts, context, response };
    }

    const detail = await response.text();

    logUpstreamFailure({
      attempt: attempts,
      credentialFilename: context.credentialFilename,
      detail,
      elapsedMs: Date.now() - startedAt,
      model,
      channelHeaders: describeChannelHeaders(plan.headers),
      responseHeaders: response.headers,
      route,
      status: response.status,
      stream,
      url: plan.url,
    });

    const nextContext = await handleUpstreamRateLimit({
      allowRotation: attempts < maxAttempts,
      context,
      detail,
      model,
      request,
      requestBody,
      responseHeaders: response.headers,
      status: response.status,
      triedFilenames,
    });

    if (nextContext) {
      if (nextContext.credentialFilename) {
        triedFilenames.push(nextContext.credentialFilename);
      }

      context = nextContext;
      continue;
    }

    // A channel rejection is not a rate limit — the credential is fine, the
    // draw was unlucky — so it gets its own small retry budget on another
    // account instead of becoming the caller's 400.
    if (
      channelRetries < MAX_CHANNEL_REJECTION_RETRIES &&
      attempts < maxAttempts &&
      isChannelRejection(detail)
    ) {
      channelRetries += 1;

      const retryContext = await rotateToNextCredential({
        allowRotation: true,
        context,
        model,
        reason: `upstream rejected the channel (code ${CHANNEL_REJECTION_CODE})`,
        request,
        requestBody,
        triedFilenames,
      });

      if (retryContext) {
        if (retryContext.credentialFilename) {
          triedFilenames.push(retryContext.credentialFilename);
        }

        context = retryContext;
        continue;
      }
    }

    return { attempts, context, detail, response };
  }
};

/**
 * Response headers slower than this are reported at WARN.
 *
 * `elapsedMs` here is time-to-first-byte: for a streaming reply the caller sees
 * its first token at roughly this moment, so it is the number that explains
 * "the answer takes forever to start". Recording it only when it is bad keeps
 * normal traffic quiet while making a slow period diagnosable without raising
 * the log level to DEBUG.
 */
/**
 * Lower bound on the conversation budget handed to `compressMessages`.
 *
 * Half the dispatch target. See the comment where it is used: without a floor,
 * a body whose tool definitions alone exceed the target leaves a budget of zero
 * and the history is never touched.
 */
const MIN_MESSAGE_BUDGET_BYTES = 512 * 1024;

const SLOW_UPSTREAM_HEADER_MS = 5_000;

const logUpstreamSuccess = ({
  credentialFilename,
  elapsedMs,
  model,
  route,
  status,
  stream,
  url,
}: {
  credentialFilename?: string | null;
  elapsedMs: number;
  model?: string;
  route: string;
  status: number;
  stream?: boolean;
  url: string;
}): void => {
  void logEvent({
    level: 'DEBUG',
    message: 'Upstream request completed',
    payload: {
      ...getMemorySnapshot(),
      credentialFilename: credentialFilename ?? null,
      elapsedMs,
      model: model ?? null,
      route,
      status,
      stream: typeof stream === 'boolean' ? stream : null,
      url,
    },
  });

  if (elapsedMs >= SLOW_UPSTREAM_HEADER_MS) {
    void logEvent({
      level: 'WARN',
      message: 'Upstream response headers were slow',
      payload: {
        credentialFilename: credentialFilename ?? null,
        elapsedMs,
        model: model ?? null,
        route,
        status,
        stream: typeof stream === 'boolean' ? stream : null,
        thresholdMs: SLOW_UPSTREAM_HEADER_MS,
        url,
      },
    });
  }
};

const hasPromptCacheControl = (content: unknown): boolean => {
  return (
    Array.isArray(content) &&
    content.some(
      (part) => !!part && typeof part === 'object' && 'cache_control' in part,
    )
  );
};

const createCacheableTextBlock = (text: string): CacheableTextBlock => ({
  type: 'text',
  text,
  cache_control: { type: 'ephemeral' },
});

const addPromptCacheControl = (message: OpenAIMessage): OpenAIMessage => {
  if (
    typeof message.content === 'string' &&
    message.content.trim().length >= MIN_AUTO_CACHE_TEXT_LENGTH
  ) {
    return {
      ...message,
      content: [createCacheableTextBlock(message.content)],
    };
  }

  if (Array.isArray(message.content)) {
    const textIndex = message.content.findIndex(
      (part) =>
        !!part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string' &&
        (part as { text: string }).text.trim().length >=
          MIN_AUTO_CACHE_TEXT_LENGTH,
    );

    if (textIndex >= 0) {
      return {
        ...message,
        content: message.content.map((part, index) =>
          index === textIndex && part && typeof part === 'object'
            ? {
                ...part,
                cache_control: { type: 'ephemeral' },
              }
            : part,
        ),
      };
    }
  }

  return message;
};

const applyPromptCacheControl = (
  messages: OpenAIMessage[],
): OpenAIMessage[] => {
  const explicitCacheControl = messages.some((message) =>
    hasPromptCacheControl(message.content),
  );

  if (explicitCacheControl) {
    return messages;
  }

  const cacheableIndexes = new Set<number>();
  const systemIndex = messages.findIndex(
    (message) => message.role === 'system',
  );

  if (systemIndex >= 0) {
    cacheableIndexes.add(systemIndex);
  }

  let lastUserIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex >= 0) {
    cacheableIndexes.add(lastUserIndex);
  }

  if (cacheableIndexes.size === 0) {
    return messages;
  }

  return messages.map((message, index) =>
    cacheableIndexes.has(index) ? addPromptCacheControl(message) : message,
  );
};

const normalizeMessages = (
  messages: OpenAIMessage[],
  firstMessageRoleToSystem: boolean,
  firstSystemMessageRoleToUser: boolean,
): OpenAIMessage[] => {
  // An assistant turn that only asks for tools carries `tool_calls` and no
  // `content` at all — the OpenAI schema allows it, and clients built on
  // `omitzero`-style serialization (Go's openai-go SDK, for one) leave the key
  // out entirely rather than sending `null`. Dropping it here would leave the
  // matching `tool` result orphaned, which upstream rejects as a broken
  // tool_calls/tool-result sequence.
  const filtered = messages.filter(
    (item) =>
      item.role &&
      (item.content !== undefined || item.tool_calls !== undefined),
  );

  const firstSystemIndex = firstSystemMessageRoleToUser
    ? filtered.findIndex((message) => message.role === 'system')
    : -1;
  const normalized = filtered.map((message, index) => {
    if (
      (firstMessageRoleToSystem && message.role === 'developer') ||
      index === firstSystemIndex
    ) {
      return { ...message, role: 'user' };
    }

    return message;
  });

  // Preserve role:'tool' messages so the OpenAI-compatible upstream
  // receives a valid tool_calls/tool-result pair for multi-step tool loops.
  return applyPromptCacheControl(normalized);
};

export const resolveProxyContext = async (
  request: NextRequest,
  model?: string,
  body?: object,
  options?: { excludeCredentialFilenames?: string[] },
): Promise<ProxyContext> => {
  const accessKey = await resolveRequestAccessKey(request);
  const requestedModel =
    typeof model === 'string' && model.trim() ? model.trim() : null;
  const resolvedModel = resolveModelAlias(accessKey?.modelAliases, model);
  const credential = await resolveCredentialForRequest({
    accessKeyId: accessKey?.id,
    affinityKey: getCredentialAffinityKey(request, accessKey?.id ?? null),
    allowedCredentialFilenames: accessKey?.credentialFilenames,
    excludeCredentialFilenames: options?.excludeCredentialFilenames,
    model: resolvedModel,
  });

  if (!credential) {
    throw new Error('No valid CodeBuddy credentials found');
  }

  if (
    requestedModel &&
    resolvedModel &&
    requestedModel !== resolvedModel.trim()
  ) {
    void logEvent({
      level: 'INFO',
      message: 'Model alias resolved',
      payload: {
        accessKeyId: accessKey?.id ?? null,
        credentialFilename: credential.filename,
        requestedModel,
        resolvedModel,
      },
    });
  }

  const bearerToken = String(
    credential.data.bearer_token ?? credential.data.access_token ?? '',
  ).trim();

  if (!bearerToken) {
    throw new Error('Saved credential does not include a bearer token');
  }

  return {
    accessKeyId: accessKey?.id ?? null,
    accessKeyName: accessKey?.name ?? null,
    auth: {
      type: 'bearer',
      bearerToken,
      userId: String(credential.data.user_id ?? 'unknown'),
      credentialData: credential.data,
    },
    credentialFilename: credential.filename,
    preferences: getCredentialProxySettings(credential.data),
    requestDetails: toProxyRequestDetails(request, body),
    requestedModel,
    resolvedModel: resolvedModel ?? null,
  };
};

export const createProxyContextFromCredential = (
  credential: CredentialRecord,
): ProxyContext => {
  const bearerToken = String(
    credential.data.bearer_token ?? credential.data.access_token ?? '',
  ).trim();

  if (!bearerToken) {
    throw new Error('Saved credential does not include a bearer token');
  }

  return {
    accessKeyId: null,
    accessKeyName: null,
    auth: {
      type: 'bearer',
      bearerToken,
      userId: String(credential.data.user_id ?? 'unknown'),
      credentialData: credential.data,
    },
    credentialFilename: credential.filename,
    preferences: getCredentialProxySettings(credential.data),
    // No request in hand on this path, so there is no prompt to attach.
    requestDetails: { conversationId: null, promptChars: 0, question: '' },
  };
};

export const resolveProxyContextByCredentialFilename = async (
  filename: string,
  options?: {
    accessKey?: {
      id?: string | null;
      name?: string | null;
    };
    allowedCredentialFilenames?: string[];
    requireEligible?: boolean;
  },
): Promise<ProxyContext> => {
  const credential = options?.requireEligible
    ? await findEligibleCredentialRecordByFilename(
        filename,
        options.allowedCredentialFilenames,
      )
    : await findCredentialRecordByFilename(filename);

  if (!credential) {
    throw new Error('Selected credential was not found');
  }

  return {
    ...createProxyContextFromCredential(credential),
    accessKeyId: options?.accessKey?.id ?? null,
    accessKeyName: options?.accessKey?.name ?? null,
  };
};

const getCredentialValue = (
  value: unknown,
  candidateKeys: string[],
): string | number | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getCredentialValue(item, candidateKeys);

      if (nested !== null && nested !== '') {
        return nested;
      }
    }

    return null;
  }

  if (value && typeof value === 'object') {
    for (const key of candidateKeys) {
      const direct = (value as Record<string, unknown>)[key];

      if (direct !== undefined && direct !== null && direct !== '') {
        return direct as string | number;
      }
    }

    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      const nested = getCredentialValue(nestedValue, candidateKeys);

      if (nested !== null && nested !== '') {
        return nested;
      }
    }
  }

  return null;
};

const buildUpstreamHeaders = async (
  request: NextRequest,
  auth: ResolvedAuth,
): Promise<HeadersInit> => {
  const baseUrl = new URL(await getCodeBuddyApiEndpoint());
  const incoming = getRequestHeaderMap(request.headers);
  const requestId =
    incoming['x-request-id'] ?? crypto.randomUUID().replaceAll('-', '');
  const conversationId = incoming['x-conversation-id'] ?? crypto.randomUUID();
  const conversationRequestId =
    incoming['x-conversation-request-id'] ??
    crypto.randomUUID().replaceAll('-', '');
  const conversationMessageId =
    incoming['x-conversation-message-id'] ??
    crypto.randomUUID().replaceAll('-', '');
  const headers = new Headers(incoming);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${auth.bearerToken}`);
  headers.set('Content-Type', 'application/json');
  headers.set('Host', baseUrl.host);
  headers.set('User-Agent', CODEBUDDY_USER_AGENT);
  headers.set('X-Agent-Intent', 'craft');
  headers.set('X-Conversation-ID', conversationId);
  headers.set('X-Conversation-Message-ID', conversationMessageId);
  headers.set('X-Conversation-Request-ID', conversationRequestId);
  headers.set('X-IDE-Name', 'CLI');
  headers.set('X-IDE-Type', 'CLI');
  headers.set('X-IDE-Version', CODEBUDDY_CLI_VERSION);
  headers.set('X-Client-Platform', 'web');
  headers.set('X-Product', 'SaaS');
  headers.set('X-Product-Version', CODEBUDDY_CLI_VERSION);
  headers.set('X-Request-ID', requestId);
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('X-User-Id', auth.userId);
  headers.set('x-stainless-arch', process.arch);
  headers.set('x-stainless-lang', 'js');
  headers.set('x-stainless-os', process.platform);
  headers.set('x-stainless-package-version', CODEBUDDY_CLI_VERSION);
  headers.set('x-stainless-retry-count', '0');
  headers.set('x-stainless-runtime', 'node');
  headers.set('x-stainless-runtime-version', process.version);

  const domain = getCredentialValue(auth.credentialData, ['domain']);
  const enterpriseId = getCredentialValue(auth.credentialData, [
    'enterprise_id',
    'enterpriseId',
  ]);
  const tenantId =
    getCredentialValue(auth.credentialData, ['tenant_id', 'tenantId']) ??
    enterpriseId;

  if (domain) {
    headers.set('X-Domain', String(domain));
  }

  if (enterpriseId) {
    headers.set('X-Enterprise-Id', String(enterpriseId));
  }

  if (tenantId) {
    headers.set('X-Tenant-Id', String(tenantId));
  }

  const origin = String(domain ?? '')
    .toLowerCase()
    .endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : 'https://www.codebuddy.cn';
  headers.set('Content-Type', 'application/json');
  headers.set('Origin', origin);
  headers.set('Referer', `${origin}/`);
  headers.set('User-Agent', CODEBUDDY_USER_AGENT);
  headers.set('X-Product', 'SaaS');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('X-IDE-Name', 'CLI');
  headers.set('X-IDE-Type', 'CLI');
  headers.set('X-IDE-Version', CODEBUDDY_CLI_VERSION);

  return headers;
};

/**
 * Headers the channel check is most likely to read.
 *
 * Logged on every success and failure so two calls of the same request shape can
 * be compared line for line when the upstream rejects one for "not sent from an
 * official client". Credentials are not among them; the rest stays readable.
 */
const describeChannelHeaders = (
  headers: HeadersInit,
): Record<string, string> => {
  const record = new Headers(headers);
  const names = [
    'user-agent',
    'x-ide-name',
    'x-ide-type',
    'x-ide-version',
    'x-client-platform',
    'x-product',
    'x-product-version',
    'x-agent-intent',
    'origin',
    'referer',
    'x-requested-with',
    'x-stainless-lang',
    'x-stainless-runtime',
    'x-stainless-package-version',
  ];

  return Object.fromEntries(
    names
      .map((name) => [name, record.get(name)] as const)
      .filter((entry): entry is readonly [string, string] => !!entry[1]),
  );
};

const headersToRecord = (headers: HeadersInit): Record<string, string> => {
  return Object.fromEntries(new Headers(headers).entries());
};

/**
 * Bytes a body occupies once serialised, as the socket will carry it.
 *
 * `JSON.stringify` allocates a string of exactly this size, so it is measured
 * once and then handed to `fetch` rather than being thrown away — the same
 * single copy that has to exist for the request to be sent is also the
 * measurement, instead of a second one alongside it.
 */
const measureBodyBytes = (body: unknown): number => {
  try {
    const encoded = JSON.stringify(body);

    return encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return 0;
  }
};

/**
 * Refuses a body that is still multiples past the target once every stage has
 * run.
 *
 * Past the ceiling the call is not merely large, it is unsendable: the leftover
 * is pinned content — the newest user turn and the system prompt — so handing
 * it to the upstream buys a round trip, burns a credential and comes back as an
 * opaque code ("prompt is too long", or a channel rejection). Answering here
 * names the actual problem instead.
 */
const enforceDispatchCeiling = ({
  bytes,
  keptCount,
  targetBytes,
}: {
  bytes: number;
  keptCount: number;
  targetBytes: number;
}): void => {
  const ceilingBytes = getDispatchCeilingBytes();

  if (bytes <= ceilingBytes) {
    return;
  }

  void logEvent({
    level: 'ERROR',
    message: 'Request exceeds the dispatch ceiling after compression',
    payload: {
      bytesAfter: bytes,
      ceilingBytes,
      overByBytes: bytes - ceilingBytes,
      pinnedMessages: keptCount,
      targetBytes,
    },
  });

  throw new DispatchCeilingExceededError(bytes, ceilingBytes);
};

/**
 * Shrinks a body until it fits the dispatch target, then reports both numbers.
 *
 * The order matters and is not incidental:
 *
 *  1. `pruneToolDefinitions` first — lossless, since a tool the caller forbade
 *     could not have been called anyway.
 *  2. Then the history, with a budget derived from what is *left* of the target
 *     after tools, system prompt and escaping are accounted for. A fixed
 *     message budget cannot do this: the same 96 KiB is comfortable in a
 *     10-tool session and over budget in a 58-tool one.
 *
 * Both a near-miss and a real hit are logged with `bytesBefore`/`bytesAfter`/
 * `targetBytes`. The feature looked inert for months precisely because only
 * the hit path logged, so "never triggered" and "triggered as a no-op" were
 * indistinguishable — and neither number was in bytes, so it could not be
 * compared with the cap that was actually refusing requests.
 */
const applySizeControls = (upstreamBody: ChatRequestBody): void => {
  // Clamped against the reject cap so a mis-set target can only make the
  // compressor more aggressive, never make every request unsendable.
  const targetBytes = getEffectiveTargetBytes();
  const model = String(upstreamBody.model ?? '');

  if (!isHistoryCompressionEnabled()) {
    void logEvent({
      level: 'WARN',
      message:
        'History compression is disabled; oversized bodies will be sent as-is',
      payload: {
        model,
        requestBytes: measureBodyBytes(upstreamBody),
        targetBytes,
      },
    });

    return;
  }

  try {
    const bytesBefore = measureBodyBytes(upstreamBody);

    const prunedTools = pruneToolDefinitions(
      upstreamBody.tools,
      upstreamBody.tool_choice,
    );

    if (prunedTools !== upstreamBody.tools) {
      upstreamBody.tools = prunedTools;

      void logEvent({
        level: 'INFO',
        message: 'Dropped unreachable tool definitions',
        payload: {
          bytesAfterPrune: measureBodyBytes(upstreamBody),
          bytesBeforePrune: bytesBefore,
          model,
          toolChoice: String(upstreamBody.tool_choice),
        },
      });
    }

    if (!upstreamBody.messages?.length) {
      return;
    }

    // What everything except the history costs: tools, model, and the escaped
    // overhead of the envelope. Measured by subtracting the conversation from
    // the whole, which needs no second serializer and stays correct when a
    // field is added to the whitelist above.
    const messagesBytes = measureMessagesBytes(upstreamBody.messages);
    const overheadBytes = Math.max(
      0,
      measureBodyBytes(upstreamBody) - messagesBytes,
    );
    // The conversation's own allowance. It is the target minus whatever the
    // envelope already spends — but never zero: a session whose tool
    // definitions alone exceed the target (131 tools against a 1 MiB target is
    // 1.3 MB of definitions) would otherwise hand `compressMessages` a budget
    // of nothing, and a budget of nothing is not "compress as hard as you can",
    // it is "do not bother" once the pinned tail is bigger than zero.
    //
    // The floor is half the target. It does not guarantee the body fits — when
    // the tools alone are over budget nothing in the history can fix that — but
    // it keeps the history from being left untouched while the session is
    // twenty megabytes of scrollback.
    const budgetBytes = Math.max(
      MIN_MESSAGE_BUDGET_BYTES,
      targetBytes - overheadBytes,
    );

    const compressed = compressMessages(upstreamBody.messages, {
      budgetBytes,
    });

    if (compressed.unchanged) {
      // The near-miss line: how close this request came, in the same unit as
      // the cap that would have refused it.
      void logEvent({
        level: 'DEBUG',
        message: 'Conversation history within budget',
        payload: {
          budgetBytes,
          bytesAfter: compressed.bytesAfter,
          bytesBefore: compressed.bytesBefore,
          headroomBytes: budgetBytes - compressed.bytesBefore,
          messageCount: upstreamBody.messages.length,
          model,
          overheadBytes,
          targetBytes,
        },
      });

      // "Nothing changed" is not the same as "sendable": a body whose only
      // remaining mass is pinned content compresses to itself, and that is
      // exactly the shape the ceiling exists for.
      enforceDispatchCeiling({
        bytes: measureBodyBytes(upstreamBody),
        keptCount: compressed.keptCount,
        targetBytes,
      });

      return;
    }

    upstreamBody.messages = compressed.messages;

    const bytesAfter = measureBodyBytes(upstreamBody);

    void logEvent({
      level: 'INFO',
      message: 'Compressed conversation history',
      payload: {
        budgetBytes,
        bytesAfter,
        bytesAfterMessages: compressed.bytesAfter,
        bytesBefore,
        bytesBeforeMessages: compressed.bytesBefore,
        imagesDropped: compressed.imagesDropped,
        keptCount: compressed.keptCount,
        messageCount: upstreamBody.messages.length,
        model,
        overheadBytes,
        replacedCount: compressed.replacedCount,
        savedBytes: bytesBefore - bytesAfter,
        targetBytes,
        toolResultsElided: compressed.toolResultsElided,
      },
    });

    // A body still over the target after every stage is not an error in
    // itself — production served bodies 15% over it — but it is worth a WARN
    // while it is rare, because it is the shape of the next failure.
    if (bytesAfter > targetBytes) {
      void logEvent({
        level: 'WARN',
        message: 'Request still exceeds the dispatch target after compression',
        payload: {
          bytesAfter,
          overByBytes: bytesAfter - targetBytes,
          pinnedMessages: compressed.keptCount,
          targetBytes,
        },
      });
    }

    enforceDispatchCeiling({
      bytes: bytesAfter,
      keptCount: compressed.keptCount,
      targetBytes,
    });
  } catch (error) {
    // The ceiling is a decision, not a hiccup: rethrow so it reaches the caller
    // as a 413 instead of being swallowed into "sent as-is".
    if (error instanceof DispatchCeilingExceededError) {
      throw error;
    }

    void logEvent({
      level: 'WARN',
      message: 'Conversation compression failed, sending the request as-is',
      payload: {
        detail: error instanceof Error ? error.message : String(error),
        requestBytes: measureBodyBytes(upstreamBody),
        targetBytes,
      },
    });
  }
};

const buildUpstreamBody = async (
  body: ChatRequestBody,
  context: ProxyContext,
): Promise<ChatRequestBody> => {
  const normalizedMessages = normalizeMessages(
    body.messages ?? [],
    context.preferences.firstMessageRoleToSystem,
    context.preferences.firstSystemMessageRoleToUser,
  );
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  const credentialModels = getCredentialSupportedModels(
    context.auth.credentialData,
  );
  const model =
    context.resolvedModel ??
    (typeof body.model === 'string' && body.model.trim()
      ? body.model
      : (credentialModels[0] ?? (await getDefaultModel())));

  const upstreamBody: ChatRequestBody = {
    model,
    messages: normalizedMessages,
    stream: true,
    temperature: body.temperature,
    max_tokens: maxTokens,
    max_completion_tokens: body.max_completion_tokens ?? maxTokens,
    response_format: body.response_format,
    top_p: body.top_p,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty,
    stop: body.stop,
    stream_options: body.stream_options,
    tools: body.tools,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
  };

  applySizeControls(upstreamBody);

  if (!isHarnessIdentityRewriteEnabled()) {
    return upstreamBody;
  }

  // Applied to the normalized messages, not the raw body: that is the form the
  // upstream actually receives, including whatever `normalizeMessages` moved
  // into a `system` message.
  const rewritten = rewriteHarnessIdentity(upstreamBody);

  if (rewritten !== upstreamBody) {
    void logEvent({
      level: 'INFO',
      message: 'Rewrote the client identity marker in system messages',
      payload: { model, replacement: HARNESS_IDENTITY_PLACEHOLDER },
    });
  }

  return rewritten;
};

const stringifyResponsesInputContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return JSON.stringify(part);
      })
      .join('');
  }
  return JSON.stringify(content);
};

const mapChatContentToResponses = (
  content: unknown,
): Array<Record<string, unknown>> => {
  if (!Array.isArray(content)) {
    return [
      {
        text: stringifyResponsesInputContent(content),
        type: 'input_text',
      },
    ];
  }

  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (typeof part === 'string') {
      return [{ text: part, type: 'input_text' }];
    }
    if (!part || typeof part !== 'object') {
      return [{ text: JSON.stringify(part), type: 'input_text' }];
    }
    const value = part as {
      image_url?: string | { detail?: unknown; url?: unknown };
      text?: unknown;
      type?: unknown;
    };
    if (value.type === 'image_url') {
      const imageUrl =
        typeof value.image_url === 'string'
          ? value.image_url
          : value.image_url?.url;
      if (typeof imageUrl === 'string' && imageUrl) {
        const detail =
          typeof value.image_url === 'object' &&
          typeof value.image_url.detail === 'string'
            ? value.image_url.detail
            : undefined;
        return [
          {
            image_url: imageUrl,
            ...(detail ? { detail } : {}),
            type: 'input_image',
          },
        ];
      }
    }
    if (value.type === 'input_image' && typeof value.image_url === 'string') {
      return [{ image_url: value.image_url, type: 'input_image' }];
    }
    if (typeof value.text === 'string') {
      return [{ text: value.text, type: 'input_text' }];
    }
    return [{ text: JSON.stringify(value), type: 'input_text' }];
  });
};

const translateChatToolChoiceToResponses = (toolChoice: unknown): unknown => {
  if (typeof toolChoice === 'string') return toolChoice;
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const value = toolChoice as {
    function?: { name?: unknown };
    name?: unknown;
    type?: unknown;
  };
  if (value.type !== 'function') return toolChoice;
  const name = value.function?.name ?? value.name;
  return typeof name === 'string' ? { name, type: 'function' } : toolChoice;
};

const translateChatResponseFormatToResponses = (
  responseFormat: unknown,
): Record<string, unknown> | undefined => {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined;
  const value = responseFormat as {
    json_schema?: Record<string, unknown>;
    type?: unknown;
  };
  if (value.type === 'json_object') {
    return { format: { type: 'json_object' } };
  }
  if (value.type !== 'json_schema' || !value.json_schema) return undefined;
  const schema = value.json_schema;
  if (typeof schema.name !== 'string' || !schema.name) return undefined;
  return {
    format: {
      ...(schema.description ? { description: schema.description } : {}),
      name: schema.name,
      schema: schema.schema ?? { type: 'object', properties: {} },
      ...(typeof schema.strict === 'boolean' ? { strict: schema.strict } : {}),
      type: 'json_schema',
    },
  };
};

const translateChatThinkingToResponses = (
  thinking: Record<string, unknown> | undefined,
  reasoningEffort: string | undefined,
): Record<string, unknown> | undefined => {
  if (!thinking)
    return reasoningEffort ? { effort: reasoningEffort } : undefined;

  if (thinking.type === 'disabled') return { effort: 'none' };
  if (thinking.type !== 'adaptive' && thinking.type !== 'enabled') {
    return undefined;
  }

  const budgetTokens =
    typeof thinking.budget_tokens === 'number'
      ? thinking.budget_tokens
      : Number.NaN;
  const effort = reasoningEffort
    ? reasoningEffort
    : Number.isFinite(budgetTokens)
      ? budgetTokens <= 2_048
        ? 'low'
        : budgetTokens <= 8_192
          ? 'medium'
          : 'high'
      : undefined;

  return {
    ...(effort ? { effort } : {}),
    summary: 'auto',
  };
};

const normalizeStopSequences = (
  stop: string | string[] | undefined,
): string[] => {
  return (Array.isArray(stop) ? stop : stop ? [stop] : []).filter(Boolean);
};

const findFirstStopSequence = (
  text: string,
  stopSequences: string[],
): number | null => {
  return stopSequences.reduce<number | null>((earliest, stopSequence) => {
    const index = text.indexOf(stopSequence);
    if (index < 0) return earliest;
    return earliest === null ? index : Math.min(earliest, index);
  }, null);
};

const getPendingStopPrefixLength = (
  text: string,
  stopSequences: string[],
): number => {
  const maximumLength = Math.min(
    text.length,
    Math.max(
      0,
      ...stopSequences.map((stopSequence) => stopSequence.length - 1),
    ),
  );

  for (let length = maximumLength; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (stopSequences.some((stopSequence) => stopSequence.startsWith(suffix))) {
      return length;
    }
  }

  return 0;
};

const normalizeResponsesUpstreamBody = (
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const { messages, ...rest } = body;

  if (rest.input !== undefined || !Array.isArray(messages)) {
    return rest;
  }

  const systemInstructions = messages
    .filter((message) => {
      return (
        message &&
        typeof message === 'object' &&
        ((message as { role?: unknown }).role === 'system' ||
          (message as { role?: unknown }).role === 'developer')
      );
    })
    .map((message) => {
      return stringifyResponsesInputContent(
        (message as { content?: unknown }).content,
      );
    })
    .filter(Boolean)
    .join('\n\n');
  const input = messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return [];
    const value = message as { content?: unknown; role?: unknown };
    if (value.role === 'system' || value.role === 'developer') return [];
    const role = value.role === 'assistant' ? 'assistant' : 'user';
    return [
      {
        content: mapChatContentToResponses(value.content),
        role,
      },
    ];
  });

  const existingInstructions =
    typeof rest.instructions === 'string' ? rest.instructions.trim() : '';
  const instructions = [existingInstructions, systemInstructions]
    .filter(Boolean)
    .join('\n\n');

  return { ...rest, ...(instructions ? { instructions } : {}), input };
};

const buildResponsesBodyFromChat = (
  body: ChatRequestBody,
): Record<string, unknown> => {
  const instructions = body.messages
    ?.filter(
      (message) => message.role === 'system' || message.role === 'developer',
    )
    .map((message) => stringifyResponsesInputContent(message.content))
    .filter(Boolean)
    .join('\n\n');
  const input =
    body.messages
      ?.filter(
        (message) => message.role !== 'system' && message.role !== 'developer',
      )
      .map((message) => {
        if (message.role === 'tool') {
          return {
            call_id: message.tool_call_id,
            output: stringifyResponsesInputContent(message.content),
            type: 'function_call_output',
          };
        }
        const toolCalls = Array.isArray(message.tool_calls)
          ? message.tool_calls
          : [];
        const functionCalls = toolCalls.flatMap((toolCall) => {
          if (!toolCall || typeof toolCall !== 'object') return [];
          const call = toolCall as {
            function?: { arguments?: unknown; name?: unknown };
            id?: unknown;
          };
          if (typeof call.function?.name !== 'string') return [];
          return [
            {
              arguments: String(call.function.arguments ?? ''),
              call_id: String(call.id ?? crypto.randomUUID()),
              name: call.function.name,
              type: 'function_call',
            },
          ];
        });
        const content = mapChatContentToResponses(message.content);
        const hasContent = content.some((part) => {
          return (
            (part.type === 'input_text' && Boolean(part.text)) ||
            (part.type === 'input_image' && Boolean(part.image_url))
          );
        });
        const shouldOmitMessage =
          message.role === 'assistant' &&
          functionCalls.length > 0 &&
          !hasContent;

        return [
          ...(shouldOmitMessage
            ? []
            : [
                {
                  content,
                  role: message.role === 'assistant' ? 'assistant' : 'user',
                },
              ]),
          ...functionCalls,
        ];
      })
      .flat() ?? [];
  const tools = body.tools?.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return [];
    const value = tool as {
      function?: Record<string, unknown>;
      type?: unknown;
    };
    const definition: Record<string, unknown> =
      value.type === 'function' && value.function ? value.function : value;
    if (typeof definition.name !== 'string') return [];
    return [
      {
        ...definition,
        parameters: definition.parameters ?? { type: 'object', properties: {} },
        type: 'function',
      },
    ];
  });
  const text = translateChatResponseFormatToResponses(body.response_format);
  const reasoning = translateChatThinkingToResponses(
    body.thinking,
    body.reasoning_effort,
  );

  return {
    ...(instructions ? { instructions } : {}),
    input,
    max_output_tokens: body.max_tokens ?? body.max_completion_tokens,
    model: body.model,
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning,
    stream: Boolean(body.stream),
    temperature: body.temperature,
    top_p: body.top_p,
    ...(tools?.length ? { tools } : {}),
    ...(body.tool_choice
      ? { tool_choice: translateChatToolChoiceToResponses(body.tool_choice) }
      : {}),
    ...(text ? { text } : {}),
  };
};

const getUnsupportedResponsesChatOptions = (
  body: ChatRequestBody,
): string[] => {
  return [
    body.frequency_penalty !== undefined ? 'frequency_penalty' : null,
    body.presence_penalty !== undefined ? 'presence_penalty' : null,
    body.thinking !== undefined &&
    !translateChatThinkingToResponses(body.thinking, body.reasoning_effort)
      ? 'thinking'
      : null,
  ].filter((name): name is string => Boolean(name));
};

const extractResponsesReasoningText = (output: unknown[]): string => {
  return output
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as {
        content?: unknown;
        summary?: unknown;
        type?: unknown;
      };
      if (value.type !== 'reasoning') return [];
      return [value.summary, value.content].flatMap((parts) => {
        if (!Array.isArray(parts)) return [];
        return parts.flatMap((part) => {
          if (!part || typeof part !== 'object') return [];
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? [text] : [];
        });
      });
    })
    .join('');
};

const mapResponsesPayloadToChat = (
  payload: Record<string, unknown>,
  model: string,
  stop: string | string[] | undefined,
): Record<string, unknown> => {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const toolCalls = output.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    if (
      value.type !== 'function_call' &&
      value.type !== 'mcp_call' &&
      value.type !== 'custom_tool_call'
    ) {
      return [];
    }
    const isCustomToolCall = value.type === 'custom_tool_call';
    const customArguments = JSON.stringify({
      input: String(value.input ?? value.arguments ?? ''),
    });
    return [
      {
        function: {
          arguments: String(
            isCustomToolCall ? customArguments : (value.arguments ?? ''),
          ),
          name: String(value.name ?? 'function'),
        },
        id: String(value.call_id ?? value.id ?? crypto.randomUUID()),
        type: 'function',
      },
    ];
  });
  const usage =
    payload.usage && typeof payload.usage === 'object'
      ? (payload.usage as Record<string, unknown>)
      : undefined;
  const inputTokens = Number(usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? 0);

  const rawOutputText =
    typeof payload.output_text === 'string'
      ? payload.output_text
      : output
          .flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const content = (item as { content?: unknown }).content;
            if (!Array.isArray(content)) return [];
            return content.flatMap((part) => {
              if (!part || typeof part !== 'object') return [];
              const value = part as { text?: unknown; type?: unknown };
              return value.type === 'output_text' &&
                typeof value.text === 'string'
                ? [value.text]
                : [];
            });
          })
          .join('');
  const stopIndex = findFirstStopSequence(
    rawOutputText,
    normalizeStopSequences(stop),
  );
  const outputText =
    stopIndex === null ? rawOutputText : rawOutputText.slice(0, stopIndex);
  const reasoningText = extractResponsesReasoningText(output);
  const incompleteReason =
    payload.incomplete_details && typeof payload.incomplete_details === 'object'
      ? (payload.incomplete_details as { reason?: unknown }).reason
      : undefined;
  const finishReason =
    payload.status === 'incomplete'
      ? incompleteReason === 'content_filter'
        ? 'content_filter'
        : 'length'
      : toolCalls.length
        ? 'tool_calls'
        : 'stop';

  return {
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        message: {
          content: outputText || null,
          role: 'assistant',
          ...(reasoningText ? { reasoning_content: reasoningText } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    created: Number(payload.created_at ?? Math.floor(Date.now() / 1000)),
    id: String(payload.id ?? `chatcmpl-${crypto.randomUUID()}`),
    model,
    object: 'chat.completion',
    usage: {
      completion_tokens: outputTokens,
      prompt_tokens: inputTokens,
      total_tokens: Number(usage?.total_tokens ?? inputTokens + outputTokens),
    },
  };
};

const mapResponsesStreamToChat = (
  upstreamResponse: Response,
  model: string,
  proxyContext: ProxyContext,
  route: string,
  stop: string | string[] | undefined,
  includeUsage: boolean,
): Response => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null =
    upstreamResponse.body?.getReader() ?? null;
  const fallbackUsage = parseUsageHeader(upstreamResponse);
  let buffer = '';
  let emittedFinish = false;
  let emittedUsage = false;
  let hasToolCalls = false;
  let latestUsage = fallbackUsage;
  let usageRecorded = false;
  const stopSequences = normalizeStopSequences(stop);
  let pendingStopText = '';
  const toolIndexes = new Map<string, number>();
  const toolCallIds = new Map<string, string>();
  const customToolCallIds = new Set<string>();
  const closedCustomToolCallIds = new Set<string>();
  let nextToolIndex = 0;
  let stoppedLocally = false;

  const getToolIndex = (itemId: string): number => {
    const existing = toolIndexes.get(itemId);
    if (existing !== undefined) return existing;
    const index = nextToolIndex;
    nextToolIndex += 1;
    toolIndexes.set(itemId, index);
    return index;
  };

  // Observability tee: every chunk the caller receives also feeds the live
  // session stream, so the mobile app can watch a reply as it is produced. This
  // is a pure side channel — it cannot alter the bytes sent to the client, and
  // a failure here is swallowed so a live reply is never interrupted.
  const conversationId = proxyContext.requestDetails.conversationId ?? '';
  let streamStarted = false;
  let streamCompleted = false;

  // The reply is accumulated here, in the scope of the request that produces
  // it, and handed to the terminal event once. Keeping it local means an
  // aborted or throwing stream releases the buffer with the closure instead of
  // leaving an entry behind in a process-wide map.
  const answerChunks: string[] = [];
  let answerChars = 0;

  const appendAnswer = (text: string): void => {
    answerChunks.push(text);
    answerChars += text.length;

    while (answerChars > MAX_ANSWER_CHARS && answerChunks.length > 1) {
      const dropped = answerChunks.shift();

      answerChars -= dropped?.length ?? 0;
    }
  };

  const takeAnswer = (): string => {
    const text = answerChunks.join('');
    answerChunks.length = 0;
    answerChars = 0;

    return text.length > MAX_ANSWER_CHARS
      ? text.slice(-MAX_ANSWER_CHARS)
      : text;
  };

  const teeStarted = (): void => {
    if (streamStarted || !conversationId) return;
    streamStarted = true;
    publishSessionStarted({
      accessKeyId: proxyContext.accessKeyId,
      conversationId,
      model,
      question: proxyContext.requestDetails.question,
    });
  };

  const teeDelta = (delta: unknown): void => {
    if (!conversationId) return;
    if (typeof delta === 'string' && delta) {
      appendAnswer(delta);
    }
    teeStarted();
    publishSessionDelta({ conversationId, delta });
  };

  const teeCompleted = (error?: string): void => {
    if (streamCompleted || !conversationId) return;
    streamCompleted = true;
    if (!streamStarted) return;
    const text = takeAnswer();
    publishSessionCompleted({
      conversationId,
      error,
      text,
      // `hasToolCalls` is final by the time this runs: it is set while the
      // upstream frames are folded, and every call site below is past that.
      toolTurn: hasToolCalls,
    });
  };

  const encodeChunk = (choice: Record<string, unknown>): Uint8Array => {
    const delta = choice.delta as Record<string, unknown> | undefined;
    const content = delta?.content;
    const reasoning = delta?.reasoning_content;

    // Text deltas are what a remote viewer needs; tool-call frames are skipped
    // because argument fragments are meaningless without their definitions.
    if (typeof content === 'string' && content) {
      teeDelta(content);
    } else if (typeof reasoning === 'string' && reasoning) {
      teeDelta(reasoning);
    }

    return encoder.encode(
      `data: ${JSON.stringify({
        choices: [choice],
        created: Math.floor(Date.now() / 1000),
        id: responseId,
        model,
        object: 'chat.completion.chunk',
      })}\n\n`,
    );
  };

  const enqueueUsage = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (!includeUsage || emittedUsage) return;
    const usage = mapResponsesUsageToChat(latestUsage);
    if (!usage) return;

    emittedUsage = true;
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          choices: [],
          created: Math.floor(Date.now() / 1000),
          id: responseId,
          model,
          object: 'chat.completion.chunk',
          usage,
        })}\n\n`,
      ),
    );
  };

  const recordStreamUsage = async (): Promise<void> => {
    if (usageRecorded) return;
    usageRecorded = true;
    try {
      await recordProxyUsage({
        model,
        proxyContext,
        route,
        usage: latestUsage,
      });
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to record Responses stream usage', {
        error,
        route,
      });
    }
  };

  const cancelAndReleaseReader = async (reason?: unknown): Promise<void> => {
    try {
      await reader?.cancel(reason);
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to cancel Responses stream', {
        error,
        route,
      });
    } finally {
      reader?.releaseLock();
      reader = null;
    }
  };

  const emitCustomToolCallClosures = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    customToolCallIds.forEach((itemId) => {
      if (closedCustomToolCallIds.has(itemId)) return;
      const index = getToolIndex(itemId);
      const callId = toolCallIds.get(itemId) ?? `call_${index + 1}`;
      controller.enqueue(
        encodeChunk({
          delta: {
            tool_calls: [{ function: { arguments: '"}' }, id: callId, index }],
          },
          index: 0,
        }),
      );
      closedCustomToolCallIds.add(itemId);
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) {
        await recordStreamUsage();
        controller.close();
        return;
      }
      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          await recordStreamUsage();
          teeCompleted(
            error instanceof Error ? error.message : 'stream read failed',
          );
          reader.releaseLock();
          reader = null;
          controller.error(error);
          return;
        }
        const { done, value } = readResult;
        if (done) {
          if (pendingStopText) {
            controller.enqueue(
              encodeChunk({
                delta: { content: pendingStopText },
                index: 0,
              }),
            );
            pendingStopText = '';
          }
          emitCustomToolCallClosures(controller);
          if (!emittedFinish) {
            controller.enqueue(
              encodeChunk({
                delta: {},
                finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
                index: 0,
              }),
            );
          }
          enqueueUsage(controller);
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          await recordStreamUsage();
          reader.releaseLock();
          reader = null;
          teeCompleted();
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
          controller.enqueue(
            encoder.encode(
              'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          await cancelAndReleaseReader();
          await recordStreamUsage();
          controller.close();
          return;
        }
        let emitted = false;
        for (const frame of frames) {
          if (frame.length > MAX_STREAM_FRAME_LENGTH) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            await cancelAndReleaseReader();
            await recordStreamUsage();
            controller.close();
            return;
          }
          const dataLine = frame
            .split(/\r?\n/)
            .find((line) => line.startsWith('data: '));
          if (!dataLine || dataLine === 'data: [DONE]') continue;
          try {
            const event = JSON.parse(dataLine.slice(6)) as {
              delta?: unknown;
              item?: unknown;
              item_id?: unknown;
              output_index?: unknown;
              error?: unknown;
              response?: unknown;
              type?: unknown;
            };
            latestUsage = extractResponsesUsage(event) ?? latestUsage;
            if (
              stoppedLocally &&
              event.type !== 'response.completed' &&
              event.type !== 'response.incomplete'
            ) {
              continue;
            }
            if (event.type === 'response.output_text.delta') {
              const delta = String(event.delta ?? '');
              if (stopSequences.length) {
                pendingStopText += delta;
                const stopIndex = findFirstStopSequence(
                  pendingStopText,
                  stopSequences,
                );
                if (stopIndex !== null) {
                  const content = pendingStopText.slice(0, stopIndex);
                  if (content) {
                    controller.enqueue(
                      encodeChunk({ delta: { content }, index: 0 }),
                    );
                  }
                  pendingStopText = '';
                  controller.enqueue(
                    encodeChunk({
                      delta: {},
                      finish_reason: 'stop',
                      index: 0,
                    }),
                  );
                  emittedFinish = true;
                  stoppedLocally = true;
                  emitted = true;
                  continue;
                }

                const pendingLength = getPendingStopPrefixLength(
                  pendingStopText,
                  stopSequences,
                );
                const content = pendingStopText.slice(
                  0,
                  pendingStopText.length - pendingLength,
                );
                pendingStopText = pendingLength
                  ? pendingStopText.slice(-pendingLength)
                  : '';
                if (!content) continue;
                controller.enqueue(
                  encodeChunk({ delta: { content }, index: 0 }),
                );
                emitted = true;
                continue;
              }
              controller.enqueue(
                encodeChunk({
                  delta: { content: delta },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (
              event.type === 'response.reasoning_summary_text.delta' ||
              event.type === 'response.reasoning_text.delta'
            ) {
              controller.enqueue(
                encodeChunk({
                  delta: { reasoning_content: String(event.delta ?? '') },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (
              event.type === 'response.output_item.added' &&
              event.item &&
              typeof event.item === 'object'
            ) {
              const item = event.item as {
                arguments?: unknown;
                call_id?: unknown;
                id?: unknown;
                input?: unknown;
                name?: unknown;
                type?: unknown;
              };
              if (
                item.type !== 'function_call' &&
                item.type !== 'mcp_call' &&
                item.type !== 'custom_tool_call'
              ) {
                continue;
              }
              const isCustomToolCall = item.type === 'custom_tool_call';
              const initialArguments = isCustomToolCall
                ? `{"input":"${JSON.stringify(
                    String(item.input ?? item.arguments ?? ''),
                  ).slice(1, -1)}`
                : String(item.arguments ?? '');
              const itemId = String(item.id ?? item.call_id ?? nextToolIndex);
              const index = getToolIndex(itemId);
              const callId = String(item.call_id ?? item.id ?? itemId);
              toolCallIds.set(itemId, callId);
              if (isCustomToolCall) {
                customToolCallIds.add(itemId);
              }
              hasToolCalls = true;
              controller.enqueue(
                encodeChunk({
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: initialArguments,
                          name: String(item.name ?? 'function'),
                        },
                        id: callId,
                        index,
                        type: 'function',
                      },
                    ],
                  },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (
              event.type === 'response.function_call_arguments.delta' ||
              event.type === 'response.mcp_call_arguments.delta' ||
              event.type === 'response.custom_tool_call_input.delta'
            ) {
              const itemId = String(
                event.item_id ?? event.output_index ?? nextToolIndex,
              );
              const index = getToolIndex(itemId);
              const callId = toolCallIds.get(itemId) ?? `call_${index + 1}`;
              toolCallIds.set(itemId, callId);
              hasToolCalls = true;
              const argumentDelta =
                event.type === 'response.custom_tool_call_input.delta'
                  ? JSON.stringify(String(event.delta ?? '')).slice(1, -1)
                  : String(event.delta ?? '');
              controller.enqueue(
                encodeChunk({
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: argumentDelta },
                        id: callId,
                        index,
                      },
                    ],
                  },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (event.type === 'response.completed') {
              if (pendingStopText) {
                controller.enqueue(
                  encodeChunk({
                    delta: { content: pendingStopText },
                    index: 0,
                  }),
                );
                pendingStopText = '';
              }
              emitCustomToolCallClosures(controller);
              if (!emittedFinish) {
                controller.enqueue(
                  encodeChunk({
                    delta: {},
                    finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
                    index: 0,
                  }),
                );
              }
              enqueueUsage(controller);
              emittedFinish = true;
              emitted = true;
              if (stoppedLocally) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                await cancelAndReleaseReader('Stop sequence matched');
                await recordStreamUsage();
                controller.close();
                return;
              }
              continue;
            }
            if (event.type === 'response.incomplete') {
              if (pendingStopText) {
                controller.enqueue(
                  encodeChunk({
                    delta: { content: pendingStopText },
                    index: 0,
                  }),
                );
                pendingStopText = '';
              }
              emitCustomToolCallClosures(controller);
              const incompleteReason =
                event.response && typeof event.response === 'object'
                  ? (
                      (event.response as { incomplete_details?: unknown })
                        .incomplete_details as { reason?: unknown } | undefined
                    )?.reason
                  : undefined;
              if (!emittedFinish) {
                controller.enqueue(
                  encodeChunk({
                    delta: {},
                    finish_reason:
                      incompleteReason === 'content_filter'
                        ? 'content_filter'
                        : 'length',
                    index: 0,
                  }),
                );
              }
              enqueueUsage(controller);
              emittedFinish = true;
              emitted = true;
              if (stoppedLocally) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                await cancelAndReleaseReader('Stop sequence matched');
                await recordStreamUsage();
                controller.close();
                return;
              }
              continue;
            }
            if (
              event.type === 'response.failed' ||
              event.type === 'response.error' ||
              event.type === 'error'
            ) {
              const failure =
                event.error ??
                (event.response && typeof event.response === 'object'
                  ? (event.response as { error?: unknown }).error
                  : undefined);
              const message =
                failure && typeof failure === 'object'
                  ? String(
                      (failure as { message?: unknown }).message ?? failure,
                    )
                  : String(failure ?? 'Upstream Responses stream failed');
              void logEvent({
                level: 'WARN',
                message: 'Upstream Responses stream reported an error event',
                payload: {
                  credentialFilename: proxyContext.credentialFilename,
                  detail: truncateLogText(
                    describeStreamError(failure, message),
                  ),
                  eventType: typeof event.type === 'string' ? event.type : null,
                  model,
                  route,
                },
              });
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: { message } })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              await cancelAndReleaseReader();
              await recordStreamUsage();
              controller.close();
              return;
            }
          } catch {
            // Ignore malformed upstream events and continue reading.
          }
        }
        if (stoppedLocally) continue;
        if (emitted) return;
      }
    },
    async cancel(reason) {
      await cancelAndReleaseReader(reason);
      await recordStreamUsage();
    },
  });

  return new Response(stream, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
    status: upstreamResponse.status,
  });
};

const aggregateToolCalls = (
  toolCalls: NonNullable<ChatStreamDelta['tool_calls']>,
): Array<{
  id?: string;
  type?: string;
  function: {
    arguments: string;
    name: string;
  };
}> => {
  const aggregated = new Map<
    string,
    {
      order: number;
      id?: string;
      type?: string;
      function: {
        arguments: string;
        name: string;
      };
    }
  >();
  const latestKeyByIndex = new Map<number, string>();

  toolCalls.forEach((toolCall, position) => {
    const normalizedId = createNormalizedToolCallId(toolCall.id, position);
    const key =
      (toolCall.id ? `id:${normalizedId}` : undefined) ??
      (typeof toolCall.index === 'number'
        ? latestKeyByIndex.get(toolCall.index)
        : undefined) ??
      `position:${position}`;
    const current = aggregated.get(key) ?? {
      order: aggregated.size,
      function: {
        arguments: '',
        name: '',
      },
    };

    if (toolCall.id) {
      current.id = normalizedId;
    }

    if (toolCall.type) {
      current.type = toolCall.type;
    }

    if (toolCall.function?.name) {
      current.function.name += toolCall.function.name;
    }

    if (toolCall.function?.arguments) {
      current.function.arguments += toolCall.function.arguments;
    }

    aggregated.set(key, current);

    if (typeof toolCall.index === 'number') {
      latestKeyByIndex.set(toolCall.index, key);
    }
  });

  return [...aggregated.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...value }, index) => ({
      ...value,
      id: value.id ?? createNormalizedToolCallId(undefined, index),
    }));
};

const getToolCallStateKey = (
  toolCall: ToolCallChunk,
  position: number,
): string => {
  if (toolCall.id) {
    return `id:${toolCall.id}`;
  }

  if (typeof toolCall.index === 'number') {
    return `index:${toolCall.index}`;
  }

  return `position:${position}`;
};

const createNormalizedToolCallId = (
  sourceId: string | undefined,
  normalizedIndex: number,
): string => {
  if (sourceId && !sourceId.startsWith('tooluse_')) {
    return sourceId;
  }

  const suffix =
    sourceId?.replace(/^tooluse_/, '') ??
    `${normalizedIndex}_${crypto.randomUUID().replaceAll('-', '')}`;

  return `call_${suffix}`;
};

const resolveToolCallMapping = (
  state: ToolCallNormalizationState,
  toolCall: ToolCallChunk,
  position: number,
): ToolCallMapping => {
  const keys = toolCall.id
    ? [`id:${toolCall.id}`]
    : [
        typeof toolCall.index === 'number' ? `index:${toolCall.index}` : null,
        `position:${position}`,
      ].filter((value): value is string => value !== null);
  const existing = keys
    .map((key) => state.mappings.get(key))
    .find((value) => value !== undefined);

  if (existing) {
    return existing;
  }

  return {
    id: createNormalizedToolCallId(toolCall.id, state.nextIndex),
    index: state.nextIndex++,
  };
};

/**
 * Upstream-only delta fields that the OpenAI streaming schema has no place for.
 *
 * CodeBuddy emits these on every frame; strict clients (the Swift AI SDK behind
 * Peekaboo, for one) reject the frame outright rather than ignoring an unknown
 * key, so they must not survive the passthrough.
 */
const NON_STANDARD_DELTA_FIELDS = ['extra_fields', 'refusal'] as const;

/**
 * Whether the passthrough narrows each delta to the fields the OpenAI schema
 * defines.
 *
 * On by default: the upstream fills every frame with `extra_fields`,
 * `refusal`, an empty `tool_calls` array and a deprecated `function_call`, and
 * strict clients reject such a frame instead of ignoring what they do not know.
 * Set `CODEBUDDY_SSE_STRICT_COMPAT=0` to forward the upstream frames untouched —
 * the escape hatch if some client turns out to depend on a placeholder we drop.
 */
const isStrictSseCompatEnabled = (): boolean => {
  const raw = process.env.CODEBUDDY_SSE_STRICT_COMPAT?.trim().toLowerCase();

  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
};

/**
 * Drop non-standard keys and collapse the empty placeholders the upstream fills
 * in, so a strict client sees only the fields the schema actually allows.
 *
 * Two shapes matter here:
 *
 * - `tool_calls: []` — codebuddy sends an empty array on every content frame.
 *   An empty array means "the tool call list is reset" to a strict reader, so
 *   the key is removed rather than forwarded empty.
 * - `function_call: { name: '', arguments: '' }` — the deprecated field arrives
 *   as null on content frames and as an empty object on the terminal frame.
 *   Both are stripped; the deprecated field is never useful downstream.
 */
const sanitizeStreamDelta = (
  delta: Record<string, unknown>,
): Record<string, unknown> => {
  if (!isStrictSseCompatEnabled()) {
    return delta;
  }

  const cleaned: Record<string, unknown> = { ...delta };

  for (const field of NON_STANDARD_DELTA_FIELDS) {
    delete cleaned[field];
  }

  if (Array.isArray(cleaned.tool_calls) && cleaned.tool_calls.length === 0) {
    delete cleaned.tool_calls;
  }

  const legacyCall = cleaned.function_call;
  if (
    legacyCall === null ||
    legacyCall === undefined ||
    (typeof legacyCall === 'object' &&
      !Array.isArray(legacyCall) &&
      !String((legacyCall as { name?: unknown }).name ?? '').trim() &&
      !String((legacyCall as { arguments?: unknown }).arguments ?? '').trim())
  ) {
    delete cleaned.function_call;
  }

  return cleaned;
};

/**
 * Blank string fields are omitted rather than forwarded as `''`.
 *
 * A strict reader treats `name: ''` as an instruction to clear the name it
 * accumulated from the opening chunk, so only the first tool-call chunk may
 * carry `function.name`; later chunks must leave the key out entirely.
 */
const stripBlankStringFields = (
  value: Record<string, unknown>,
  fields: string[],
): void => {
  for (const field of fields) {
    if (value[field] === '') {
      delete value[field];
    }
  }
};

const normalizeStreamToolCalls = (
  chunk: ChatStreamChunk,
  state: ToolCallNormalizationState,
): ChatStreamChunk => {
  if (!chunk.choices?.length) {
    return chunk;
  }

  return {
    ...chunk,
    choices: chunk.choices.map((choice) => {
      const delta = choice.delta as Record<string, unknown> | undefined;
      const toolCalls = Array.isArray(delta?.tool_calls)
        ? (delta.tool_calls as ToolCallChunk[])
        : null;

      if (!delta || !toolCalls?.length) {
        return {
          ...choice,
          delta: delta
            ? (sanitizeStreamDelta(delta) as ChatStreamDelta)
            : delta,
        };
      }

      return {
        ...choice,
        delta: {
          ...sanitizeStreamDelta(delta),
          tool_calls: toolCalls.map((toolCall, position) => {
            const mapping = resolveToolCallMapping(state, toolCall, position);
            const sourceKey = getToolCallStateKey(toolCall, position);

            state.mappings.set(sourceKey, mapping);

            if (toolCall.id) {
              state.mappings.set(`id:${toolCall.id}`, mapping);
            }

            if (typeof toolCall.index === 'number') {
              state.mappings.set(`index:${toolCall.index}`, mapping);
            }

            const normalized = {
              ...toolCall,
              id: mapping.id,
              index: mapping.index,
            } as Record<string, unknown>;

            if (!isStrictSseCompatEnabled()) {
              return normalized as ToolCallChunk;
            }

            const fn = normalized.function as
              Record<string, unknown> | undefined;
            const carriesName =
              typeof fn?.name === 'string' && fn.name.trim().length > 0;

            if (carriesName) {
              // Opening chunk for this call: keep the declared name and record
              // that it has been sent, so later chunks stay silent about it.
              state.namedToolCalls.add(mapping.id);
              const normalizedFn = { ...fn };
              stripBlankStringFields(normalizedFn, ['arguments']);
              normalized.function = normalizedFn;
            } else if (fn) {
              // Continuation chunk: `name: ''` would read as a reset, and a
              // repeated name would read as a second declaration. Either way
              // the key is dropped, which is what the schema expects.
              const normalizedFn = { ...fn };
              delete normalizedFn.name;
              stripBlankStringFields(normalizedFn, ['arguments']);
              normalized.function = normalizedFn;
            }

            return normalized as ToolCallChunk;
          }),
        } as ChatStreamDelta,
      };
    }),
  };
};

const normalizeStreamingResponse = ({
  model,
  proxyContext,
  route,
  upstreamResponse,
}: {
  model: string;
  proxyContext: ProxyContext;
  route: string;
  upstreamResponse: Response;
}): Response => {
  if (!upstreamResponse.body) {
    return new Response(null, {
      status: upstreamResponse.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      },
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state: ToolCallNormalizationState = {
    mappings: new Map<string, ToolCallMapping>(),
    nextIndex: 0,
    namedToolCalls: new Set<string>(),
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };

  // Observability tee for the chat passthrough path: the frames below are what
  // the caller receives, so mirroring the text deltas here is how a remote
  // viewer follows the reply. Purely a side channel — the returned frame is
  // built independently of the publish call.
  const teeConversationId = proxyContext.requestDetails.conversationId ?? '';
  let teeStarted = false;
  let teeCompleted = false;
  /**
   * Whether this turn asked for tools instead of finishing.
   *
   * A task the IDE runs is a chain of these turns; the intermediate ones carry a
   * sentence or two and a tool call, and stored as ordinary Q&A they buried the
   * real ones (142 of 500 measured turns). The flag travels with the completion
   * event so a viewer can keep them apart without the gateway dropping them.
   */
  let sawToolCalls = false;

  /**
   * Prose the model produced, kept only to detect a tool call that escaped into
   * text. Bounded to the first `TOOL_LEAK_SCAN_CHARS` characters: the marker
   * appears at the start of the call, and a turn that model wrote as prose
   * would otherwise pin a whole long answer in memory.
   */
  let leakScan = '';
  let leakScanFull = false;
  let leakReported = false;

  // Same reasoning as the responses path: the reply lives only for as long as
  // the stream that produced it, so an aborted client cannot strand it.
  const teeAnswerChunks: string[] = [];
  let teeAnswerChars = 0;
  const teeAppendAnswer = (text: string): void => {
    teeAnswerChunks.push(text);
    teeAnswerChars += text.length;

    while (teeAnswerChars > MAX_ANSWER_CHARS && teeAnswerChunks.length > 1) {
      const dropped = teeAnswerChunks.shift();

      teeAnswerChars -= dropped?.length ?? 0;
    }
  };
  const teeTakeAnswer = (): string => {
    const text = teeAnswerChunks.join('');
    teeAnswerChunks.length = 0;
    teeAnswerChars = 0;

    return text.length > MAX_ANSWER_CHARS
      ? text.slice(-MAX_ANSWER_CHARS)
      : text;
  };

  const teeContent = (delta: unknown): void => {
    if (!teeConversationId || typeof delta !== 'string' || !delta) return;

    teeAppendAnswer(delta);

    if (!teeStarted) {
      teeStarted = true;
      publishSessionStarted({
        accessKeyId: proxyContext.accessKeyId,
        conversationId: teeConversationId,
        model,
        question: proxyContext.requestDetails.question,
      });
    }

    publishSessionDelta({ conversationId: teeConversationId, delta });
  };

  const teeFinish = (error?: string): void => {
    reportToolCallLeak();

    if (!teeConversationId || teeCompleted) return;
    teeCompleted = true;
    if (!teeStarted) return;
    publishSessionCompleted({
      conversationId: teeConversationId,
      error,
      text: teeTakeAnswer(),
      toolTurn: sawToolCalls,
    });
  };

  /**
   * Logs once if the turn carried tool-call markup as prose.
   *
   * A leaked call is a successful HTTP response that does nothing: the caller
   * sees 200 with `finish_reason: stop` and a body that reads like a truncated
   * answer. Nothing else in the request's telemetry distinguishes it, so this
   * line is the only signal that the model failed rather than finished.
   */
  const reportToolCallLeak = (): void => {
    if (leakReported || sawToolCalls || !leakScan) return;

    const leak = findToolCallLeak(leakScan);

    if (!leak) return;

    leakReported = true;

    void logEvent({
      level: 'WARN',
      message: 'Model emitted a tool call as plain text',
      payload: {
        credentialFilename: proxyContext.credentialFilename,
        marker: leak.marker,
        model,
        route,
        sample: truncateLogText(leak.sample),
        scannedChars: leakScan.length,
        scanTruncated: leakScanFull,
      },
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      let latestUsage: unknown = null;

      const processFrame = (frame: string): string => {
        const lines = frame.split('\n');
        const lineIndex = lines.findIndex((line) => line.startsWith('data: '));

        if (lineIndex === -1) {
          return frame;
        }

        const raw = lines[lineIndex]?.slice(6).trim() ?? '';

        if (!raw || raw === '[DONE]') {
          return frame;
        }

        try {
          const chunk = JSON.parse(raw) as ChatStreamChunk;
          if (chunk.usage !== undefined) {
            latestUsage = chunk.usage;
          }
          // Mirror the text the model produced (reasoning included) so the live
          // view shows progress even before the final answer starts.
          const choice = (
            chunk as { choices?: Array<{ delta?: Record<string, unknown> }> }
          ).choices?.[0];
          const delta = choice?.delta;
          if (delta) {
            if (
              Array.isArray(delta.tool_calls) &&
              delta.tool_calls.length > 0
            ) {
              sawToolCalls = true;
            }
            // Keep the opening of the answer for the leak check. Reasoning is
            // excluded: a model may describe the syntax it is about to emit.
            if (
              !leakScanFull &&
              typeof delta.content === 'string' &&
              delta.content
            ) {
              leakScan += delta.content;

              if (leakScan.length >= TOOL_LEAK_SCAN_CHARS) {
                leakScan = leakScan.slice(0, TOOL_LEAK_SCAN_CHARS);
                leakScanFull = true;
              }
            }
            teeContent(delta.content);
            if (typeof delta.content !== 'string' || !delta.content) {
              teeContent(delta.reasoning_content);
            }
          }
          if (chunk.error !== undefined) {
            void logEvent({
              level: 'WARN',
              message: 'Upstream stream reported an error chunk',
              payload: {
                credentialFilename: proxyContext.credentialFilename,
                detail: truncateLogText(describeStreamError(chunk.error, raw)),
                model,
                route,
              },
            });
          }
          const normalized = normalizeStreamToolCalls(chunk, state);
          lines[lineIndex] = `data: ${JSON.stringify(normalized)}`;
          return lines.join('\n');
        } catch {
          return frame;
        }
      };

      const waitForDemand = (): Promise<void> =>
        waitForStreamDemand(controller, () => cancelled);

      const flushFrames = async (frames: string[]): Promise<void> => {
        for (const frame of frames) {
          await waitForDemand();

          if (cancelled) return;

          if (frame.length > MAX_STREAM_FRAME_LENGTH) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            continue;
          }
          controller.enqueue(encoder.encode(`${processFrame(frame)}\n\n`));
        }
      };

      const pump = async (): Promise<void> => {
        while (true) {
          const { done, value } = await upstreamReader.read();

          if (cancelled) {
            return;
          }

          if (done) {
            if (buffer.trim()) {
              await flushFrames([buffer]);
            }

            await recordProxyUsage({
              model,
              proxyContext,
              route,
              usage: latestUsage,
            });

            releaseReader();
            teeFinish();
            try {
              controller.close();
            } catch {
              // The downstream stream may have been cancelled while the pump was completing.
            }
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
            await waitForDemand();
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            teeFinish('Upstream SSE frame exceeds the maximum size');
            try {
              await reader!.cancel();
            } finally {
              releaseReader();
              controller.close();
            }
            return;
          }
          await flushFrames(frames);
        }
      };

      // A rejected pump used to be an unhandled rejection that also skipped the
      // terminal bookkeeping; any failure has to end the turn explicitly.
      void pump().catch((error: unknown) => {
        releaseReader();
        teeFinish(describeStreamError(error, 'Upstream stream failed'));
        try {
          controller.close();
        } catch {
          // Already closed downstream.
        }
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      try {
        await reader?.cancel(reason);
      } finally {
        releaseReader();
        // The turn ends here, not on the upstream's `done` branch. Without this
        // the conversation stayed "live" with text nobody would ever collect.
        teeFinish('Client disconnected');
      }
    },
  });

  return new Response(stream, {
    status: upstreamResponse.status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
};

const aggregateUpstreamStream = async (
  upstreamResponse: Response,
  fallbackModel: string,
): Promise<{ model: string; response: Response; usage: unknown }> => {
  const payloadText = await readCappedResponseText(
    upstreamResponse,
    MAX_AGGREGATED_STREAM_BYTES,
  );
  const toolCalls: NonNullable<ChatStreamDelta['tool_calls']> = [];
  let responseId = '';
  let responseObject = 'chat.completion';
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let content = '';
  let reasoningContent = '';
  let finishReason: string | null = 'stop';
  let role = 'assistant';
  let usage: unknown = null;

  for (const frame of payloadText.split('\n\n')) {
    const line = frame
      .split('\n')
      .find((segment) => segment.startsWith('data: '));

    if (!line) {
      continue;
    }

    const raw = line.slice(6).trim();

    if (!raw || raw === '[DONE]') {
      continue;
    }

    let chunk: ChatStreamChunk;

    try {
      chunk = JSON.parse(raw) as ChatStreamChunk;
    } catch {
      return {
        model: fallbackModel,
        response: createErrorResponse(
          502,
          'Failed to parse upstream SSE frame',
        ),
        usage: null,
      };
    }

    if (chunk.id) {
      responseId = chunk.id;
    }

    if (chunk.object) {
      responseObject = chunk.object.replace(/\.chunk$/, '');
    }

    if (typeof chunk.created === 'number') {
      created = chunk.created;
    }

    if (chunk.model) {
      model = chunk.model;
    }

    if (chunk.usage !== undefined) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (delta?.role) {
      role = delta.role;
    }

    if (delta?.content) {
      content += delta.content;
    }

    if (delta?.reasoning_content ?? delta?.reasoning) {
      reasoningContent += delta.reasoning_content ?? delta.reasoning;
    }

    if (delta?.tool_calls?.length) {
      toolCalls.push(...delta.tool_calls);
    }

    if (choice?.finish_reason !== undefined) {
      finishReason = choice.finish_reason ?? finishReason;
    }
  }

  const aggregatedToolCalls = aggregateToolCalls(toolCalls);
  const message: Record<string, unknown> = {
    role,
    content: content || null,
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (aggregatedToolCalls.length) {
    message.tool_calls = aggregatedToolCalls;
  }

  // Same check as the streaming path. Here the whole answer is already in
  // memory, so the scan is bounded explicitly rather than by accumulation.
  if (!aggregatedToolCalls.length) {
    const leak = findToolCallLeak(content.slice(0, TOOL_LEAK_SCAN_CHARS));

    if (leak) {
      void logEvent({
        level: 'WARN',
        message: 'Model emitted a tool call as plain text',
        payload: {
          marker: leak.marker,
          model,
          sample: truncateLogText(leak.sample),
          scannedChars: Math.min(content.length, TOOL_LEAK_SCAN_CHARS),
          scanTruncated: content.length > TOOL_LEAK_SCAN_CHARS,
        },
      });
    }
  }

  return {
    model,
    response: Response.json({
      id: responseId || `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`,
      object: responseObject,
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason:
            finishReason ??
            (aggregatedToolCalls.length ? 'tool_calls' : 'stop'),
        },
      ],
      usage,
    }),
    usage,
  };
};

export const getModelsForCredential = async ({
  bearerToken,
  credentialData,
}: {
  bearerToken: string;
  credentialData: CredentialData;
}): Promise<DiscoveredModel[]> => {
  const configuredEndpoint = await getCodeBuddyApiEndpoint();
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${bearerToken}`,
  });
  const domain = getCredentialValue(credentialData, ['domain']);
  const apiEndpoint = String(domain ?? '')
    .toLowerCase()
    .endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : configuredEndpoint;
  const enterpriseId = getCredentialValue(credentialData, [
    'enterprise_id',
    'enterpriseId',
  ]);
  const tenantId =
    getCredentialValue(credentialData, ['tenant_id', 'tenantId']) ??
    enterpriseId;
  const userId = getCredentialValue(credentialData, ['user_id', 'userId']);

  if (domain) {
    headers.set('X-Domain', String(domain));
  }

  if (enterpriseId) {
    headers.set('X-Enterprise-Id', String(enterpriseId));
  }

  if (tenantId) {
    headers.set('X-Tenant-Id', String(tenantId));
  }
  if (userId) {
    headers.set('X-User-Id', String(userId));
  }

  const fetchModels = async (path: string): Promise<Response> =>
    fetch(new URL(path, apiEndpoint), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  let response = await fetchModels('/v3/config');

  if ([400, 404, 405].includes(response.status)) {
    response = await fetchModels('/console/enterprises/personal/models');
  }

  if (!response.ok) {
    throw new Error(`Model discovery failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    code?: unknown;
    data?: {
      agents?: Array<{ models?: unknown; name?: unknown }>;
      models?: Array<{ disabled?: unknown; id?: unknown; name?: unknown }>;
    };
  };

  if (payload.code !== 0) {
    throw new Error('Model discovery returned an unsuccessful response');
  }

  const cliModels = payload.data?.agents?.find(
    (agent) => agent.name === 'cli',
  )?.models;
  const modelsById = new Map(
    (payload.data?.models ?? []).flatMap((model) => {
      const id = typeof model.id === 'string' ? model.id.trim() : '';

      if (!id || model.disabled === true) {
        return [];
      }

      return [
        [
          id,
          {
            displayName:
              typeof model.name === 'string' && model.name.trim()
                ? model.name
                : id,
            id,
          },
        ] as const,
      ];
    }),
  );
  const declaredModelIds = new Set(
    (payload.data?.models ?? [])
      .map((model) => (typeof model.id === 'string' ? model.id.trim() : ''))
      .filter(Boolean),
  );

  if (!Array.isArray(cliModels)) {
    return [];
  }

  return cliModels.flatMap((modelId) => {
    if (typeof modelId !== 'string') {
      return [];
    }

    const model = modelsById.get(modelId);
    if (!model && declaredModelIds.has(modelId)) {
      return [];
    }
    return [
      model ?? {
        displayName: modelId,
        id: modelId,
      },
    ];
  });
};

export const getModelsForCredentials = async (
  credentials: CredentialRecord[],
): Promise<DiscoveredModel[]> => {
  const settled = await Promise.allSettled(
    credentials.map((credential) => {
      const supportedModels = getCredentialSupportedModels(credential.data);

      if (supportedModels.length) {
        return Promise.resolve(
          supportedModels.map((id) => ({ displayName: id, id })),
        );
      }

      const bearerToken = String(
        credential.data.bearer_token ?? credential.data.access_token ?? '',
      ).trim();

      return bearerToken
        ? getModelsForCredential({
            bearerToken,
            credentialData: credential.data,
          })
        : Promise.resolve([]);
    }),
  );
  const models = new Map<string, DiscoveredModel>();

  settled.forEach((result) => {
    if (result.status !== 'fulfilled') {
      return;
    }

    result.value.forEach((model) => {
      models.set(model.id, model);
    });
  });

  return [...models.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
};

export const getModelsByCredential = async (
  credentials: CredentialRecord[],
): Promise<
  Record<string, { error: string | null; models: DiscoveredModel[] }>
> => {
  const results = await Promise.all(
    credentials.map(async (credential) => {
      const bearerToken = String(
        credential.data.bearer_token ?? credential.data.access_token ?? '',
      ).trim();

      try {
        const models = bearerToken
          ? await getModelsForCredential({
              bearerToken,
              credentialData: credential.data,
            })
          : [];

        return [credential.filename, { error: null, models }] as const;
      } catch (error) {
        return [
          credential.filename,
          {
            error:
              error instanceof Error ? error.message : 'Model discovery failed',
            models: [],
          },
        ] as const;
      }
    }),
  );

  return Object.fromEntries(results);
};

export const getModelsResponse = async (
  request?: NextRequest,
): Promise<Response> => {
  const accessKey = request ? await resolveRequestAccessKey(request) : null;
  const models = (
    await getModelsForCredentials(
      await listEligibleCredentialRecords(accessKey?.credentialFilenames),
    )
  ).map((model) => ({
    id: model.id,
    slug: model.id,
    display_name: model.displayName,
    object: 'model',
    created: 0,
    owned_by: 'codebuddy',
  }));

  return Response.json({
    object: 'list',
    data: models,
    models,
  });
};

/**
 * Entry point for every chat-shaped request.
 *
 * The work runs inside a request context so that every stage of one request
 * (alias resolution, credential selection, upstream dispatch, stream end)
 * shares a single `reqId`. Without it the lines of concurrent requests are
 * indistinguishable and "which step failed" cannot be answered from the logs.
 */
export const proxyChatCompletions = async (
  request: NextRequest,
  body: ChatRequestBody,
  context?: ProxyContext,
  debugTrace?: DebugTrace,
  usageRoute = '/v1/chat/completions',
): Promise<Response> =>
  runWithRequestContext(usageRoute, async () => {
    const messages = body.messages ?? [];

    void logEvent({
      level: 'INFO',
      message: 'Request received',
      payload: {
        ...getMemorySnapshot(),
        // Counted structurally rather than with `JSON.stringify(body).length`:
        // the old form allocated a second copy of a multi-megabyte body once per
        // request just to print a number.
        messageChars: countMessageChars(messages),
        messageCount: messages.length,
        // The byte figure, next to the character one, because they disagree by
        // orders of magnitude and the disagreement was invisible. `messageChars`
        // walks text only, so it reports a few hundred characters for a body
        // that is megabytes of base64 screenshots and tool arguments — the
        // exact case that produced "your request is 8 MB" against a log line
        // claiming a small conversation. Bytes are what the cap and the socket
        // both measure; characters are a rough size hint for humans.
        messageBytes: measureMessagesBytes(messages),
        imageBytes: measureImageBytes(messages),
        model: String(body.model ?? ''),
        route: usageRoute,
        stream: Boolean(body.stream),
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      },
    });

    return proxyChatCompletionsInScope(
      request,
      body,
      context,
      debugTrace,
      usageRoute,
    );
  });

const proxyChatCompletionsInScope = async (
  request: NextRequest,
  body: ChatRequestBody,
  context?: ProxyContext,
  debugTrace?: DebugTrace,
  usageRoute = '/v1/chat/completions',
): Promise<Response> => {
  if (!body.messages?.length) {
    return createErrorResponse(400, 'messages is required');
  }

  try {
    const resolvedContext =
      context ?? (await resolveProxyContext(request, body.model, body));
    setDebugTraceCredential(debugTrace, resolvedContext.credentialFilename);
    const upstreamBody = await buildUpstreamBody(body, resolvedContext);

    if (resolvedContext.preferences.upstreamProtocol === 'responses') {
      const unsupportedOptions = getUnsupportedResponsesChatOptions(body);
      if (unsupportedOptions.length) {
        return createErrorResponse(
          400,
          `Unsupported Chat options for Responses upstream: ${unsupportedOptions.join(', ')}`,
        );
      }
      const apiEndpoint = await getCodeBuddyApiEndpoint();
      const upstreamUrl = `${apiEndpoint}/responses`;
      const upstreamCall = await fetchUpstreamWithRotation({
        buildPlan: async (planContext) => {
          const plan: UpstreamPlan = {
            body: {
              ...buildResponsesBodyFromChat(
                await buildUpstreamBody(body, planContext),
              ),
              stream: Boolean(body.stream),
            },
            headers: new Headers(
              await buildUpstreamHeaders(request, planContext.auth),
            ),
            url: upstreamUrl,
          };

          setDebugUpstreamRequest(debugTrace, {
            body: plan.body,
            headers: headersToRecord(plan.headers),
            method: 'POST',
            url: plan.url,
          });

          return plan;
        },
        debugTrace,
        initialContext: resolvedContext,
        model: String(upstreamBody.model ?? '') || undefined,
        request,
        requestBody: body,
        rotationEnabled: context === undefined,
        route: usageRoute,
        stream: Boolean(body.stream),
      });
      const activeContext = upstreamCall.context;
      const upstreamResponse = upstreamCall.response;
      setDebugTraceCredential(debugTrace, activeContext.credentialFilename);

      if (!upstreamResponse.ok) {
        setDebugTraceError(debugTrace, upstreamCall.detail);
        return buildUpstreamErrorResponse({
          attempts: upstreamCall.attempts,
          detail: upstreamCall.detail,
          response: upstreamResponse,
        });
      }

      if (body.stream) {
        return instrumentStreamResponse(
          mapResponsesStreamToChat(
            upstreamResponse,
            String(upstreamBody.model ?? 'unknown'),
            activeContext,
            usageRoute,
            body.stop,
            Boolean(body.stream_options?.include_usage) ||
              usageRoute === '/v1/messages',
          ),
          {
            credentialFilename: activeContext.credentialFilename,
            model: String(upstreamBody.model ?? 'unknown'),
            route: usageRoute,
          },
        );
      }

      const payload = (await upstreamResponse.json()) as Record<
        string,
        unknown
      >;
      await recordProxyUsage({
        model: String(upstreamBody.model ?? 'unknown'),
        proxyContext: activeContext,
        route: usageRoute,
        usage: payload.usage ?? null,
      });
      if (payload.status === 'failed' || payload.error) {
        const error =
          payload.error && typeof payload.error === 'object'
            ? (payload.error as { message?: unknown })
            : undefined;
        return createErrorResponse(
          502,
          typeof error?.message === 'string'
            ? error.message
            : 'Upstream Responses request failed',
          payload.error,
        );
      }
      return Response.json(
        mapResponsesPayloadToChat(
          payload,
          String(upstreamBody.model ?? 'unknown'),
          body.stop,
        ),
      );
    }

    const apiEndpoint = await getCodeBuddyApiEndpoint();
    const upstreamUrl = `${apiEndpoint}/v2/chat/completions`;
    const upstreamCall = await fetchUpstreamWithRotation({
      buildPlan: async (planContext) => {
        const plan: UpstreamPlan = {
          body: await buildUpstreamBody(body, planContext),
          headers: new Headers(
            await buildUpstreamHeaders(request, planContext.auth),
          ),
          url: upstreamUrl,
        };

        setDebugUpstreamRequest(debugTrace, {
          body: plan.body,
          headers: headersToRecord(plan.headers),
          method: 'POST',
          url: plan.url,
        });

        return plan;
      },
      debugTrace,
      initialContext: resolvedContext,
      model: String(upstreamBody.model ?? '') || undefined,
      request,
      requestBody: body,
      rotationEnabled: context === undefined,
      route: usageRoute,
      stream: Boolean(body.stream),
    });
    const activeContext = upstreamCall.context;
    const upstreamResponse = upstreamCall.response;
    setDebugTraceCredential(debugTrace, activeContext.credentialFilename);

    if (!upstreamResponse.ok) {
      setDebugTraceError(debugTrace, upstreamCall.detail);
      return buildUpstreamErrorResponse({
        attempts: upstreamCall.attempts,
        detail: upstreamCall.detail,
        response: upstreamResponse,
      });
    }

    if (body.stream) {
      return instrumentStreamResponse(
        normalizeStreamingResponse({
          model: String(upstreamBody.model ?? 'unknown'),
          proxyContext: activeContext,
          route: usageRoute,
          upstreamResponse,
        }),
        {
          credentialFilename: activeContext.credentialFilename,
          model: String(upstreamBody.model ?? 'unknown'),
          route: usageRoute,
        },
      );
    }

    const contentType = upstreamResponse.headers.get('content-type') ?? '';

    if (contentType.toLowerCase().includes('application/json')) {
      const payloadText = await upstreamResponse.text();
      let usage: unknown = null;

      try {
        usage = (JSON.parse(payloadText) as { usage?: unknown }).usage ?? null;
      } catch {
        usage = null;
      }

      await recordProxyUsage({
        completionChars: measureCompletionChars(payloadText),
        model: String(upstreamBody.model ?? 'unknown'),
        proxyContext: activeContext,
        route: usageRoute,
        usage,
      });

      return new Response(payloadText, {
        status: upstreamResponse.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    const aggregated = await aggregateUpstreamStream(
      upstreamResponse,
      String(upstreamBody.model ?? 'unknown'),
    );

    await recordProxyUsage({
      model: aggregated.model,
      proxyContext: activeContext,
      route: usageRoute,
      usage: aggregated.usage,
    });

    return aggregated.response;
  } catch (error) {
    setDebugTraceError(debugTrace, error);

    // The dispatch ceiling is the caller's problem, not an upstream fault, so
    // it must not be logged as one or answered with a 500.
    if (error instanceof DispatchCeilingExceededError) {
      return createErrorResponse(
        413,
        error.message,
        {
          bytes: error.bytes,
          limit_bytes: error.limitBytes,
        },
        { code: 'request_too_large', type: 'invalid_request_error' },
      );
    }

    logUpstreamFailure({
      error,
      route: '/v1/chat/completions',
      url: `${await getCodeBuddyApiEndpoint()}/v2/chat/completions`,
    });
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};

export const proxyResponsesUpstream = async (
  request: NextRequest,
  body: Record<string, unknown>,
  context?: ProxyContext,
  debugTrace?: DebugTrace,
  onResponseId?: (responseId: string) => Promise<void>,
): Promise<Response> => {
  try {
    const resolvedContext =
      context ??
      (await resolveProxyContext(
        request,
        typeof body.model === 'string' ? body.model : undefined,
        body,
      ));
    setDebugTraceCredential(debugTrace, resolvedContext.credentialFilename);
    const upstreamBody = {
      ...normalizeResponsesUpstreamBody(body),
      model:
        resolvedContext.resolvedModel ??
        (typeof body.model === 'string' && body.model.trim()
          ? body.model
          : await getDefaultModel()),
    };
    const apiEndpoint = await getCodeBuddyApiEndpoint();
    const upstreamUrl = `${apiEndpoint}/responses`;
    const upstreamStream = Boolean(
      (upstreamBody as { stream?: unknown }).stream,
    );
    const upstreamCall = await fetchUpstreamWithRotation({
      buildPlan: async (planContext) => {
        const plan: UpstreamPlan = {
          body: upstreamBody,
          headers: new Headers(
            await buildUpstreamHeaders(request, planContext.auth),
          ),
          url: upstreamUrl,
        };

        setDebugUpstreamRequest(debugTrace, {
          body: plan.body,
          headers: headersToRecord(plan.headers),
          method: 'POST',
          url: plan.url,
        });

        return plan;
      },
      debugTrace,
      initialContext: resolvedContext,
      model: String(upstreamBody.model ?? '') || undefined,
      request,
      requestBody: body,
      rotationEnabled: context === undefined,
      route: '/v1/responses',
      stream: upstreamStream,
    });
    const upstreamResponse = upstreamCall.response;
    setDebugTraceCredential(
      debugTrace,
      upstreamCall.context.credentialFilename,
    );

    if (!upstreamResponse.ok) {
      setDebugTraceError(debugTrace, upstreamCall.detail);
      return buildUpstreamErrorResponse({
        attempts: upstreamCall.attempts,
        detail: upstreamCall.detail,
        response: upstreamResponse,
      });
    }

    const model = String(upstreamBody.model ?? 'unknown');
    const fallbackUsage = parseUsageHeader(upstreamResponse);
    const contentType = upstreamResponse.headers.get('content-type') ?? '';

    if (contentType.toLowerCase().includes('application/json')) {
      const payloadText = await upstreamResponse.text();
      let usage = fallbackUsage;
      let responseId: string | null = null;

      try {
        const payload = JSON.parse(payloadText) as unknown;
        usage = extractResponsesUsage(payload) ?? fallbackUsage;
        responseId = extractResponsesId(payload);
      } catch {
        // Preserve malformed upstream JSON while retaining header usage.
      }

      if (responseId && onResponseId) {
        await onResponseId(responseId);
      }

      await recordProxyUsage({
        model,
        proxyContext: upstreamCall.context,
        route: '/v1/responses',
        usage,
      });

      return new Response(payloadText, {
        headers: upstreamResponse.headers,
        status: upstreamResponse.status,
      });
    }

    if (contentType.toLowerCase().includes('text/event-stream')) {
      return trackResponsesUsageStream({
        fallbackUsage,
        model,
        onResponseId,
        proxyContext: upstreamCall.context,
        upstreamResponse,
      });
    }

    await recordProxyUsage({
      model,
      proxyContext: upstreamCall.context,
      route: '/v1/responses',
      usage: fallbackUsage,
    });

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  } catch (error) {
    setDebugTraceError(debugTrace, error);
    logUpstreamFailure({
      error,
      route: '/v1/responses',
      url: `${await getCodeBuddyApiEndpoint()}/responses`,
    });
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};
