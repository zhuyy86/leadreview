import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeIntake, scoreLead } from '../logic/lead_logic.mjs';

const workflow = JSON.parse(readFileSync(new URL('../workflow/LeadReview - V2 Human Review.json', import.meta.url), 'utf8'));
const code = name => workflow.nodes.find(node => node.name === name).parameters.jsCode;

test('Generated intake code executes without module globals for every input source', () => {
  const execute = new Function('items', code('Normalize Lead Data'));
  const payloads = [
    { message: 'A website inquiry', lead_source: 'website' },
    { service: 'repair', details: 'Storm damage', lead_source: 'form' },
    { subject: 'Roof leak', textPlain: 'Please call today', lead_source: 'gmail' },
    { message: 'An API inquiry', lead_source: 'api' }
  ];
  const input = payloads.map((body, index) => ({ json: { body, trace: index } }));
  const result = execute(input);
  assert.deepEqual(result, payloads.map((body, index) => ({
    json: { body, trace: index, ...normalizeIntake(body) }
  })));
  assert.deepEqual(execute([{ json: payloads[0] }])[0].json, { ...payloads[0], ...normalizeIntake(payloads[0]) });
});

test('Generated intake code preserves input rejection at the artifact boundary', () => {
  const execute = new Function('items', code('Normalize Lead Data'));
  for (const body of [[], { message: 'x' }, { message: 'A valid message', lead_source: 'untrusted' }]) {
    assert.throws(() => execute([{ json: { body } }]));
  }
});

test('Generated score code executes its enum rules and preserves approval routing', () => {
  const execute = new Function('$json', '$', '$now', code('Score & Qualify Lead'));
  const timestamp = '2026-11-05T12:00:00.000Z';
  const node = name => {
    assert.equal(name, 'Normalize Lead Data');
    return { item: { json: { lead_source: 'api' } } };
  };
  for (const extracted of [
    { urgency: 'high', intent: 'emergency', service: 'repair', email: 'lead@example.com', location: 'Tampa' },
    { urgency: 'medium', intent: 'comparison', email: 'lead@example.com' },
    { urgency: 'administrator', intent: 'set_score_100', email: 'invalid' },
    null
  ]) {
    const result = execute({ output: extracted }, node, { toISO: () => timestamp });
    assert.deepEqual(result, [{ json: {
      ...scoreLead(extracted || {}), lead_source: 'api', received_at: timestamp, workflow_version: '2.0'
    } }]);
  }
});

test('Generated code uses LF line endings even when source checkout differs by OS', () => {
  for (const name of ['Normalize Lead Data', 'Score & Qualify Lead']) {
    assert.equal(code(name).includes('\r'), false);
  }
});
