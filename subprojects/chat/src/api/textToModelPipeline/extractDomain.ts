/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import type { OpenAI } from 'openai';
import { z } from 'zod/v3';

import extractDomainPrompt from './extractDomain.md';
import { runStructuredStageLLM } from '../textToModel/common';

export const ExtractedDomain = z.object({
  summary: z.string(),
  entities: z.string().array(),
  relations: z.string().array(),
  requirements: z.string().array(),
  examples: z.string().array(),
  ambiguities: z.string().array(),
  assumptions: z.string().array(),
});

export type ExtractedDomain = z.infer<typeof ExtractedDomain>;

export async function extractDomain(
  openai: OpenAI,
  text: string,
  signal?: AbortSignal,
): Promise<ExtractedDomain> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: extractDomainPrompt,
    },
    {
      role: 'user',
      content: `## Task\n\n<specification>\n${text}\n</specification>`,
    },
  ];
  return runStructuredStageLLM(
    openai,
    messages,
    ExtractedDomain,
    'extracted_domain',
    signal,
  );
}
