import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/proxy/auth';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/domain/debug';
import { withRequestTracking } from '@/lib/server/shared/in-flight';
import { logEvent } from '@/lib/server/shared/log';
import { readJsonBodyOrErrorResponse } from '@/lib/server/shared/http';
import { runWithRequestContext } from '@/lib/server/shared/request-context';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = '/v1/responses';

export const POST = async (request: NextRequest): Promise<Response> =>
  runWithRequestContext(ROUTE, async () =>
    withRequestTracking(async () => {
      const authError = await getClientAuthErrorResponse(request);

      if (authError) {
        return authError;
      }

      const parsed =
        await readJsonBodyOrErrorResponse<Record<string, unknown>>(request);

      if ('response' in parsed) {
        return parsed.response;
      }

      const body = parsed.body;
      const debugTrace = (await isDebugEnabled())
        ? createDebugTrace({
            requestBody: body,
            requestKey:
              request.headers.get('x-api-key') ??
              request.headers.get('authorization'),
            route: ROUTE,
          })
        : undefined;

      void logEvent({
        level: 'INFO',
        message: 'Request admitted',
        payload: { route: ROUTE },
      });

      const response = await handleResponsesRequest(request, body, debugTrace);
      return finalizeDebugTrace(debugTrace, response);
    }),
  );
