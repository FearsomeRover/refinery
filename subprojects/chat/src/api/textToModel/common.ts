/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import {
  type ConcretizationSuccessResult,
  type Issue,
  RefineryError,
} from '@tools.refinery/client';
import type { OpenAI } from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod/v3';

// We deliberately use zod v3 here instead of v4, because this is what OpenAI uses.

export const model = process.env['OPENAI_MODEL'] ?? 'google/gemini-2.5-flash';

export const StageChatResponse = z.object({
  explanation: z.string(),
  assertions: z.string(),
});

export async function runStructuredStageLLM<T extends z.ZodTypeAny>(
  openai: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  schema: T,
  schemaName: string,
  signal?: AbortSignal,
): Promise<z.infer<T>> {
  const responseFormat = zodResponseFormat(schema, schemaName);
  const openAIResult = await openai.chat.completions
    .stream(
      {
        model,
        messages,
        response_format: responseFormat,
      },
      signal === undefined ? {} : { signal },
    )
    .finalChatCompletion();

  const assistantMessage = openAIResult.choices[0]?.message;
  if (assistantMessage === undefined) {
    throw new Error('AI returned no response');
  }
  messages.push(assistantMessage);
  return schema.parse(assistantMessage.parsed);
}

export function convertIssues(
  xtextIssues: Issue[],
  prefixLines: number,
  filter: (issue: Issue) => boolean,
): string[] {
  const issues: string[] = [];
  for (const issue of xtextIssues) {
    if (!filter(issue)) {
      continue;
    }
    if (issue.line < prefixLines) {
      issues.push(`* ${issue.description}`);
    } else {
      issues.push(
        `* Line ${issue.line - prefixLines + 1}: ${issue.description}`,
      );
    }
  }
  return issues;
}

export function invalidProblemToChatMessage(
  err: RefineryError.InvalidProblem,
  prefixLines: number,
): string {
  return `Refinery has returned the following syntax errors:

${convertIssues(err.issues, prefixLines, ({ severity }) => severity === 'error').join('\n')}

Please check your assertions and fix the errors.`;
}

export function concretizationResultToChatMessage(
  result: ConcretizationSuccessResult,
): string | undefined {
  if (result.json === undefined) {
    throw new Error('Concretization result does not contain JSON');
  }
  const { json } = result;
  const issues: string[] = convertIssues(result.issues, 0, () => true);

  for (const relationMetadata of json.relations) {
    const tuples = json.partialInterpretation[relationMetadata.name] ?? [];
    for (const tuple of tuples) {
      const value = tuple[tuple.length - 1];
      if (
        value !== 'error' &&
        !(typeof value === 'object' && 'error' in value)
      ) {
        continue;
      }
      const args = tuple
        .slice(0, -1)
        .map((id) => {
          if (typeof id !== 'number') {
            throw new Error('Invalid node ID');
          }
          const nodeMetadata = json.nodes[id];
          return nodeMetadata?.simpleName ?? String(id);
        })
        .join(', ');
      issues.push(`${relationMetadata.simpleName}(${args}): error.`);
    }
  }

  if (issues.length === 0) {
    return undefined;
  }

  return `Refinery has returned the following semantics errors in the model:

<errors>
${issues.join('\n')}
</error>

Please check your assertions and fix the errors.`;
}

export async function runStageLLM(
  openai: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  signal?: AbortSignal,
): Promise<z.infer<typeof StageChatResponse>> {
  return runStructuredStageLLM(
    openai,
    messages,
    StageChatResponse,
    'stage_chat_response',
    signal,
  );
}

export async function validateAssertionsWithRefinery(
  refinery: {
    concretize: (
      input: {
        input: { source: string };
        format: import('@tools.refinery/client').OutputFormats;
      },
      options?: { signal?: AbortSignal },
    ) => Promise<ConcretizationSuccessResult>;
  },
  metamodelSource: string,
  assertions: string,
  format: import('@tools.refinery/client').OutputFormats,
  signal?: AbortSignal,
): Promise<{
  modelSource: string;
  prefixLines: number;
  result: ConcretizationSuccessResult;
}> {
  const prefix = `${metamodelSource}\n\n`;
  const prefixLines = prefix.split('\n').length;
  const modelSource = `${prefix}${assertions}`;
  const result = await refinery.concretize(
    {
      input: { source: modelSource },
      format: {
        ...format,
        json: {
          ...(format.json ?? {}),
          enabled: true,
          nonExistingObjects: 'discard',
        },
      },
    },
    signal === undefined ? {} : { signal },
  );
  return { modelSource, prefixLines, result };
}
