import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_SESSION_SUBSCRIBERS,
  getAccumulatedText,
  getSessionSubscriberCount,
  publishSessionCompleted,
  publishSessionDelta,
  publishSessionStarted,
  resetSessionStreamRuntime,
  subscribeToSessionEvents,
  unsubscribeFromSessionEvents,
  type SessionEvent,
} from '@/lib/server/domain/session-stream';

const collect = () => {
  const events: SessionEvent[] = [];

  return {
    events,
    subscriber: {
      conversationIds: new Set<string>(),
      send: (event: SessionEvent): boolean => {
        events.push(event);

        return true;
      },
    },
  };
};

describe('session stream', () => {
  beforeEach(() => {
    resetSessionStreamRuntime();
  });

  it('publishes start, delta and completion for a conversation', () => {
    const { events, subscriber } = collect();

    subscribeToSessionEvents(subscriber);
    publishSessionStarted({
      accessKeyId: 'key-1',
      conversationId: 'conv-a',
      model: 'deepseek-v4.1-flash',
    });
    publishSessionDelta({ conversationId: 'conv-a', delta: '你' });
    publishSessionDelta({ conversationId: 'conv-a', delta: '好' });
    publishSessionCompleted({ conversationId: 'conv-a' });

    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'session.delta',
      'session.delta',
      'session.completed',
    ]);
    expect(events[1]?.delta).toBe('你');
    // The accumulated text lets a late subscriber render the reply in full.
    expect(events[2]?.text).toBe('你好');
    expect(events[3]?.text).toBe('你好');
    expect(events[0]?.accessKeyId).toBe('key-1');
    expect(events[0]?.model).toBe('deepseek-v4.1-flash');
  });

  it('reports failures as session.failed with the error text', () => {
    const { events, subscriber } = collect();

    subscribeToSessionEvents(subscriber);
    publishSessionStarted({ conversationId: 'conv-a' });
    publishSessionCompleted({ conversationId: 'conv-a', error: 'boom' });

    expect(events.at(-1)?.type).toBe('session.failed');
    expect(events.at(-1)?.error).toBe('boom');
  });

  it('only delivers conversations a subscriber asked for', () => {
    const { events, subscriber } = collect();

    subscriber.conversationIds.add('conv-a');
    subscribeToSessionEvents(subscriber);

    publishSessionStarted({ conversationId: 'conv-a' });
    publishSessionStarted({ conversationId: 'conv-b' });

    expect(events).toHaveLength(1);
    expect(events[0]?.conversationId).toBe('conv-a');
  });

  it('ignores empty deltas and missing conversation ids', () => {
    const { events, subscriber } = collect();

    subscribeToSessionEvents(subscriber);
    publishSessionDelta({ conversationId: '', delta: 'x' });
    publishSessionDelta({ conversationId: 'conv-a', delta: '' });
    publishSessionDelta({ conversationId: 'conv-a', delta: undefined });

    expect(events).toHaveLength(0);
  });

  it('drops a subscriber whose send fails instead of keeping it', () => {
    subscribeToSessionEvents({
      conversationIds: new Set<string>(),
      send: () => false,
    });

    expect(getSessionSubscriberCount()).toBe(1);

    publishSessionStarted({ conversationId: 'conv-a' });

    expect(getSessionSubscriberCount()).toBe(0);
  });

  it('stops at the subscriber limit', () => {
    for (let index = 0; index < MAX_SESSION_SUBSCRIBERS; index += 1) {
      expect(
        subscribeToSessionEvents({
          conversationIds: new Set<string>(),
          send: () => true,
        }),
      ).not.toBeNull();
    }

    expect(
      subscribeToSessionEvents({
        conversationIds: new Set<string>(),
        send: () => true,
      }),
    ).toBeNull();
  });

  it('unsubscribes and exposes accumulated text', () => {
    const { subscriber } = collect();
    const entry = subscribeToSessionEvents(subscriber);

    publishSessionStarted({ conversationId: 'conv-a' });
    publishSessionDelta({ conversationId: 'conv-a', delta: 'hi' });

    expect(getAccumulatedText('conv-a')).toBe('hi');
    // An unknown conversation has no accumulated text.
    expect(getAccumulatedText('conv-missing')).toBe('');

    unsubscribeFromSessionEvents(entry!.id);

    expect(getSessionSubscriberCount()).toBe(0);
  });

  it('never throws when a subscriber send blows up', () => {
    const broken = vi.fn(() => {
      throw new Error('subscriber exploded');
    });

    subscribeToSessionEvents({ conversationIds: new Set(), send: broken });

    expect(() =>
      publishSessionStarted({ conversationId: 'conv-a' }),
    ).not.toThrow();
    expect(getSessionSubscriberCount()).toBe(0);
  });

  it('does not publish without a conversation id', () => {
    const { events, subscriber } = collect();

    subscribeToSessionEvents(subscriber);
    publishSessionStarted({ conversationId: '' });
    publishSessionCompleted({ conversationId: '' });

    expect(events).toHaveLength(0);
  });
});
