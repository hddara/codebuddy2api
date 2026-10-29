'use client';

import {
  Alert,
  Block,
  Collapse,
  Empty,
  Flexbox,
  Segmented,
  SkeletonButton,
  SkeletonParagraph,
  SkeletonTags,
  SkeletonTitle,
  Tag,
  Text,
  Tooltip,
} from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Check, Copy, Info, Layers3, RefreshCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';

import type { CredentialSummary } from '@/app/credentials/credentials';
import { formatDateTime } from '@/lib/shared/datetime';

interface AccountStatusProps {
  autoCheckin?: AutoCheckinStatus | null;
  credentials: CredentialSummary[];
  initialStatuses?: AccountStatusSnapshot[];
}

export interface AutoCheckinStatus {
  attempts: number;
  enabled: boolean;
  lastError: string | null;
  lastRunAt: string | null;
  lastStatus: 'completed' | 'failed' | 'idle';
  nextRunAt: string | null;
  result: {
    failed: number;
    finishedAt: string;
    succeeded: number;
    total: number;
  } | null;
  running: boolean;
  time: string;
}

export interface AccountCreditPackage {
  capacityRemain: number | null;
  capacitySize: number | null;
  capacityUsed: number | null;
  capacityUnit: string | null;
  cycleEndTime: string | null;
  cycleStartTime: string | null;
  isExpired: boolean;
  packageName: string | null;
  packageType: string | null;
  status: number | null;
}

export interface AccountCreditPackageType {
  capacityRemain: number | null;
  capacitySize: number | null;
  capacityUsed: number | null;
  cycleEndTime: string | null;
  isExpired: boolean;
  packageCount: number;
  packageType: string | null;
}

export interface AccountStatusSnapshot {
  checkin: { claimed: boolean | null; message: string | null };
  credits: {
    total: number | null;
    used: number | null;
    remaining: number | null;
    plan: string | null;
    resetAt: string | null;
    packages?: AccountCreditPackage[];
    packageTypes?: AccountCreditPackageType[];
    usablePackageCount?: number;
  };
  error: string | null;
  filename: string;
  models: string[];
  queriedAt: string;
}

const initialSnapshot = (filename: string): AccountStatusSnapshot => ({
  checkin: { claimed: null, message: null },
  credits: {
    total: null,
    used: null,
    remaining: null,
    plan: null,
    resetAt: null,
  },
  error: null,
  filename,
  models: [],
  queriedAt: '',
});

const unavailableSnapshot = (filename: string): AccountStatusSnapshot => ({
  ...initialSnapshot(filename),
  error: 'Credential is unavailable',
});

const failedSnapshot = (
  filename: string,
  error: unknown,
): AccountStatusSnapshot => ({
  ...initialSnapshot(filename),
  error: error instanceof Error ? error.message : 'Account status query failed',
  queriedAt: new Date().toISOString(),
});

const quotaPercent = (snapshot: AccountStatusSnapshot): number | null => {
  const { total, remaining } = snapshot.credits;
  if (total === null || total <= 0 || remaining === null) return null;
  return Math.min(100, Math.max(0, (remaining / total) * 100));
};

const QuotaProgress = ({
  plan,
  snapshot,
  unknownLabel,
  remainingLabel,
}: {
  plan: string;
  snapshot: AccountStatusSnapshot;
  unknownLabel: string;
  remainingLabel: (percent: number) => string;
}) => {
  const percent = quotaPercent(snapshot);
  const hasQuota =
    snapshot.credits.total !== null && snapshot.credits.total > 0;
  const tone =
    percent === null
      ? 'unknown'
      : percent <= 0
        ? 'exhausted'
        : percent <= 20
          ? 'warning'
          : 'normal';
  return (
    <Flexbox direction="vertical" gap={8}>
      <Flexbox align="center" distribution="space-between" horizontal>
        <Text strong>{plan}</Text>
        <Flexbox align="center" distribution="flex-end" gap={8} horizontal>
          <Text type="secondary">
            {hasQuota && snapshot.credits.remaining !== null
              ? `${snapshot.credits.remaining} / ${snapshot.credits.total}`
              : '— / —'}
          </Text>
          <Text>{percent === null ? '—' : `${percent.toFixed(0)}%`}</Text>
        </Flexbox>
      </Flexbox>
      <progress
        aria-label={percent === null ? unknownLabel : remainingLabel(percent)}
        className={`account-status-progress account-status-progress-${tone}`}
        max={100}
        value={percent ?? 0}
      />
    </Flexbox>
  );
};

const CopyableModel = ({ model }: { model: string }) => {
  const [copied, setCopied] = useState(false);
  const text = useTranslations('Admin');
  const copy = async () => {
    try {
      let copiedWithModernApi = false;
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(model);
          copiedWithModernApi = true;
        } catch {
          copiedWithModernApi = false;
        }
      }
      if (!copiedWithModernApi) {
        const fallback = document.createElement('textarea');
        fallback.value = model;
        fallback.setAttribute('readonly', '');
        fallback.style.position = 'fixed';
        fallback.style.opacity = '0';
        document.body.append(fallback);
        fallback.select();
        const copiedWithFallback = document.execCommand('copy');
        fallback.remove();
        if (!copiedWithFallback) return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      return;
    }
  };
  return (
    <Tooltip title={copied ? text('common.copy') : text('common.copy')}>
      <Tag onClick={() => void copy()}>
        <Flexbox align="center" gap={4} horizontal>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span data-model-id={model}>{model}</span>
        </Flexbox>
      </Tag>
    </Tooltip>
  );
};

const AccountStatusSkeleton = () => (
  <Block direction="vertical" gap={16} padding={20} variant="outlined">
    <SkeletonTitle />
    <SkeletonParagraph rows={1} />
    <SkeletonParagraph rows={3} />
    <SkeletonTags />
    <SkeletonButton />
  </Block>
);

const formatMoment = (value: string | null, locale: string): string =>
  formatDateTime(value, locale);

const AutoCheckinBar = ({
  onRun,
  running,
  status,
}: {
  onRun: () => void;
  running: boolean;
  status: AutoCheckinStatus | null;
}) => {
  const text = useTranslations('Admin');
  const locale = useLocale();
  const enabled = Boolean(status?.enabled);
  const parts: string[] = [];

  if (status?.enabled) {
    parts.push(text('accountStatus.autoCheckinDaily', { time: status.time }));

    if (status.nextRunAt) {
      parts.push(
        text('accountStatus.autoCheckinNext', {
          time: formatMoment(status.nextRunAt, locale),
        }),
      );
    }

    if (status.result) {
      parts.push(
        status.result.failed
          ? text('accountStatus.autoCheckinFailed', {
              failed: status.result.failed,
              total: status.result.total,
            })
          : text('accountStatus.autoCheckinSucceeded', {
              succeeded: status.result.succeeded,
              total: status.result.total,
            }),
      );
    } else {
      parts.push(text('accountStatus.autoCheckinIdle'));
    }
  }

  return (
    <Flexbox align="center" gap={8} horizontal wrap="wrap">
      <Tag>{text('accountStatus.autoCheckin')}</Tag>
      <Text className="account-status-auto-checkin-summary" type="secondary">
        <span suppressHydrationWarning>
          {enabled ? parts.join(' · ') : text('accountStatus.autoCheckinOff')}
        </span>
      </Text>
      {enabled && status?.lastStatus === 'failed' && status.lastError ? (
        <Tooltip title={status.lastError}>
          <Flexbox
            className="account-status-auto-checkin-error"
            gap={4}
            horizontal
          >
            <Info size={14} />
          </Flexbox>
        </Tooltip>
      ) : null}
      <Button disabled={!enabled || running} loading={running} onClick={onRun}>
        {text('accountStatus.autoCheckinRun')}
      </Button>
    </Flexbox>
  );
};

const formatCredits = (value: number | null): string =>
  value === null ? '—' : String(value);

const percentOf = (
  remaining: number | null,
  size: number | null,
): number | null => {
  if (size === null || size <= 0 || remaining === null) return null;
  return Math.min(100, Math.max(0, (remaining / size) * 100));
};

const toneOf = (percent: number | null, isExpired: boolean): string => {
  if (isExpired) return 'exhausted';
  if (percent === null) return 'unknown';
  return percent <= 20 ? 'warning' : 'normal';
};

/** The package list can be scoped to what the operator needs to see. */
type PackageScope = 'usable' | 'expired' | 'all';

const packageMatchesScope = (
  isExpired: boolean,
  scope: PackageScope,
): boolean =>
  scope === 'all' ||
  (scope === 'usable' && !isExpired) ||
  (scope === 'expired' && isExpired);

const PackageProgress = ({
  isExpired,
  remaining,
  size,
}: {
  isExpired: boolean;
  remaining: number | null;
  size: number | null;
}) => {
  const text = useTranslations('Admin');
  const percent = percentOf(remaining, size);
  return (
    <Flexbox direction="vertical" gap={4}>
      <span className="account-status-package-values">
        {formatCredits(remaining)} / {formatCredits(size)}
        {percent === null ? '' : ` (${percent.toFixed(0)}%)`}
      </span>
      <progress
        aria-label={text('accountStatus.packageRemainingPercent', {
          percent: percent === null ? 0 : Math.round(percent),
        })}
        className={`account-status-progress account-status-progress-${toneOf(percent, isExpired)}`}
        max={100}
        value={percent ?? 0}
      />
    </Flexbox>
  );
};

/**
 * Per-type totals. Packages arrive one per grant, so an account that claims the
 * same daily plan for a month holds dozens of rows that differ only by cycle;
 * this is the view that answers "how much of each plan is left".
 */
const PackageTypeTable = ({ types }: { types: AccountCreditPackageType[] }) => {
  const text = useTranslations('Admin');
  return (
    <div className="account-status-packages">
      <table>
        <thead>
          <tr>
            <th>{text('accountStatus.packageType')}</th>
            <th>{text('accountStatus.packageCount')}</th>
            <th>{text('accountStatus.packageRemaining')}</th>
            <th>{text('accountStatus.packageUsedShort')}</th>
            <th>{text('accountStatus.packageCycleEnd')}</th>
            <th>{text('accountStatus.packageStatus')}</th>
          </tr>
        </thead>
        <tbody>
          {types.map((type, index) => (
            <tr
              className={
                type.isExpired ? 'account-status-package-expired' : undefined
              }
              key={`${type.packageType ?? 'type'}-${type.isExpired}-${index}`}
            >
              <td>
                <Text strong>
                  {type.packageType ?? text('accountStatus.packageUnnamed')}
                </Text>
              </td>
              <td>{type.packageCount}</td>
              <td>
                <PackageProgress
                  isExpired={type.isExpired}
                  remaining={type.capacityRemain}
                  size={type.capacitySize}
                />
              </td>
              <td>{formatCredits(type.capacityUsed)}</td>
              <td>{type.cycleEndTime ?? '—'}</td>
              <td>
                <Tag color={type.isExpired ? 'red' : 'green'}>
                  {type.isExpired
                    ? text('accountStatus.packageExpired')
                    : text('accountStatus.packageActive')}
                </Tag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const PackageBreakdown = ({
  packages,
  scope,
}: {
  packages: AccountCreditPackage[];
  scope: PackageScope;
}) => {
  const text = useTranslations('Admin');
  const visible = packages.filter((quotaPackage) =>
    packageMatchesScope(quotaPackage.isExpired, scope),
  );

  if (!visible.length) {
    return (
      <Text type="secondary">
        {scope === 'expired'
          ? text('accountStatus.noExpiredPackages')
          : text('accountStatus.noPackagesInScope')}
      </Text>
    );
  }

  return (
    <div className="account-status-packages">
      <table>
        <thead>
          <tr>
            <th>{text('accountStatus.packageName')}</th>
            <th>{text('accountStatus.packageRemaining')}</th>
            <th>{text('accountStatus.packageCycle')}</th>
            <th>{text('accountStatus.packageStatus')}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((quotaPackage, index) => (
            <tr
              className={
                quotaPackage.isExpired
                  ? 'account-status-package-expired'
                  : undefined
              }
              key={`${quotaPackage.packageName ?? 'package'}-${index}`}
            >
              <td>
                <Text strong>
                  {quotaPackage.packageName ??
                    text('accountStatus.packageUnnamed')}
                </Text>
                {quotaPackage.capacityUnit ? (
                  <Text
                    className="account-status-package-unit"
                    type="secondary"
                  >
                    {quotaPackage.capacityUnit}
                  </Text>
                ) : null}
              </td>
              <td>
                <PackageProgress
                  isExpired={quotaPackage.isExpired}
                  remaining={quotaPackage.capacityRemain}
                  size={quotaPackage.capacitySize}
                />
                <Text type="secondary">
                  {text('accountStatus.packageUsed', {
                    value: formatCredits(quotaPackage.capacityUsed),
                  })}
                </Text>
              </td>
              <td>
                <Flexbox direction="vertical" gap={2}>
                  <span>
                    {text('accountStatus.packageCycleStart')}:{' '}
                    {quotaPackage.cycleStartTime ?? '—'}
                  </span>
                  <span>
                    {text('accountStatus.packageCycleEnd')}:{' '}
                    {quotaPackage.cycleEndTime ?? '—'}
                  </span>
                </Flexbox>
              </td>
              <td>
                <Tag color={quotaPackage.isExpired ? 'red' : 'green'}>
                  {quotaPackage.isExpired
                    ? text('accountStatus.packageExpired')
                    : text('accountStatus.packageActive')}
                </Tag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const PackageScopeSwitch = ({
  onChange,
  value,
}: {
  onChange: (scope: PackageScope) => void;
  value: PackageScope;
}) => {
  const text = useTranslations('Admin');
  return (
    <Segmented
      onChange={(next) => onChange(next as PackageScope)}
      options={[
        { label: text('accountStatus.packageScopeUsable'), value: 'usable' },
        { label: text('accountStatus.packageScopeExpired'), value: 'expired' },
        { label: text('accountStatus.packageScopeAll'), value: 'all' },
      ]}
      size="small"
      value={value}
      variant="outlined"
    />
  );
};

const AccountStatusCard = ({
  credential,
  snapshot,
  busy,
  onRefresh,
  onCheckin,
}: {
  credential: CredentialSummary;
  snapshot: AccountStatusSnapshot;
  busy: string | null;
  onRefresh: () => void;
  onCheckin: () => void;
}) => {
  const text = useTranslations('Admin');
  const quotaUnknown = text('accountStatus.quotaUnknown');
  // The scope starts at "usable" because that is the question the page exists
  // to answer; seeing expired packages is a deliberate second step.
  const [packageScope, setPackageScope] = useState<PackageScope>('usable');
  const types = useMemo(
    () =>
      (snapshot.credits.packageTypes ?? []).filter((type) =>
        packageMatchesScope(type.isExpired, packageScope),
      ),
    [packageScope, snapshot.credits.packageTypes],
  );
  return (
    <Block
      className={
        busy
          ? 'account-status-card account-status-card-busy'
          : 'account-status-card'
      }
      direction="vertical"
      gap={16}
      padding={20}
      variant="outlined"
    >
      <Flexbox
        align="flex-start"
        className="account-status-card-header"
        distribution="space-between"
        horizontal
        width="100%"
      >
        <Flexbox
          className="account-status-card-identity"
          direction="vertical"
          gap={4}
        >
          <Tooltip title={credential.email || credential.user_id}>
            <Text className="account-status-card-name" strong>
              {credential.email || credential.user_id}
            </Text>
          </Tooltip>
          <Tooltip title={credential.filename}>
            <Text className="account-status-card-filename" type="secondary">
              {credential.filename}
            </Text>
          </Tooltip>
        </Flexbox>
        <Button
          aria-label={text('accountStatus.refresh')}
          icon={RefreshCw}
          loading={busy === 'refresh'}
          disabled={Boolean(busy)}
          onClick={onRefresh}
        >
          {text('accountStatus.refresh')}
        </Button>
      </Flexbox>
      {snapshot.error ? <Alert type="error" title={snapshot.error} /> : null}
      <Flexbox direction="vertical" gap={8}>
        <QuotaProgress
          plan={snapshot.credits.plan ?? '—'}
          snapshot={snapshot}
          unknownLabel={quotaUnknown}
          remainingLabel={(value) =>
            text('accountStatus.quotaUsed', { percent: value.toFixed(0) })
          }
        />
        <Text type="secondary">
          {text('accountStatus.resetAt')}: {snapshot.credits.resetAt ?? '—'}
        </Text>
      </Flexbox>
      {snapshot.credits.packages?.length ? (
        <Collapse
          className="account-status-package-collapse"
          items={[
            {
              children: (
                <Flexbox direction="vertical" gap={20}>
                  {types.length ? (
                    <Flexbox direction="vertical" gap={8}>
                      <Text strong>{text('accountStatus.packageTypes')}</Text>
                      <PackageTypeTable types={types} />
                    </Flexbox>
                  ) : null}
                  <Flexbox direction="vertical" gap={8}>
                    <Flexbox
                      align="center"
                      distribution="space-between"
                      gap={12}
                      horizontal
                      wrap="wrap"
                    >
                      <Text strong>{text('accountStatus.packages')}</Text>
                      <PackageScopeSwitch
                        onChange={setPackageScope}
                        value={packageScope}
                      />
                    </Flexbox>
                    <PackageBreakdown
                      packages={snapshot.credits.packages ?? []}
                      scope={packageScope}
                    />
                  </Flexbox>
                </Flexbox>
              ),
              desc: text('accountStatus.packagesSummary', {
                total: snapshot.credits.packages.length,
                usable: snapshot.credits.usablePackageCount ?? 0,
              }),
              icon: Layers3,
              key: 'packages',
              label: text('accountStatus.packages'),
            },
          ]}
          variant="outlined"
        />
      ) : null}
      <Flexbox
        align="center"
        className="account-status-card-checkin"
        distribution="space-between"
        horizontal
        width="100%"
      >
        <Text className="account-status-card-checkin-label" type="secondary">
          {text('accountStatus.checkin')}:{' '}
          {snapshot.checkin.claimed === true
            ? text('accountStatus.checkedIn')
            : snapshot.checkin.claimed === false
              ? text('accountStatus.notCheckedIn')
              : '—'}
        </Text>
        <Button
          disabled={Boolean(busy) || snapshot.checkin.claimed === true}
          loading={busy === 'checkin'}
          onClick={onCheckin}
        >
          {text('accountStatus.checkinAction')}
        </Button>
      </Flexbox>
      <Flexbox direction="vertical" gap={8}>
        <Text strong>{text('accountStatus.models')}</Text>
        {snapshot.models.length ? (
          <Flexbox gap={8} horizontal wrap="wrap">
            {snapshot.models.map((model) => (
              <CopyableModel key={model} model={model} />
            ))}
          </Flexbox>
        ) : (
          <Text type="secondary">{text('accountStatus.noModels')}</Text>
        )}
      </Flexbox>
    </Block>
  );
};

const AccountStatus = ({
  autoCheckin = null,
  credentials,
  initialStatuses = [],
}: AccountStatusProps) => {
  const text = useTranslations('Admin');
  const [snapshots, setSnapshots] = useState<
    Record<string, AccountStatusSnapshot>
  >(() =>
    Object.fromEntries(
      initialStatuses.map((status) => [status.filename, status]),
    ),
  );
  const [autoCheckinState, setAutoCheckinState] =
    useState<AutoCheckinStatus | null>(autoCheckin);
  const [autoCheckinBusy, setAutoCheckinBusy] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [batchBusy, setBatchBusy] = useState<string | null>(null);
  const runAutoCheckin = useCallback(async () => {
    setAutoCheckinBusy(true);
    try {
      const response = await fetch('/admin-api/auto-checkin', {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(
          `Automatic check-in request failed (${response.status})`,
        );
      }
      const payload = (await response.json()) as {
        status?: AutoCheckinStatus;
      };
      if (payload.status) setAutoCheckinState(payload.status);
    } catch (error) {
      setAutoCheckinState((current) =>
        current
          ? {
              ...current,
              lastError:
                error instanceof Error
                  ? error.message
                  : 'Automatic check-in request failed',
              lastStatus: 'failed',
            }
          : current,
      );
    } finally {
      setAutoCheckinBusy(false);
    }
  }, []);
  const loadOne = useCallback(
    async (filename: string, action: 'refresh' | 'checkin' = 'refresh') => {
      setBusy((current) => ({ ...current, [filename]: action }));
      try {
        const response = await fetch('/admin-api/account-status', {
          body: JSON.stringify({ action, filename }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        });
        if (!response.ok) {
          throw new Error(`Account status request failed (${response.status})`);
        }
        const payload = (await response.json()) as {
          status?: AccountStatusSnapshot;
          statuses?: AccountStatusSnapshot[];
        };
        const snapshot = payload.status ?? payload.statuses?.[0];
        if (snapshot)
          setSnapshots((current) => ({ ...current, [filename]: snapshot }));
      } catch (error) {
        setSnapshots((current) => ({
          ...current,
          [filename]: {
            ...(current[filename] ?? failedSnapshot(filename, error)),
            error:
              error instanceof Error
                ? error.message
                : 'Account status query failed',
          },
        }));
      } finally {
        setBusy((current) => {
          const next = { ...current };
          delete next[filename];
          return next;
        });
      }
    },
    [],
  );
  const loadAll = useCallback(
    async (action: 'refresh' | 'checkin') => {
      setBatchBusy(action);
      try {
        await Promise.all(
          credentials
            .filter((credential) => {
              if (credential.is_expired) return false;
              if (action !== 'checkin') return true;
              return snapshots[credential.filename]?.checkin.claimed !== true;
            })
            .map((credential) => loadOne(credential.filename, action)),
        );
      } finally {
        setBatchBusy(null);
      }
    },
    [credentials, loadOne, snapshots],
  );
  const pageCredentials = useMemo(
    () =>
      credentials.length > 50
        ? credentials.slice((page - 1) * 12, page * 12)
        : credentials,
    [credentials, page],
  );
  const pageCount =
    credentials.length > 50 ? Math.ceil(credentials.length / 12) : 1;
  return (
    <Flexbox direction="vertical" gap={24}>
      <Flexbox
        align="center"
        distribution="space-between"
        gap={12}
        horizontal
        wrap="wrap"
      >
        <Flexbox gap={8} horizontal>
          <Button
            loading={batchBusy === 'refresh'}
            disabled={Boolean(batchBusy) || !credentials.length}
            onClick={() => void loadAll('refresh')}
          >
            {text('accountStatus.refreshAll')}
          </Button>
          <Button
            loading={batchBusy === 'checkin'}
            disabled={Boolean(batchBusy) || !credentials.length}
            onClick={() => void loadAll('checkin')}
          >
            {text('accountStatus.checkinAll')}
          </Button>
        </Flexbox>
        <AutoCheckinBar
          onRun={() => void runAutoCheckin()}
          running={autoCheckinBusy}
          status={autoCheckinState}
        />
      </Flexbox>
      {credentials.length ? (
        pageCredentials.map((credential) => {
          const snapshot = snapshots[credential.filename];
          if (!snapshot && !credential.is_expired) {
            return <AccountStatusSkeleton key={credential.filename} />;
          }
          return (
            <AccountStatusCard
              credential={credential}
              key={credential.filename}
              snapshot={snapshot ?? unavailableSnapshot(credential.filename)}
              busy={busy[credential.filename] ?? null}
              onCheckin={() => void loadOne(credential.filename, 'checkin')}
              onRefresh={() => void loadOne(credential.filename)}
            />
          );
        })
      ) : (
        <Empty title={text('accountStatus.empty')} />
      )}
      {pageCount > 1 ? (
        <Flexbox align="center" gap={8} horizontal>
          <Button
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            ‹
          </Button>
          <Text>
            {page} / {pageCount}
          </Text>
          <Button
            disabled={page >= pageCount}
            onClick={() => setPage((value) => value + 1)}
          >
            ›
          </Button>
        </Flexbox>
      ) : null}
    </Flexbox>
  );
};

export default AccountStatus;
