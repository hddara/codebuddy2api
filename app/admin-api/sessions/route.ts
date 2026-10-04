import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  getSessionSummaries,
  normalizeSessionWindowMinutes,
} from '@/lib/server/domain/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lists the conversations the gateway served inside a time window, grouped by
 * the `x-conversation-id` the client sends on every request.
 *
 * `?windowMinutes=` tunes the window (default 24h, capped at 30 days).
 * `?format=table` renders the same data as plain text, which makes the endpoint
 * usable straight from a terminal or a browser without any console work.
 */
export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const params = new URL(request.url).searchParams;
  const windowMinutes = normalizeSessionWindowMinutes(
    params.get('windowMinutes') ?? undefined,
  );
  const payload = await getSessionSummaries({ windowMinutes });

  if (params.get('format') === 'table') {
    const lines = [
      `window=${payload.windowMinutes}min sessions=${payload.totals.sessions} calls=${payload.totals.calls} tokens=${payload.totals.totalTokens} ungrouped=${payload.ungroupedEvents}`,
      '',
      [
        'lastActiveAt',
        'conversationId',
        'key',
        'models',
        'calls',
        'tokens',
      ].join('\t'),
      ...payload.sessions.map((session) =>
        [
          session.lastActiveAt,
          session.conversationId,
          session.accessKeyName ?? session.accessKeyId ?? '-',
          session.models.join(','),
          String(session.callCount),
          String(session.totalTokens),
        ].join('\t'),
      ),
    ];

    return new Response(lines.join('\n'), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  return Response.json(payload);
};
