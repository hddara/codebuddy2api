'use client';

import { Block, Input } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Alert, Popconfirm, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { atom } from 'jotai';
import {
  Gauge,
  Infinity as InfinityIcon,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

import { showConsoleNotification } from '@/app/console-notify';
import { SectionTitle } from '@/app/credentials/section-title';

export type QuotaOwnerType = 'app' | 'user';

export type QuotaPeriod = 'daily' | 'monthly' | 'total';

export interface ConsoleQuotaBalance {
  configured: boolean;
  degraded: boolean;
  maxCalls: number | null;
  maxTokens: number | null;
  name: string;
  ownerId: string;
  ownerType: QuotaOwnerType;
  period: QuotaPeriod;
  periodStart: string;
  remainingCalls: number | null;
  remainingTokens: number | null;
  resetAt: string | null;
  usedCalls: number;
  usedTokens: number;
}

export interface QuotasState {
  balances: ConsoleQuotaBalance[];
  error: string | null;
  loading: boolean;
  saving: boolean;
}

export const defaultQuotasState: QuotasState = {
  balances: [],
  error: null,
  loading: true,
  saving: false,
};

export const quotasStateAtom = atom<QuotasState>(defaultQuotasState);

export interface QuotaTarget {
  ownerId: string;
  ownerType: QuotaOwnerType;
}

export interface QuotasController {
  onClear: (target: QuotaTarget) => void;
  onRefresh: () => void;
  onSave: (
    target: QuotaTarget,
    limits: { maxCalls: number | null; maxTokens: number | null },
  ) => Promise<boolean>;
  state: QuotasState;
}

const QuotasContext = createContext<QuotasController | null>(null);

export const QuotasProvider = QuotasContext.Provider;

const useQuotas = (): QuotasController => {
  const controller = useContext(QuotasContext);

  if (!controller) {
    throw new Error('Quotas controller is unavailable');
  }

  return controller;
};

const Field = ({ children, label }: { children: ReactNode; label: string }) => (
  <label className="grid gap-1">
    <span className="text-secondary">{label}</span>
    {children}
  </label>
);

const Quotas = () => {
  const { onClear, onRefresh, onSave, state } = useQuotas();
  const translations = useTranslations('Admin');
  const [editing, setEditing] = useState<QuotaTarget | null>(null);
  const [maxCalls, setMaxCalls] = useState('');
  const [maxTokens, setMaxTokens] = useState('');

  const formatLimit = (
    max: number | null,
    used: number,
    remaining: number | null,
  ) => {
    if (max === null) {
      return (
        <div className="grid gap-1">
          <span>{used.toLocaleString()}</span>
          <span className="text-secondary">
            {translations('quotasPage.unlimited')}
          </span>
        </div>
      );
    }

    return (
      <div className="grid gap-1">
        <span>
          {used.toLocaleString()} / {max.toLocaleString()}
        </span>
        <span className="text-secondary">
          {translations('quotasPage.remaining')}{' '}
          {(remaining ?? 0).toLocaleString()}
        </span>
      </div>
    );
  };

  const openEdit = (balance: ConsoleQuotaBalance) => {
    setEditing({ ownerId: balance.ownerId, ownerType: balance.ownerType });
    setMaxCalls(balance.maxCalls === null ? '' : String(balance.maxCalls));
    setMaxTokens(balance.maxTokens === null ? '' : String(balance.maxTokens));
  };

  const parseLimit = (value: string): number | null | undefined => {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    const parsed = Number(trimmed);

    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const submit = async () => {
    if (!editing) {
      return;
    }

    const calls = parseLimit(maxCalls);
    const tokens = parseLimit(maxTokens);

    if (calls === undefined || tokens === undefined) {
      showConsoleNotification('error', translations('quotasPage.errorLimit'));
      return;
    }

    if (await onSave(editing, { maxCalls: calls, maxTokens: tokens })) {
      setEditing(null);
    }
  };

  const columns: TableColumnsType<ConsoleQuotaBalance> = [
    {
      dataIndex: 'name',
      key: 'name',
      render: (name: string, balance) => (
        <div className="grid gap-1">
          <span>{name}</span>
          <Tag>
            {balance.ownerType === 'app'
              ? translations('quotasPage.ownerApp')
              : translations('quotasPage.ownerUser')}
          </Tag>
        </div>
      ),
      title: translations('quotasPage.owner'),
    },
    {
      dataIndex: 'usedCalls',
      key: 'calls',
      render: (usedCalls: number, balance) =>
        formatLimit(balance.maxCalls, usedCalls, balance.remainingCalls),
      title: translations('quotasPage.calls'),
    },
    {
      dataIndex: 'usedTokens',
      key: 'tokens',
      render: (usedTokens: number, balance) =>
        formatLimit(balance.maxTokens, usedTokens, balance.remainingTokens),
      title: translations('quotasPage.tokens'),
    },
    {
      dataIndex: 'resetAt',
      key: 'resetAt',
      render: (resetAt: string | null, balance) =>
        balance.configured
          ? resetAt
            ? new Date(resetAt).toLocaleString()
            : translations('quotasPage.never')
          : translations('quotasPage.notConfigured'),
      title: translations('quotasPage.resetAt'),
    },
    {
      key: 'actions',
      render: (_, balance) => (
        <div className="flex gap-2">
          <Button icon={Pencil} onClick={() => openEdit(balance)} size="small">
            {translations('quotasPage.edit')}
          </Button>
          <Popconfirm
            cancelText={translations('common.cancel')}
            description={translations('quotasPage.clearConfirm')}
            okText={translations('quotasPage.clear')}
            onConfirm={() =>
              onClear({
                ownerId: balance.ownerId,
                ownerType: balance.ownerType,
              })
            }
            title={translations('quotasPage.clear')}
          >
            <Button
              danger
              disabled={!balance.configured}
              icon={Trash2}
              size="small"
            >
              {translations('quotasPage.clear')}
            </Button>
          </Popconfirm>
        </div>
      ),
      title: translations('quotasPage.actions'),
    },
  ];

  const degraded = state.balances.some((balance) => balance.degraded);

  return (
    <div className="block" id="quotas">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle icon={Gauge} title={translations('quotasPage.title')} />
          <Button icon={RefreshCw} onClick={onRefresh}>
            {translations('common.refresh')}
          </Button>
        </div>
        {state.error ? (
          <Alert showIcon title={state.error} type="error" />
        ) : null}
        {degraded ? (
          <Alert
            description={translations('quotasPage.degraded')}
            showIcon
            type="warning"
          />
        ) : null}
        {editing ? (
          <Block direction="vertical" gap={12} padding={16} variant="outlined">
            <h4 className="section-title">
              {translations('quotasPage.formEdit')}
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={translations('quotasPage.maxCalls')}>
                <Input
                  min={0}
                  onChange={(event) => setMaxCalls(event.target.value)}
                  placeholder={translations('quotasPage.unlimited')}
                  type="number"
                  value={maxCalls}
                />
              </Field>
              <Field label={translations('quotasPage.maxTokens')}>
                <Input
                  min={0}
                  onChange={(event) => setMaxTokens(event.target.value)}
                  placeholder={translations('quotasPage.unlimited')}
                  type="number"
                  value={maxTokens}
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <InfinityIcon size={16} strokeWidth={2} />
              <span className="text-secondary">
                {translations('quotasPage.unlimitedHint')}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                disabled={state.saving}
                icon={Save}
                loading={state.saving}
                onClick={() => void submit()}
                type="primary"
              >
                {translations('common.save')}
              </Button>
              <Button icon={X} onClick={() => setEditing(null)}>
                {translations('common.cancel')}
              </Button>
            </div>
          </Block>
        ) : null}
        {state.loading ? (
          <div className="py-8 text-center text-secondary">
            <LoaderCircle />
            <div>{translations('common.loading')}</div>
          </div>
        ) : (
          <Table<ConsoleQuotaBalance>
            columns={columns}
            dataSource={state.balances}
            pagination={false}
            rowKey={(balance) => `${balance.ownerType}-${balance.ownerId}`}
            scroll={{ x: 'max-content' }}
            size="middle"
          />
        )}
      </Block>
    </div>
  );
};

export default Quotas;
