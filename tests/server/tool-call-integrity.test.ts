import {
  findToolCallLeak,
  inspectAssistantTurn,
} from '@/lib/server/proxy/tool-call-integrity';

describe('findToolCallLeak', () => {
  it('finds pristine DSML markup', () => {
    const leak = findToolCallLeak(
      '<|DSML|invoke name="read_file"><|DSML|parameter name="path">a',
    );

    expect(leak).not.toBeNull();
    expect(leak?.marker).toBe('dsml');
    expect(leak?.offset).toBe(0);
  });

  it('finds the marker after the delimiters were stripped to pipes', () => {
    // What a client-side sanitiser leaves behind, and what users report:
    // `</ || DSML || invoke> </ || DSML || calls>`.
    const leak = findToolCallLeak('</ || DSML || invoke> </ || DSML || calls>');

    expect(leak).not.toBeNull();
    expect(leak?.offset).toBe(0);
  });

  it('finds a lone opening tag with empty delimiters', () => {
    const leak = findToolCallLeak('text before <  DSML  invoke > text after');

    expect(leak).not.toBeNull();
  });

  it('reports the earliest marker when several kinds appear', () => {
    const leak = findToolCallLeak(
      'prose <|DSML|calls> and later </ || DSML || invoke>',
    );

    expect(leak?.offset).toBe(6);
  });

  it('returns a window around the marker rather than the whole text', () => {
    const text = `${'x'.repeat(500)}<|DSML|invoke>${'y'.repeat(500)}`;
    const leak = findToolCallLeak(text);

    expect(leak?.sample.length).toBeLessThan(text.length);
    expect(leak?.sample).toContain('DSML');
  });

  it('ignores ordinary prose', () => {
    expect(findToolCallLeak('The build passed and I updated the page.')).toBe(
      null,
    );
  });

  it('ignores anything that is not a string', () => {
    expect(findToolCallLeak(null)).toBeNull();
    expect(findToolCallLeak(undefined)).toBeNull();
    expect(findToolCallLeak(42)).toBeNull();
    expect(findToolCallLeak('')).toBeNull();
  });
});

describe('inspectAssistantTurn', () => {
  it('flags an assistant turn whose content leaked a call', () => {
    const leak = inspectAssistantTurn({
      content: '</ || DSML || invoke>',
      role: 'assistant',
    });

    expect(leak).not.toBeNull();
  });

  it('reads text out of block content', () => {
    const leak = inspectAssistantTurn({
      content: [{ text: '<|DSML|invoke>', type: 'text' }],
      role: 'assistant',
    });

    expect(leak).not.toBeNull();
  });

  it('stays quiet when the turn actually produced tool_calls', () => {
    // A model may restate call syntax while also emitting a real call; that is
    // not a failure and must not be reported as one.
    const leak = inspectAssistantTurn({
      content: '<|DSML|invoke>',
      role: 'assistant',
      tool_calls: [{ function: { name: 'read_file' }, id: 'call-1' }],
    });

    expect(leak).toBeNull();
  });

  it('ignores turns that are not the assistant speaking', () => {
    // A user debugging the marker may paste it verbatim.
    expect(
      inspectAssistantTurn({ content: '<|DSML|invoke>', role: 'user' }),
    ).toBeNull();
  });

  it('copes with missing or unusable content', () => {
    expect(inspectAssistantTurn({ role: 'assistant' })).toBeNull();
    expect(
      inspectAssistantTurn({ content: null, role: 'assistant' }),
    ).toBeNull();
    expect(inspectAssistantTurn({ content: {}, role: 'assistant' })).toBeNull();
    expect(
      inspectAssistantTurn({
        content: [{ type: 'text' }],
        role: 'assistant',
      }),
    ).toBeNull();
  });
});
