import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConfig, ChatRequestSchema, runShoppingAssistant } from '../src/services/aiChat';
import { hasSameKesAmount, kesToCents } from '../src/services/money';

const tools: any = [{ type: 'function', function: { name: 'search_products', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: [] } } }];
const request = { message: 'Nguo nyeusi?', history: [] };

test('assistant replies longer than 500 characters can be replayed; user/history budgets remain bounded', () => {
  assert.equal(ChatRequestSchema.safeParse({ ...request, history: [{ role: 'assistant', content: 'x'.repeat(3000) }] }).success, true);
  assert.equal(ChatRequestSchema.safeParse({ ...request, history: [{ role: 'user', content: 'x'.repeat(501) }] }).success, false);
  assert.equal(ChatRequestSchema.safeParse({ ...request, history: Array.from({ length: 3 }, () => ({ role: 'assistant', content: 'x'.repeat(10000) })) }).success, false);
});

test('configuration is resolved at request time, validates budgets, and preserves provider selection', () => {
  assert.equal(aiConfig({}).provider, 'openrouter');
  assert.equal(aiConfig({ AI_PROVIDER: 'openai' }).model, 'gpt-6-astra');
  assert.throws(() => aiConfig({ AI_MAX_TOKENS: 'NaN' }));
  assert.throws(() => aiConfig({ AI_PROVIDER: 'typo' }));
});

test('Astra replays reasoning and matches tool results by call_id without sampling parameters', async () => {
  const requests: any[] = [];
  const client: any = { responses: { create: async (body: any) => {
    requests.push(structuredClone(body));
    return requests.length === 1 ? { status: 'completed', output: [
      { type: 'reasoning', id: 'reasoning_1', summary: [] },
      { type: 'function_call', call_id: 'call_1', name: 'search_products', arguments: '{"query":"black"}' },
    ] } : { status: 'completed', output: [], output_text: 'Nguo nyeusi: KES 100.' };
  } } };
  const reply = await runShoppingAssistant(client, aiConfig({ AI_PROVIDER: 'openai' }), 'Be factual', request, tools, async (_name, args) => {
    assert.equal(args.query, 'black'); return '{"price":100}';
  });
  assert.match(reply, /KES 100/);
  assert.equal(requests[0].temperature, undefined);
  assert.equal(requests[0].max_output_tokens, 4000);
  assert.equal(requests[1].input[1].type, 'reasoning');
  assert.equal(requests[1].input[3].call_id, 'call_1');
  assert.equal(requests[0].tools[0].strict, false);
});

test('incomplete outputs and unbounded tool chains do not become successful replies', async () => {
  const config = aiConfig({ AI_PROVIDER: 'openai' });
  await assert.rejects(runShoppingAssistant({ responses: { create: async () => ({ status: 'incomplete', output: [], output_text: 'partial' }) } } as any, config, '', request, tools, async () => '{}'));
  let calls = 0;
  await assert.rejects(runShoppingAssistant({ responses: { create: async () => {
    calls++; return { status: 'completed', output: [{ type: 'function_call', call_id: `${calls}`, name: 'search_products', arguments: '{}' }] };
  } } } as any, config, '', request, tools, async () => '{}'), /budget/);
  assert.equal(calls, 4);
});

test('existing OpenRouter path still completes and rejects truncated output', async () => {
  const client: any = { chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Karibu!' } }] }) } } };
  assert.equal(await runShoppingAssistant(client, aiConfig({}), '', request, tools, async () => '{}'), 'Karibu!');
  client.chat.completions.create = async () => ({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] });
  await assert.rejects(runShoppingAssistant(client, aiConfig({}), '', request, tools, async () => '{}'));
});

test('payment amounts compare exactly in cents and reject invalid precision', () => {
  assert.equal(hasSameKesAmount('100.00', 100), true);
  assert.equal(hasSameKesAmount('100.01', 100), false);
  for (const value of ['NaN', '-1', '1.001', '1e3', '9007199254740991']) assert.equal(kesToCents(value), null);
});
