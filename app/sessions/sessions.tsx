'use client';

import { Block } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Alert, Popconfirm, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { atom } from 'jotai';
import {
  Eye,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';

import { formatResult } from '@/app/console-request';
import { SectionTitle } from '@/app/credentials/section-title';

export type SessionProtocol = 'anthropic' | 'chat' | 'responses';

export interface SessionLogSummary {
  accessKeyId: string | null;
  accessKeyName: string | null;
  createdAt: string;
  id: string;
  messageCount: number;
  model: string;
  protocol: SessionProtocol;
  route: string;
  truncated: boolean;
  userId: string | null;
}

export interface SessionLogEntry extends SessionLogSummary {
  messages: unknown[];
  upstreamRequest: unknown;
}

export interface SessionLogState {
  degraded: boolean;
  enabled: boolean;
  retentionDays: number;
  storageError: string | null;
}

export interface SessionsState {
  error: string | null;
  loading: boolean;
  logs: SessionLogSummary[];
  selected: SessionLogEntry | null;
  state: SessionLogState;
}

export const defaultSessionsState: SessionsState = {
  error: null,
  loading: true,
  logs: [],
  selected: null,
  state: {
    degraded: false,
    enabled: true,
    retentionDays: 30,
    storageError: null,
  },
};

export const sessionsStateAtom = atom<SessionsState>(defaultSessionsState);

export interface SessionsController {
  canClear: boolean;
  onClear: () => void;
  onRefresh: () => void;
  onSelect: (id: string | null) => void;
  state: SessionsState;
}

const SessionsContext = createContext<SessionsController | null>(null);

export const SessionsProvider = SessionsContext.Provider;

const useSessions = (): SessionsController => {
  const controller = useContext(SessionsContext);

  if (!controller) {
    throw new Error('Sessions controller is unavailable');
  }

  return controller;
};

const Sessions = () => {
  const { canClear, onClear, onRefresh, onSelect, state } = useSessions();
  const translations = useTranslations('Admin');

  const protocolLabels: Record<SessionProtocol, string> = {
    anthropic: 'Anthropic',
    chat: 'Chat',
    responses: 'Responses',
  };

  const columns: TableColumnsType<SessionLogSummary> = [
    {
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (createdAt: string) => new Date(createdAt).toLocaleString(),
      title: translations('sessionsPage.createdAt'),
    },
    {
      dataIndex: 'protocol',
      key: 'protocol',
      render: (protocol: SessionProtocol) => (
        <Tag>{protocolLabels[protocol]}</Tag>
      ),
      title: translations('sessionsPage.protocol'),
    },
    {
      dataIndex: 'model',
      key: 'model',
      title: translations('sessionsPage.model'),
    },
    {
      dataIndex: 'accessKeyName',
      key: 'accessKey',
      render: (accessKeyName: string | null, log) => (
        <div className="grid gap-1">
          <span>
            {accessKeyName ?? translations('sessionsPage.unknownApplication')}
          </span>
          <span className="text-secondary">{log.route}</span>
        </div>
      ),
      title: translations('sessionsPage.application'),
    },
    {
      dataIndex: 'messageCount',
      key: 'messageCount',
      render: (messageCount: number, log) => (
        <div className="flex items-center gap-2">
          <span>{messageCount.toLocaleString()}</span>
          {log.truncated ? (
            <Tag color="orange">{translations('sessionsPage.truncated')}</Tag>
          ) : null}
        </div>
      ),
      title: translations('sessionsPage.messages'),
    },
    {
      key: 'actions',
      render: (_, log) => (
        <Button icon={Eye} onClick={() => onSelect(log.id)} size="small">
          {translations('sessionsPage.view')}
        </Button>
      ),
      title: translations('sessionsPage.actions'),
    },
  ];

  return (
    <div className="block" id="sessions">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle
            icon={MessagesSquare}
            title={translations('sessionsPage.title')}
          />
          <div className="flex gap-2">
            <Button icon={RefreshCw} onClick={onRefresh}>
              {translations('common.refresh')}
            </Button>
            {canClear ? (
              <Popconfirm
                cancelText={translations('common.cancel')}
                description={translations('sessionsPage.clearConfirm')}
                okText={translations('sessionsPage.clear')}
                onConfirm={onClear}
                title={translations('sessionsPage.clear')}
              >
                <Button danger icon={Trash2}>
                  {translations('sessionsPage.clear')}
                </Button>
              </Popconfirm>
            ) : null}
          </div>
        </div>
        {state.state.degraded ? (
          <Alert
            description={translations('sessionsPage.degraded', {
              days: state.state.retentionDays,
            })}
            showIcon
            type="warning"
          />
        ) : null}
        {state.error ? (
          <Alert showIcon title={state.error} type="error" />
        ) : null}
        {state.loading ? (
          <div className="py-8 text-center text-secondary">
            <LoaderCircle />
            <div>{translations('common.loading')}</div>
          </div>
        ) : (
          <Table<SessionLogSummary>
            columns={columns}
            dataSource={state.logs}
            pagination={false}
            rowKey="id"
            scroll={{ x: 'max-content' }}
            size="middle"
          />
        )}
      </Block>
      {state.selected ? (
        <Block direction="vertical" gap={16} padding={24} variant="outlined">
          <div className="flex items-center justify-between gap-3">
            <SectionTitle
              icon={MessagesSquare}
              title={translations('sessionsPage.detailTitle')}
            />
            <Button onClick={() => onSelect(null)}>
              {translations('sessionsPage.close')}
            </Button>
          </div>
          <div className="grid gap-2">
            <span className="text-secondary">
              {translations('sessionsPage.messages')}
            </span>
            <pre className="session-json">
              {formatResult(state.selected.messages)}
            </pre>
          </div>
          <div className="grid gap-2">
            <span className="text-secondary">
              {translations('sessionsPage.upstreamRequest')}
            </span>
            <pre className="session-json">
              {formatResult(state.selected.upstreamRequest)}
            </pre>
          </div>
        </Block>
      ) : null}
    </div>
  );
};

export default Sessions;
