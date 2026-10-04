'use client';

import { Block, Flexbox } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { atom, useAtomValue } from 'jotai';
import { LoaderCircle, Radio, RefreshCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { createContext, useContext, useMemo } from 'react';

/**
 * One conversation the gateway served, folded from usage events by the
 * `x-conversation-id` the IDE sends on every request.
 */
export interface SessionRow {
  callCount: number;
  conversationId: string;
  /** ISO timestamp of the most recent event in this conversation. */
  lastActiveAt: string;
  models: string[];
  totalTokens: number;
}

export interface SessionsSnapshot {
  rows: SessionRow[];
  totals: {
    calls: number;
    sessions: number;
    totalTokens: number;
  };
  /** Events that carried no conversation id and therefore cannot be grouped. */
  ungroupedEvents: number;
  updatedAtLabel: string;
  windowMinutes: number;
}

export interface SessionsState {
  errorMessage: string | null;
  lastUpdatedAt: string;
  loading: boolean;
  request: { windowMinutes: number };
  rows: SessionRow[];
  totals: SessionsSnapshot['totals'];
  ungroupedEvents: number;
  windowMinutes: number;
}

export const SESSION_WINDOW_OPTIONS = [
  { labelKey: 'window1h', value: 60 },
  { labelKey: 'window6h', value: 6 * 60 },
  { labelKey: 'window24h', value: 24 * 60 },
  { labelKey: 'window7d', value: 7 * 24 * 60 },
] as const;

export const defaultSessionsState: SessionsState = {
  errorMessage: null,
  lastUpdatedAt: '',
  loading: true,
  request: { windowMinutes: 24 * 60 },
  rows: [],
  totals: { calls: 0, sessions: 0, totalTokens: 0 },
  ungroupedEvents: 0,
  windowMinutes: 24 * 60,
};

export const sessionsStateAtom = atom<SessionsState>(defaultSessionsState);

export interface SessionsController {
  loadSessions: (windowMinutes?: number) => Promise<void>;
  refresh: () => Promise<void>;
  setWindowMinutes: (windowMinutes: number) => Promise<void>;
}

export const SessionsContext = createContext<SessionsController | null>(null);

export const SessionsProvider = SessionsContext.Provider;

export const useSessions = (): SessionsController => {
  const controller = useContext(SessionsContext);

  if (!controller) {
    throw new Error('Sessions controller is unavailable');
  }

  return controller;
};

export const createSessionsState = (
  initialData: { sessions?: SessionsSnapshot } = {},
): SessionsState => ({
  ...defaultSessionsState,
  lastUpdatedAt: initialData.sessions?.updatedAtLabel ?? '',
  loading: false,
  request: {
    windowMinutes:
      initialData.sessions?.windowMinutes ??
      defaultSessionsState.request.windowMinutes,
  },
  rows: initialData.sessions?.rows ?? [],
  totals: initialData.sessions?.totals ?? defaultSessionsState.totals,
  ungroupedEvents: initialData.sessions?.ungroupedEvents ?? 0,
  windowMinutes:
    initialData.sessions?.windowMinutes ?? defaultSessionsState.windowMinutes,
});

const formatDateTime = (value: string, locale: string): string => {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(locale);
};

const formatRelative = (value: string, locale: string): string => {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const seconds = Math.round((Date.now() - parsed.getTime()) / 1000);

  if (seconds < 60) {
    return locale.startsWith('zh') ? `${seconds} 秒前` : `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return locale.startsWith('zh') ? `${minutes} 分钟前` : `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  return locale.startsWith('zh') ? `${hours} 小时前` : `${hours}h ago`;
};

interface SessionsViewProps {
  onRefresh: (windowMinutes: number) => void;
  onWindowChange: (windowMinutes: number) => void;
  state: SessionsState;
}

/**
 * Session list view. State arrives from the shell so the shell owns loading and
 * this module owns presentation, matching the usage/debug tabs.
 */
export const SessionsView = ({
  onRefresh,
  onWindowChange,
  state,
}: SessionsViewProps) => {
  const translations = useTranslations('Admin');
  const locale = useLocale();

  const columns = useMemo<TableColumnsType<SessionRow>>(
    () => [
      {
        dataIndex: 'conversationId',
        key: 'conversationId',
        render: (value: string) => (
          <code className={'break-all font-mono text-sm'}>{value}</code>
        ),
        title: translations('sessions.columnConversation'),
        width: 300,
      },
      {
        dataIndex: 'models',
        key: 'models',
        render: (models: string[]) => models.join(', ') || '-',
        title: translations('sessions.columnModel'),
        width: 220,
      },
      {
        dataIndex: 'callCount',
        key: 'callCount',
        title: translations('sessions.columnCalls'),
        width: 100,
      },
      {
        dataIndex: 'totalTokens',
        key: 'totalTokens',
        title: translations('sessions.columnTokens'),
        width: 120,
      },
      {
        dataIndex: 'lastActiveAt',
        key: 'lastActiveAt',
        render: (value: string) => (
          <span title={formatDateTime(value, locale)}>
            {formatRelative(value, locale)}
          </span>
        ),
        title: translations('sessions.columnLastActive'),
        width: 160,
      },
    ],
    [locale, translations],
  );

  return (
    <Flexbox gap={16}>
      <Block padding={16} variant={'outlined'}>
        <Flexbox gap={12}>
          <Flexbox
            align={'center'}
            gap={12}
            horizontal
            justify={'space-between'}
          >
            <Flexbox align={'center'} gap={8} horizontal>
              <Radio size={18} />
              <span className={'font-medium'}>
                {translations('sessions.windowLabel')}
              </span>
            </Flexbox>
            <Flexbox align={'center'} gap={8} horizontal>
              <Select
                className={'sessions-window-select'}
                onChange={(value) => onWindowChange(Number(value))}
                options={SESSION_WINDOW_OPTIONS.map((option) => ({
                  label: translations(`sessions.${option.labelKey}`),
                  value: option.value,
                }))}
                value={state.windowMinutes}
              />
              <Button
                disabled={state.loading}
                icon={
                  state.loading ? (
                    <LoaderCircle className={'animate-spin'} size={16} />
                  ) : (
                    <RefreshCw size={16} />
                  )
                }
                onClick={() => onRefresh(state.windowMinutes)}
              >
                {translations('sessions.refresh')}
              </Button>
            </Flexbox>
          </Flexbox>

          <Flexbox className={'sessions-meta'} gap={4}>
            <span>
              {translations('sessions.summary', {
                calls: state.totals.calls,
                sessions: state.totals.sessions,
              })}
            </span>
            {state.ungroupedEvents > 0 ? (
              <span className={'sessions-meta-muted'}>
                {translations('sessions.ungrouped', {
                  count: state.ungroupedEvents,
                })}
              </span>
            ) : null}
            {state.lastUpdatedAt ? (
              <span className={'sessions-meta-faint'}>
                {translations('sessions.updatedAt', {
                  time: state.lastUpdatedAt,
                })}
              </span>
            ) : null}
            {state.errorMessage ? (
              <span className={'sessions-meta-error'}>
                {state.errorMessage}
              </span>
            ) : null}
          </Flexbox>
        </Flexbox>
      </Block>

      <Block padding={16} variant={'outlined'}>
        <Table<SessionRow>
          columns={columns}
          dataSource={state.rows}
          loading={state.loading}
          locale={{ emptyText: translations('sessions.empty') }}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          rowKey={'conversationId'}
          size={'small'}
        />
      </Block>
    </Flexbox>
  );
};

/**
 * Tab entry point. The shell provides the controller (data loading lives there,
 * next to every other tab's loader) and this component renders the table.
 */
const Sessions = () => {
  const { loadSessions } = useSessions();
  const state = useAtomValue(sessionsStateAtom);

  return (
    <SessionsView
      onRefresh={(windowMinutes) => {
        void loadSessions(windowMinutes);
      }}
      onWindowChange={(windowMinutes) => {
        void loadSessions(windowMinutes);
      }}
      state={state}
    />
  );
};

export default Sessions;
