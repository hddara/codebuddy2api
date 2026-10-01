import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/admin/session', () => ({
  getAdminSessionErrorResponse: vi.fn(),
}));
vi.mock('@/lib/server/domain/credentials', () => ({
  clearCredentialLimits: vi.fn(),
  listCredentialLimits: vi.fn(),
}));

const { getAdminSessionErrorResponse } =
  await import('@/lib/server/admin/session');
const { clearCredentialLimits, listCredentialLimits } =
  await import('@/lib/server/domain/credentials');
const { GET, POST } = await import('@/app/admin-api/credentials/limits/route');

const request = (body?: unknown): Request =>
  new Request('http://localhost/admin-api/credentials/limits', {
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
  });

describe('credential limits admin route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(null);
    vi.mocked(listCredentialLimits).mockResolvedValue([]);
    vi.mocked(clearCredentialLimits).mockResolvedValue(0);
  });

  it('requires an administrator session', async () => {
    const denied = Response.json({ error: 'unauthorized' }, { status: 401 });
    vi.mocked(getAdminSessionErrorResponse)
      .mockResolvedValueOnce(denied)
      .mockResolvedValueOnce(denied);

    expect((await GET(request())).status).toBe(401);
    expect((await POST(request({ filename: 'one.json' }))).status).toBe(401);
  });

  it('lists the active marks on GET', async () => {
    vi.mocked(listCredentialLimits).mockResolvedValueOnce([
      { filename: 'one.json', kind: 'quota', resumeAt: 1_790_800_000_000 },
    ] as never);

    expect(await (await GET(request())).json()).toEqual({
      limits: [
        { filename: 'one.json', kind: 'quota', resumeAt: 1_790_800_000_000 },
      ],
    });
  });

  it('releases a single credential or all of them', async () => {
    vi.mocked(clearCredentialLimits).mockResolvedValueOnce(1);

    const single = await POST(request({ filename: ' one.json ' }));
    expect(clearCredentialLimits).toHaveBeenCalledWith(['one.json']);
    expect(await single.json()).toEqual({ cleared: 1, success: true });

    await POST(request({}));
    expect(clearCredentialLimits).toHaveBeenCalledWith(undefined);

    const invalid = await POST(request({ filename: 42 }));
    expect(invalid.status).toBe(400);
    expect(clearCredentialLimits).toHaveBeenCalledTimes(2);
  });

  it('rejects bodies that are not valid JSON', async () => {
    const malformed = new Request(
      'http://localhost/admin-api/credentials/limits',
      { body: 'not json', method: 'POST' },
    );

    expect((await POST(malformed)).status).toBe(400);
  });
});
