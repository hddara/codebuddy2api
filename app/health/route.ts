import { getAutoCheckinStatus } from '@/lib/server/domain/auto-checkin';
import {
  ensureStorageReady,
  getStorageBackendMeta,
} from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  try {
    await ensureStorageReady();
  } catch {
    return Response.json(
      {
        status: 'unhealthy',
        service: 'codebuddy2api',
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }

  const autoCheckin = await getAutoCheckinStatus().catch(() => null);

  return Response.json({
    autoCheckin,
    storage: getStorageBackendMeta().backend,
    status: 'healthy',
    service: 'codebuddy2api',
    timestamp: new Date().toISOString(),
  });
};
