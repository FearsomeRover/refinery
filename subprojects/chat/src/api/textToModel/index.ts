/*
 * SPDX-FileCopyrightText: 2025 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import {
  type ConcretizationSuccessResult,
  RefineryError,
} from '@tools.refinery/client';
import {
  type TextToModelResult,
  TextToModelRequest,
  type TextToModelStatus,
} from '@tools.refinery/client/chat';
import type { RequestHandler } from 'express';
import type { OpenAI } from 'openai';

import system from './system.md';
import {
  concretizationResultToChatMessage,
  invalidProblemToChatMessage,
  runStageLLM,
  validateAssertionsWithRefinery,
} from './common';

const textToModel: RequestHandler = async (req, res) => {
  const { metamodel, text, format } = TextToModelRequest.parse(req.body);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: system,
    },
    {
      role: 'user',
      content: `## Task

<metamodel>
${metamodel.source}
</metamodel>

<specification>
${text}
</specification>
`,
    },
  ];

  for (let i = 0; i < 5; i += 1) {
    const chatResponse = await runStageLLM(req.openai, messages, req.signal);

    await res.writeStatus({
      role: 'assistant',
      content: chatResponse.explanation,
    } satisfies TextToModelStatus);

    req.log.debug({ chatResponse }, 'Generated chat response');

    let refineryResult: ConcretizationSuccessResult;
    const prefixLines = `${metamodel.source}\n\n`.split('\n').length;
    try {
      const validation = await validateAssertionsWithRefinery(
        req.refinery,
        metamodel.source,
        chatResponse.assertions,
        format,
        req.signal,
      );
      refineryResult = validation.result;
    } catch (err) {
      if (err instanceof RefineryError.InvalidProblem) {
        const errorMessage = invalidProblemToChatMessage(err, prefixLines);
        res.log.debug({ errorMessage }, 'Syntax errors');
        messages.push({
          role: 'user',
          content: errorMessage,
        });
        await res.writeStatus({
          role: 'refinery',
          content: 'AI response contains syntax errors',
        });
        continue;
      }
      throw err;
    }

    const errorMessage = concretizationResultToChatMessage(refineryResult);
    if (errorMessage === undefined) {
      if (!(format?.json.enabled ?? true)) {
        delete refineryResult.json;
      }
      await res.writeSuccess({
        ...refineryResult,
      } satisfies TextToModelResult);
      return;
    }
    res.log.debug({ errorMessage }, 'Semantic errors');
    messages.push({
      role: 'user',
      content: errorMessage,
    });
    await res.writeStatus({
      role: 'refinery',
      content: 'AI response contains semantic errors',
    });
  }

  throw new RefineryError.Unsatisfiable({
    result: 'unsatisfiable',
    message: 'AI failed to generate a suitable response',
  });
};

export default textToModel;
