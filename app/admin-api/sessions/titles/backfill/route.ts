import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { getSessionSummaries } from '@/lib/server/domain/sessions';
import {
  listSessionTitles,
  type SessionTitleStore,
} from '@/lib/server/domain/session-titles';
import { generateSessionTitle } from '@/lib/server/domain/session-title-generator';
import { listSessionTranscripts } from '@/lib/server/domain/session-transcripts';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Names conversations that were recorded before titles existed.
 *
 * Bounded on purpose. A gateway that has been running for weeks holds thousands
 * of conversations, and naming every one of them in a single request would mean
 * thousands of model calls, a request that never returns, and a bill nobody
 * agreed to. The caller passes the conversations it actually saw, and gets at
 * most `MAX_BATCH` titles back — running it again picks up the rest.
 *
 * The label is written from the stored question, so this only needs the
 * transcript that is already on disk; no request body is re-read.
 */

/** Ceiling per request: a page of a list, not the whole history. */
const MAX_BATCH = 20;

/** Long enough to survive a few slow completions, short enough to return. */
const BATCH_DEADLINE_MS = 25_000;

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  let conversationIds: string[];

  try {
    const body = await getJsonBody<{ conversationIds?: unknown }>(request);

    if (!Array.isArray(body?.conversationIds)) {
      return Response.json(
        { error: 'conversationIds must be an array' },
        { status: 400 },
      );
    }

    conversationIds = body.conversationIds
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_BATCH);
  } catch {
    return Response.json({ error: 'invalid request body' }, { status: 400 });
  }

  if (!conversationIds.length) {
    return Response.json({ generated: 0, skipped: 0, titles: {} });
  }

  const titled: SessionTitleStore = await listSessionTitles().catch(
    () => ({}) as SessionTitleStore,
  );
  const pending = conversationIds.filter((id) => !titled[id]);

  if (!pending.length) {
    return Response.json({
      generated: 0,
      skipped: conversationIds.length,
      titles: {},
    });
  }

  // The question for the *first* turn is what the title should describe, so the
  // transcript list is read once and reduced to the earliest usable question per
  // conversation rather than querying per id.
  const transcripts = await listSessionTranscripts({ limit: 500 }).catch(
    () => ({
      entries: [] as Array<{
        conversationId: string;
        completedAt: string;
        question: string;
      }>,
    }),
  );

  const firstQuestion = new Map<
    string,
    { completedAt: string; question: string }
  >();

  for (const entry of transcripts.entries) {
    if (!pending.includes(entry.conversationId) || !entry.question?.trim()) {
      continue;
    }

    const seen = firstQuestion.get(entry.conversationId);

    if (!seen || Date.parse(entry.completedAt) < Date.parse(seen.completedAt)) {
      firstQuestion.set(entry.conversationId, {
        completedAt: entry.completedAt,
        question: entry.question,
      });
    }
  }

  const started = Date.now();
  const generated: Record<string, string> = {};
  let skipped = conversationIds.length - pending.length;

  // Sequential, and stopped at the deadline: bursts of parallel model calls are
  // what makes a background task look like an outage to whoever is watching the
  // upstream quota.
  for (const conversationId of pending) {
    if (Date.now() - started > BATCH_DEADLINE_MS) {
      break;
    }

    const entry = firstQuestion.get(conversationId);

    if (!entry) {
      skipped += 1;
      continue;
    }

    const record = await generateSessionTitle({
      conversationId,
      question: entry.question,
    });

    if (record) {
      generated[conversationId] = record.title;
    } else {
      skipped += 1;
    }
  }

  // `remaining` tells the caller whether another round is worth making, without
  // it having to guess from the batch size.
  const remaining = conversationIds
    .slice(MAX_BATCH)
    .filter((id) => !titled[id] && !generated[id]).length;

  return Response.json({
    generated: Object.keys(generated).length,
    remaining,
    skipped,
    titles: generated,
  });
};

/**
 * Window used when resolving which conversations the caller means.
 *
 * Exported so the App and the gateway agree on the span a backfill covers.
 */
export const backfillWindowMinutes = async (): Promise<number> => {
  const summaries = await getSessionSummaries({ windowMinutes: 30 * 24 * 60 });

  return summaries.windowMinutes;
};
