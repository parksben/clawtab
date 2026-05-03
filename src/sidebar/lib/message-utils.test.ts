import { describe, it, expect } from 'vitest';
import {
  msgKey,
  isHiddenInfraMsg,
  extractJsonBlock,
  extractToolCalls,
  isTerminalMsg,
  msgText,
} from './message-utils';
import type { ChatMessage } from '@/shared/types/protocol';

describe('msgText', () => {
  it('returns string content as-is', () => {
    expect(msgText({ role: 'user', content: 'hi' })).toBe('hi');
  });
  it('joins array-of-blocks content by concat of text blocks', () => {
    expect(
      msgText({
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab');
  });
  it('falls back to msg.blocks', () => {
    expect(msgText({ role: 'assistant', blocks: [{ type: 'text', text: 'x' }] })).toBe('x');
  });
  it('returns empty string for malformed shape', () => {
    expect(msgText({ role: 'system' } as ChatMessage)).toBe('');
  });
});

describe('msgKey', () => {
  it('prefers id when present', () => {
    expect(msgKey({ id: 'abc', role: 'user', content: 'hello' })).toBe('id:abc');
  });
  it('falls back to role+content hash when id missing', () => {
    expect(msgKey({ role: 'user', content: 'hello' })).toBe('c:user|hello');
  });
  it('truncates content beyond 300 chars (handshake echoes are long)', () => {
    const long = 'x'.repeat(500);
    const k = msgKey({ role: 'user', content: long });
    expect(k.length).toBeLessThanOrEqual('c:user|'.length + 300);
  });
  it('same content with different id gets different keys', () => {
    const a = msgKey({ id: 'a', role: 'user', content: 'hi' });
    const b = msgKey({ id: 'b', role: 'user', content: 'hi' });
    expect(a).not.toBe(b);
  });
  it('same content with no id de-dupes', () => {
    const a = msgKey({ role: 'user', content: 'hi' });
    const b = msgKey({ role: 'user', content: 'hi' });
    expect(a).toBe(b);
  });
});

describe('isHiddenInfraMsg', () => {
  it('hides "/new" user messages', () => {
    expect(isHiddenInfraMsg({ role: 'user', content: '/new' })).toBe(true);
  });
  it('trims whitespace before matching', () => {
    expect(isHiddenInfraMsg({ role: 'user', content: '  /new  ' })).toBe(true);
  });
  it('does NOT hide assistant messages that happen to say /new', () => {
    expect(isHiddenInfraMsg({ role: 'assistant', content: '/new' })).toBe(false);
  });
  it('does not hide regular user messages', () => {
    expect(isHiddenInfraMsg({ role: 'user', content: 'hello' })).toBe(false);
  });
});

describe('extractJsonBlock', () => {
  it('extracts a well-formed clawtab_cmd block', () => {
    const text =
      'thinking out loud…\n```json\n{"type":"clawtab_cmd","action":"perceive"}\n```\nok';
    expect(extractJsonBlock(text)).toEqual({
      type: 'clawtab_cmd',
      action: 'perceive',
    });
  });
  it('returns null for malformed JSON', () => {
    expect(extractJsonBlock('```json\n{not valid}\n```')).toBeNull();
  });
  it('returns null when no json fence', () => {
    expect(extractJsonBlock('just text')).toBeNull();
  });
});

describe('extractToolCalls', () => {
  it('picks tool_use blocks out of content array', () => {
    expect(
      extractToolCalls({
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 'abc', name: 'calc', input: { expr: '1+1' } },
        ],
      } as ChatMessage),
    ).toHaveLength(1);
  });
  it('falls back to blocks', () => {
    expect(
      extractToolCalls({
        role: 'assistant',
        blocks: [{ type: 'tool_use' } as never, { type: 'text', text: 'hi' }],
      } as ChatMessage),
    ).toHaveLength(1);
  });
  it('returns empty array when there are none', () => {
    expect(extractToolCalls({ role: 'user', content: 'hi' })).toEqual([]);
  });
});

describe('isTerminalMsg', () => {
  it('terminal when assistant posts task_done', () => {
    expect(
      isTerminalMsg({
        role: 'assistant',
        content: '```json\n{"type":"clawtab_cmd","action":"task_done"}\n```',
      }),
    ).toBe(true);
  });
  it('terminal when assistant has non-json visible text', () => {
    expect(
      isTerminalMsg({
        role: 'assistant',
        content: 'Here is my answer.',
      }),
    ).toBe(true);
  });
  it('NOT terminal for intermediate perceive cmd', () => {
    expect(
      isTerminalMsg({
        role: 'assistant',
        content: '```json\n{"type":"clawtab_cmd","action":"perceive"}\n```',
      }),
    ).toBe(false);
  });
  it('user messages are never terminal', () => {
    expect(isTerminalMsg({ role: 'user', content: 'anything' })).toBe(false);
  });
});
