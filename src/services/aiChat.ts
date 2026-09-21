import OpenAI from 'openai';
import { z } from 'zod';

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(500),
  history: z.array(z.discriminatedUnion('role', [
    z.object({ role: z.literal('user'), content: z.string().min(1).max(500) }),
    z.object({ role: z.literal('assistant'), content: z.string().min(1).max(12000) }),
  ])).max(20).default([]),
}).refine(value => value.history.reduce((n, item) => n + item.content.length, 0) <= 24000, 'Chat history is too long');

export function aiConfig(env: NodeJS.ProcessEnv = process.env) {
  const provider = (env.AI_PROVIDER ?? 'openrouter').toLowerCase();
  if (!['openai', 'openrouter'].includes(provider)) throw new Error('Invalid AI_PROVIDER');
  const model = env.AI_MODEL ?? (provider === 'openai' ? 'gpt-6-astra' : 'minimax/minimax-m3:free');
  const maxTokens = Number(env.AI_MAX_TOKENS ?? (provider === 'openai' ? 4000 : 500));
  if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 16384) throw new Error('AI_MAX_TOKENS must be an integer from 128 to 16384');
  return { provider, model, maxTokens };
}

/** Bounded read-only loop. OpenAI uses Responses; OpenRouter keeps its existing API. */
export async function runShoppingAssistant(
  client: OpenAI,
  config: ReturnType<typeof aiConfig>,
  prompt: string,
  request: z.infer<typeof ChatRequestSchema>,
  tools: OpenAI.Chat.ChatCompletionTool[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  const signal = AbortSignal.timeout(45_000);
  const executeCall = async (name: string, raw: string) => {
    if (!tools.some(t => t.type === 'function' && t.function.name === name)) return JSON.stringify({ error: 'Unknown tool' });
    try { return await execute(name, JSON.parse(raw || '{}')); }
    catch { return JSON.stringify({ error: 'Tool execution failed. Do not guess the result.' }); }
  };
  const finish = (text: string | null | undefined) => {
    if (!text?.trim() || text.length > 12000) throw new Error('AI response was empty or exceeded the reply limit');
    return text;
  };
  if (config.provider === 'openai') {
    const input: OpenAI.Responses.ResponseInput = [...request.history, { role: 'user', content: request.message }];
    for (let round = 0; round <= 3; round++) {
      const response = await client.responses.create({
        model: config.model, instructions: prompt, input, store: false,
        include: ['reasoning.encrypted_content'],
        max_output_tokens: config.maxTokens,
        ...(config.model.startsWith('gpt-6') ? { reasoning: { effort: 'low' as const } } : {}),
        tools: tools.flatMap(tool => tool.type === 'function' ? [{
          type: 'function' as const, name: tool.function.name, description: tool.function.description,
          parameters: tool.function.parameters ?? {}, strict: false,
        }] : []),
      }, { signal });
      if (response.status !== 'completed') throw new Error('AI response did not complete');
      const calls = response.output.filter(item => item.type === 'function_call');
      if (!calls.length) return finish(response.output_text);
      if (round === 3 || calls.length > 8) throw new Error('AI tool budget exhausted');
      // Replay all output items, including reasoning, before the paired tool results.
      input.push(...response.output.filter(item => item.type === 'message' || item.type === 'reasoning' || item.type === 'function_call'));
      for (const call of calls) {
        input.push({ type: 'function_call_output', call_id: call.call_id, output: await executeCall(call.name, call.arguments) });
      }
    }
  } else {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: prompt }, ...request.history, { role: 'user', content: request.message },
    ];
    for (let round = 0; round <= 3; round++) {
      const response = await client.chat.completions.create({
        model: config.model, messages, tools, tool_choice: 'auto', max_tokens: config.maxTokens, temperature: 0.4,
      }, { signal });
      const choice = response.choices[0];
      if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('AI response did not complete');
      const message = choice.message;
      if (!message.tool_calls?.length) return finish(message.content);
      if (round === 3 || message.tool_calls.length > 8) throw new Error('AI tool budget exhausted');
      messages.push(message);
      for (const call of message.tool_calls) {
        if (call.type !== 'function') throw new Error('Unsupported AI tool type');
        messages.push({ role: 'tool', tool_call_id: call.id, content: await executeCall(call.function.name, call.function.arguments) });
      }
    }
  }
  throw new Error('AI tool budget exhausted');
}
