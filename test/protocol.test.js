'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseToolCalls,
  formatResults,
  formatBrokenNotice,
} = require('../src/protocol');


test('parseToolCalls parses fenced bridge calls and preserves arguments', () => {
  const result = parseToolCalls('```json\n{"type":"tool_use","id":"toolu_r1","name":"read_file","input":{"path":"README.md"}}\n```');

  assert.equal(result.broken.length, 0);
  assert.deepEqual(result.calls, [
    {
      bridge_tool: 'read_file',
      id: 'toolu_r1',
      path: 'README.md',
    },
  ]);
});


test('parseToolCalls reports malformed JSON instead of silently dropping it', () => {
  const result = parseToolCalls('```json\n{"type":"tool_use","id":"r1","name":"read_file","input":}\n```');

  assert.equal(result.calls.length, 0);
  assert.ok(result.broken.length >= 1);
  assert.match(formatBrokenNotice(result.broken), /壊れ|不正|JSON|解析|broken/i);
});


test('parseToolCalls rejects duplicate call ids', () => {
  const result = parseToolCalls([
    '```json',
    '{"type":"tool_use","id":"toolu_same","name":"read_file","input":{"path":"a"}}',
    '```',
    '```json',
    '{"type":"tool_use","id":"toolu_same","name":"read_file","input":{"path":"b"}}',
    '```',
  ].join('\n'));

  assert.equal(result.calls.length, 1);
  assert.ok(result.broken.length >= 1);
});


test('parseToolCalls recognizes tool_use mentions that were not parsed', () => {
  const result = parseToolCalls('Please execute tool_use now.');

  assert.equal(result.calls.length, 0);
  assert.ok(result.broken.length >= 1);
});


test('formatResults serializes successful and failed tool results', () => {
  const output = formatResults([
    { id: 'ok', ok: true, output: 'done' },
    { id: 'bad', ok: false, output: 'failed' },
  ]);

  assert.match(output, /ok/);
  assert.match(output, /done/);
  assert.match(output, /bad/);
  assert.match(output, /failed/);
});
