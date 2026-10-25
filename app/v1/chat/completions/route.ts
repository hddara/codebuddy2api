import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/proxy/auth';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/domain/debug';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import { withRequestTracking } from '@/lib/server/shared/in-flight';
import { logEvent } from '@/lib/server/shared/log';
import { readJsonBodyOrErrorResponse } from '@/lib/server/shared/http';
import { runWithRequestContext } from '@/lib/server/shared/request-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = '/v1/chat/completions';

export const POST = async (request: NextRequest): Promise<Response> =>
  // The context is opened here rather than only in the proxy so that auth and
  // body failures — the two rejections that never reach the proxy — still carry
  // the same `reqId` as the request they belong to. The proxy's own call is a
  // no-op when a context already exists.
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

      const response = await proxyChatCompletions(
        request,
        body,
        undefined,
        debugTrace,
      );
      return finalizeDebugTrace(debugTrace, response);
    }),
  );
