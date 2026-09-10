// Client-side request helpers shared by the console controllers. The
// server-side initial-data loader keeps its own copy in `app/page-loader.ts`.
import type {
  AccessKeySummary,
  CredentialSummary,
} from '@/app/credentials/credentials';
import type { DebugLogEntry } from '@/app/debug/debug';
import type {
  UsageChartSeries,
  UsageFilterOption,
  UsageRange,
} from '@/app/usage/usage';

export interface CredentialsResponse {
  credentials?: CredentialSummary[];
}

export interface SettingsResponse {
  labels?: Record<string, string>;
  settings?: Record<string, string | number | null>;
}

export interface DebugResponse {
  autoRefreshSeconds?: number;
  enabled?: boolean;
  items?: DebugLogEntry[];
  maxEntries?: number;
  message?: string;
  pending?: boolean;
}

export interface DebugDetailResponse {
  item?: DebugLogEntry | null;
}

export interface CredentialModelsResponse {
  models?: Record<
    string,
    { error?: string | null; models?: Array<{ id?: string }> }
  >;
}

export interface AccessKeysResponse {
  access_keys?: AccessKeySummary[];
}

export interface AccessKeySecretResponse {
  id?: string;
  name?: string;
  secret?: string;
}

export interface CurrentCredentialResponse {
  available_credential_count?: number;
  filename?: string;
  index?: number;
  next_filename?: string | null;
  status?: string;
  user_id?: string;
}

export interface StartAuthResponse {
  auth_state?: string;
  error?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
  success?: boolean;
  verification_uri_complete?: string;
}

export interface PollAuthResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  filename?: string;
  message?: string;
}

export interface UsageResponse {
  callSeries?: UsageChartSeries[];
  credentialRows?: Array<{
    cacheHitTokens?: number;
    callCount?: number;
    credentialFilename?: string;
    totalTokens?: number;
  }>;
  filters?: {
    accessKeys?: UsageFilterOption[];
    credentials?: UsageFilterOption[];
  };
  range?: UsageRange;
  tableRows?: Array<{
    callCount?: number;
    cacheHitTokens?: number;
    model?: string;
    totalTokens?: number;
  }>;
  rangeSummary?: {
    cacheHitTokens?: number;
    callCount?: number;
    totalTokens?: number;
  };
  tokenSeries?: UsageChartSeries[];
}

export interface ApiTestSuccess {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
    message?: {
      content?: unknown;
    };
  }>;
}

export interface JsonResult<T> {
  data: T | null;
  ok: boolean;
  status: number;
}

export const requestJson = async <T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<JsonResult<T>> => {
  const response = await fetch(input, init);
  const text = await response.text();

  if (!text.trim()) {
    return {
      data: null,
      ok: response.ok,
      status: response.status,
    };
  }

  try {
    return {
      data: JSON.parse(text) as T,
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return {
      data: null,
      ok: response.ok,
      status: response.status,
    };
  }
};

export const getErrorMessage = (payload: unknown, fallback: string) => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const message =
    (payload as Record<string, unknown>).message ??
    (payload as Record<string, unknown>).error_description ??
    (payload as Record<string, unknown>).error;

  return typeof message === 'string' && message.trim() ? message : fallback;
};

export const buildApiEndpoint = () => {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:8001/v1';
  }

  return `${window.location.origin}/v1`;
};

export const formatResult = (payload: unknown) => {
  if (typeof payload === 'string') {
    return payload;
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return 'Unable to render response.';
  }
};

export const getSseEventContent = (event: string) => {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');

  if (!data || data === '[DONE]') {
    return '';
  }

  try {
    const payload = JSON.parse(data) as ApiTestSuccess;
    const content =
      payload.choices?.[0]?.delta?.content ??
      payload.choices?.[0]?.message?.content;

    return typeof content === 'string' ? content : '';
  } catch {
    return data;
  }
};
