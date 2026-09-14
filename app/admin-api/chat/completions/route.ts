import type { NextRequest } from 'next/server';

import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/domain/debug';
import {
  beginSessionCapture,
  finalizeSessionCapture,
} from '@/lib/server/domain/session-capture';
import {
  proxyChatCompletions,
  resolveProxyContextByCredentialFilename,
} from '@/lib/server/proxy/codebuddy';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<Record<string, unknown>>(request);
  const debugEnabled = await isDebugEnabled();
  const debugTrace = debugEnabled
    ? createDebugTrace({
        requestBody: body,
        requestKey:
          typeof body.credential_filename === 'string' &&
          body.credential_filename.trim()
            ? body.credential_filename.trim()
            : 'admin-api-test',
        route: '/admin-api/chat/completions',
      })
    : undefined;
  const credentialFilename =
    typeof body.credential_filename === 'string'
      ? body.credential_filename.trim()
      : '';

  const sessionCapture = await beginSessionCapture({
    accessKeyId: null,
    body,
    credentialFilename: credentialFilename || null,
    headers: request.headers,
    route: '/admin-api/chat/completions',
  });

  try {
    const context = credentialFilename
      ? await resolveProxyContextByCredentialFilename(credentialFilename)
      : undefined;
    const response = await proxyChatCompletions(
      request,
      body,
      context,
      debugTrace,
    );
    return finalizeSessionCapture(
      sessionCapture,
      finalizeDebugTrace(debugTrace, response),
    );
  } catch (error) {
    const response = Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : undefined,
        },
      },
      { status: 400 },
    );
    return finalizeSessionCapture(
      sessionCapture,
      finalizeDebugTrace(debugTrace, response),
    );
  }
};
