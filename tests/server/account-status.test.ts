import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/domain/config', () => ({
  getCodeBuddyApiEndpoint: vi.fn(),
}));
vi.mock('@/lib/server/domain/credentials', () => ({
  listCredentials: vi.fn(),
  listEligibleCredentialRecords: vi.fn(),
}));
vi.mock('@/lib/server/proxy/codebuddy', () => ({
  getModelsForCredential: vi.fn(),
}));

const { getCodeBuddyApiEndpoint } = await import('@/lib/server/domain/config');
const { listCredentials, listEligibleCredentialRecords } =
  await import('@/lib/server/domain/credentials');
const { getModelsForCredential } = await import('@/lib/server/proxy/codebuddy');
const {
  checkinAccount,
  checkinAccounts,
  getAccountStatus,
  getAccountStatusCredentials,
} = await import('@/lib/server/domain/account-status');

const credential = (filename: string) => ({
  data: { bearer_token: `token-${filename}` },
  filePath: `/tmp/${filename}`,
  filename,
});

/**
 * Mirrors the upstream `get-user-resource` shape: capacity lives per package and
 * each package carries its own cycle, so the totals have to be summed over the
 * usable ones only.
 */
const quotaPayload = (
  packages: Array<Record<string, unknown>>,
  totalDosage?: number,
) => ({
  code: 0,
  data: {
    Response: {
      Data: {
        Accounts: packages,
        TotalCount: packages.length,
        TotalDosage:
          totalDosage ??
          packages.reduce(
            (sum, item) => sum + Number(item.CycleCapacityRemain ?? 0),
            0,
          ),
      },
    },
  },
});

const quotaPackage = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  CapacityUnit: 'credits',
  CycleCapacityRemain: 750,
  CycleCapacitySize: 1000,
  CycleCapacityUsed: 250,
  CycleEndTime: '2026-09-30 23:59:59',
  CycleStartTime: '2026-09-01 00:00:00',
  PackageName: 'Pro',
  Status: 0,
  ...overrides,
});

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

describe('account status domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCodeBuddyApiEndpoint).mockResolvedValue(
      'https://codebuddy.example.test',
    );
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      credential('one.json'),
    ] as never);
    vi.mocked(listCredentials).mockResolvedValue({ credentials: [] } as never);
    vi.mocked(getModelsForCredential).mockResolvedValue([
      { displayName: 'Model One', id: 'model-one' },
    ]);
  });

  it('normalizes quota, check-in, and models', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(quotaPayload([quotaPackage()])))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));
    const [result] = await getAccountStatus();
    expect(result).toMatchObject({
      credits: {
        total: 1000,
        used: 250,
        remaining: 750,
        plan: 'Pro',
        resetAt: '2026-09-30 23:59:59',
        usablePackageCount: 1,
      },
      checkin: { claimed: true },
      models: ['model-one'],
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('excludes expired packages from the usable totals', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(
          quotaPayload(
            [
              quotaPackage(),
              quotaPackage({
                CycleCapacityRemain: 9999,
                CycleCapacitySize: 9999,
                CycleCapacityUsed: 0,
                CycleEndTime: '2027-06-24 14:25:16',
                PackageName: 'Expired pack',
                Status: 3,
              }),
            ],
            10749,
          ),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    // The expired 9999 package must not inflate any of the totals, even though
    // the upstream account-level TotalDosage (10749) does include it.
    expect(result.credits).toMatchObject({
      remaining: 750,
      resetAt: '2026-09-30 23:59:59',
      total: 1000,
      used: 250,
      usablePackageCount: 1,
    });
    expect(result.credits.packages).toHaveLength(2);
    expect(result.credits.packages[1]).toMatchObject({
      packageName: 'Expired pack',
      status: 3,
    });
  });

  it('sums several usable packages and reports the soonest reset', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(
          quotaPayload([
            quotaPackage(),
            quotaPackage({
              CycleCapacityRemain: 1456,
              CycleCapacitySize: 1500,
              CycleCapacityUsed: 43,
              CycleEndTime: '2026-10-15 15:57:04',
              PackageName: '裂变包',
            }),
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.credits).toMatchObject({
      plan: 'Pro + 裂变包',
      remaining: 2206,
      resetAt: '2026-09-30 23:59:59',
      total: 2500,
      used: 293,
      usablePackageCount: 2,
    });
  });

  it('records partial upstream errors', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(quotaPayload([])))
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 404));
    vi.mocked(getModelsForCredential).mockRejectedValueOnce(
      new Error('models unavailable'),
    );
    const [result] = await getAccountStatus();
    expect(result.credits.total).toBeNull();
    expect(result.error).toContain('returned 404');
    expect(result.error).toContain('models unavailable');
  });

  it('keeps non-numeric package capacity unknown', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(
          quotaPayload([
            {
              CycleCapacityRemain: '3',
              CycleCapacitySize: 'not-a-number',
              CycleCapacityUsed: '2',
              CycleEndTime: 'tomorrow',
              PackageName: 'Team',
              Status: 0,
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'PENDING' }));

    const [result] = await getAccountStatus();

    expect(result).toMatchObject({
      checkin: { claimed: false, message: 'PENDING' },
      credits: {
        plan: 'Team',
        remaining: 3,
        resetAt: 'tomorrow',
        total: null,
        used: 2,
        usablePackageCount: 1,
      },
    });
  });

  it('searches nested arrays and supports access-token credentials', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValueOnce([
      {
        data: { access_token: 'access-token-only' },
        filePath: '/tmp/array.json',
        filename: 'array.json',
      },
    ] as never);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(
          quotaPayload([
            quotaPackage({
              CycleCapacityRemain: 8,
              CycleCapacitySize: 12,
              CycleCapacityUsed: 4,
            }),
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ claimed: true }] }));

    const [result] = await getAccountStatus();

    expect(result.credits).toMatchObject({ total: 12, used: 4, remaining: 8 });
    expect(result.checkin.claimed).toBe(true);
  });

  it('returns the configured credential summaries', async () => {
    vi.mocked(listCredentials).mockResolvedValueOnce({
      credentials: [{ filename: 'summary.json' }],
    } as never);

    await expect(getAccountStatusCredentials()).resolves.toEqual([
      { filename: 'summary.json' },
    ]);
  });

  it('handles non-Error upstream failures without discarding other results', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce('quota unavailable')
      .mockResolvedValueOnce(jsonResponse({ checkedIn: false }));
    vi.mocked(getModelsForCredential).mockRejectedValueOnce(
      'models unavailable',
    );

    const [result] = await getAccountStatus();

    expect(result.checkin.claimed).toBe(false);
    expect(result.error).toContain('Credits query failed');
    expect(result.error).toContain('Model query failed');
  });

  it('checks in and refreshes one account', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse(
          quotaPayload([
            quotaPackage({
              CycleCapacityRemain: 8,
              CycleCapacitySize: 10,
              CycleCapacityUsed: 2,
            }),
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ claimed: true }));
    const result = await checkinAccount('one.json');
    expect(result.credits.remaining).toBe(8);
  });

  it('returns a refreshed error snapshot when check-in fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(
        jsonResponse(
          quotaPayload([
            quotaPackage({
              CycleCapacityRemain: 2,
              CycleCapacitySize: 3,
              CycleCapacityUsed: 1,
            }),
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ isClaimed: false }));

    const result = await checkinAccount('one.json');

    expect(result.error).toContain('claim returned 503');
    expect(result.credits).toMatchObject({ remaining: 2, total: 3, used: 1 });
  });

  it('includes the upstream error body when a request fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'quota exceeded' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 400,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ isClaimed: false }))
      .mockResolvedValueOnce(
        jsonResponse(
          quotaPayload([
            quotaPackage({
              CycleCapacityRemain: 8,
              CycleCapacitySize: 10,
              CycleCapacityUsed: 2,
            }),
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ claimed: false }));

    const result = await checkinAccount('one.json');

    expect(result.error).toBe(
      'claim returned 400: {"message":"quota exceeded"}',
    );
  });

  it('treats a rejected claim as success when the account is already claimed', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ message: 'already claimed today' }, 400),
      )
      .mockResolvedValueOnce(jsonResponse({ claimed: true }))
      .mockResolvedValueOnce(
        jsonResponse(
          quotaPayload([
            quotaPackage({
              CycleCapacityRemain: 8,
              CycleCapacitySize: 10,
              CycleCapacityUsed: 2,
            }),
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ claimed: true }));

    const result = await checkinAccount('one.json');

    expect(result.error).toBeNull();
    expect(result.checkin.claimed).toBe(true);
    expect(result.credits.remaining).toBe(8);
  });

  it('truncates upstream error bodies that are too long', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('x'.repeat(500), { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));

    const result = await checkinAccount('one.json');

    expect(result.error).toBe(`claim returned 502: ${'x'.repeat(300)}...`);
  });

  it('falls back to the status code when the error body cannot be read', async () => {
    const broken = new Response('{}', { status: 400 });

    vi.spyOn(broken, 'text').mockImplementation(() =>
      Promise.reject(new Error('stream broken')),
    );
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(jsonResponse({ isClaimed: false }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));

    const result = await checkinAccount('one.json');

    expect(result.error).toBe('claim returned 400');
  });

  it('rejects a check-in request for a missing credential', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValueOnce([] as never);

    await expect(checkinAccount('missing.json')).rejects.toThrow(
      'Credential is unavailable',
    );
  });

  it('processes all batch accounts', async () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      credential(`credential-${index}.json`),
    );
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue(
      records as never,
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      init?.method === 'POST'
        ? jsonResponse({ success: true })
        : jsonResponse(
            quotaPayload([
              quotaPackage({
                CycleCapacityRemain: 1,
                CycleCapacitySize: 1,
                CycleCapacityUsed: 0,
              }),
            ]),
          ),
    );
    const results = await checkinAccounts();
    expect(results).toHaveLength(5);
  });
});
