/*
 * SPDX-FileCopyrightText: 2026 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import {
  type ConcretizationSuccessResult,
  RefineryError,
} from '@tools.refinery/client';
import {
  type TextToModelPipelineResult,
  TextToModelPipelineRequest,
  type TextToModelPipelineStatus,
} from '@tools.refinery/client/chat';
import type { RequestHandler } from 'express';
import type { OpenAI } from 'openai';

import blindJudgePrompt from './blindJudge.md';
import modelCriticPrompt from './modelCritic.md';
import predicatePrompt from './predicates.md';
import structurePrompt from './structure.md';
import { extractDomain } from './extractDomain';
import {
  concretizationResultToChatMessage,
  invalidProblemToChatMessage,
  runStageLLM,
  validateAssertionsWithRefinery,
} from '../textToModel/common';

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sanitizeCandidateSourceForCritique(source: string): string {
  return source
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('default ');
    })
    .join('\n');
}

function normalizeFinding(finding: string): string {
  return finding
    .toLowerCase()
    .replace(/[`'.",:;!?()-]/g, ' ')
    .replace(/\balice\b/g, 'name')
    .replace(/\bbob\b/g, 'name')
    .replace(/\bteam\b/g, 'entity')
    .replace(/\bmembers\b/g, 'relation')
    .replace(/\bexplicitly\b/g, '')
    .replace(/\bincorrectly\b/g, '')
    .replace(/\bthe specification\b/g, '')
    .replace(/\bthe model\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isActionableFinding(finding: string): boolean {
  const normalized = finding.toLowerCase();
  if (normalized === '') {
    return false;
  }
  if (normalized.includes('default ')) {
    return false;
  }
  if (normalized.includes('specification requires')) {
    return false;
  }
  if (normalized.includes('specification explicitly names')) {
    return false;
  }
  if (normalized.includes('explicitly requested by the specification')) {
    return false;
  }
  if (normalized.includes('without directly linking')) {
    return false;
  }
  return true;
}

function deduplicateFindings(findings: string[]): string[] {
  const deduplicated = new Map<string, string>();
  for (const finding of findings) {
    if (!isActionableFinding(finding)) {
      continue;
    }
    const key = normalizeFinding(finding);
    if (key === '' || deduplicated.has(key)) {
      continue;
    }
    deduplicated.set(key, finding);
  }
  return [...deduplicated.values()];
}

async function writeStatus(
  res: Express.Response,
  status: TextToModelPipelineStatus,
): Promise<void> {
  await res.writeStatus(status);
}

async function critiqueCandidate(
  openai: OpenAI,
  signal: AbortSignal,
  text: string,
  structureSource: string,
  candidateSource: string,
): Promise<string[]> {
  const criticMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: modelCriticPrompt,
    },
    {
      role: 'user',
      content: `## Task

<specification>
${text}
</specification>

<structure>
${structureSource}
</structure>

<model>
${candidateSource}
</model>`,
    },
  ];
  const criticResult = await runStageLLM(openai, criticMessages, signal);

  const judgeMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: blindJudgePrompt,
    },
    {
      role: 'user',
      content: `## Task

<specification>
${text}
</specification>

<findings>
${criticResult.assertions}
</findings>`,
    },
  ];
  const judgeResult = await runStageLLM(openai, judgeMessages, signal);
  return splitLines(judgeResult.assertions);
}

const textToModelPipeline: RequestHandler = async (req, res) => {
  const { metamodel, text, format, candidateCount } =
    TextToModelPipelineRequest.parse(req.body);

  const assumptions: string[] = [];

  await writeStatus(res, {
    role: 'refinery',
    stage: 'extract',
    kind: 'started',
    content: 'Extracting a structured domain summary from the description',
  });
  const extractedDomain = await extractDomain(req.openai, text, req.signal);
  assumptions.push(...extractedDomain.assumptions, ...extractedDomain.ambiguities);
  req.log.info({ extractedDomain }, 'Pipeline extracted domain');
  await writeStatus(res, {
    role: 'assistant',
    stage: 'extract',
    kind: 'completed',
    content: extractedDomain.summary,
  });

  let structureSource = metamodel.source.trim();
  await writeStatus(res, {
    role: 'refinery',
    stage: 'structure',
    kind: 'started',
    content:
      structureSource.length > 0
        ? 'Using the current editor contents as the structural scaffold'
        : 'Generating an initial structural scaffold from the extracted domain',
  });

  if (structureSource.length === 0) {
    const structureMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: structurePrompt,
      },
      {
        role: 'user',
        content: `## Task

<specification>
${text}
</specification>

<domain-summary>
Summary: ${extractedDomain.summary}
Entities: ${extractedDomain.entities.join(', ')}
Relations: ${extractedDomain.relations.join(' | ')}
Requirements: ${extractedDomain.requirements.join(' | ')}
Examples: ${extractedDomain.examples.join(' | ')}
Ambiguities: ${extractedDomain.ambiguities.join(' | ')}
</domain-summary>`,
      },
    ];

    for (let i = 0; i < 3; i += 1) {
      const structureResult = await runStageLLM(
        req.openai,
        structureMessages,
        req.signal,
      );
      const candidateStructure = structureResult.assertions.trim();
      assumptions.push(structureResult.explanation);
      try {
        await validateAssertionsWithRefinery(
          req.refinery,
          candidateStructure,
          '',
          format,
          req.signal,
        );
        structureSource = candidateStructure;
        await writeStatus(res, {
          role: 'assistant',
          stage: 'structure',
          kind: 'completed',
          content: structureResult.explanation,
        });
        break;
      } catch (err) {
        if (!(err instanceof RefineryError.InvalidProblem)) {
          throw err;
        }
        structureMessages.push({
          role: 'user',
          content: invalidProblemToChatMessage(err, 0),
        });
        await writeStatus(res, {
          role: 'refinery',
          stage: 'structure',
          kind: 'warning',
          content: 'Generated structure had syntax errors, attempting repair',
        });
      }
    }
    if (structureSource.length === 0) {
      throw new RefineryError.Unsatisfiable({
        result: 'unsatisfiable',
        message: 'Pipeline failed to derive a valid structural scaffold',
      });
    }
  } else {
    await writeStatus(res, {
      role: 'assistant',
      stage: 'structure',
      kind: 'completed',
      content: 'Reused the provided structure as the starting point',
    });
  }

  const predicateMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: predicatePrompt,
    },
    {
      role: 'user',
      content: `## Task

<metamodel>
${structureSource}
</metamodel>

<specification>
${text}
</specification>

<domain-summary>
Summary: ${extractedDomain.summary}
Entities: ${extractedDomain.entities.join(', ')}
Relations: ${extractedDomain.relations.join(' | ')}
Requirements: ${extractedDomain.requirements.join(' | ')}
Examples: ${extractedDomain.examples.join(' | ')}
Ambiguities: ${extractedDomain.ambiguities.join(' | ')}
</domain-summary>`,
    },
  ];

  let validatedResult: ConcretizationSuccessResult | undefined;
  let finalAssertions = '';
  const prefixLines = `${structureSource}\n\n`.split('\n').length;

  for (let i = 0; i < 5; i += 1) {
    await writeStatus(res, {
      role: 'refinery',
      stage: 'predicates',
      kind: i === 0 ? 'started' : 'progress',
      content:
        i === 0
          ? 'Generating assertions and constraints from the description'
          : 'Repairing the generated assertions based on Refinery feedback',
    });

    const predicateResult = await runStageLLM(
      req.openai,
      predicateMessages,
      req.signal,
    );
    assumptions.push(predicateResult.explanation);
    finalAssertions = predicateResult.assertions;
    req.log.info(
      {
        explanation: predicateResult.explanation,
        assertions: finalAssertions,
      },
      'Pipeline predicate stage output',
    );
    await writeStatus(res, {
      role: 'assistant',
      stage: 'predicates',
      kind: 'progress',
      content: predicateResult.explanation,
    });

    const previewSource = `${structureSource}\n\n${finalAssertions}`.trim();
    await writeStatus(res, {
      role: 'assistant',
      stage: 'preview',
      kind: 'progress',
      content: `Generated draft Refinery source before validation:\n${previewSource}`,
    });

    try {
      await writeStatus(res, {
        role: 'refinery',
        stage: 'concretize',
        kind: 'started',
        content: 'Checking the generated problem with Refinery',
      });
      const validation = await validateAssertionsWithRefinery(
        req.refinery,
        structureSource,
        finalAssertions,
        format,
        req.signal,
      );
      validatedResult = validation.result;
    } catch (err) {
      if (err instanceof RefineryError.InvalidProblem) {
        const errorMessage = invalidProblemToChatMessage(err, prefixLines);
        predicateMessages.push({ role: 'user', content: errorMessage });
        await writeStatus(res, {
          role: 'refinery',
          stage: 'concretize',
          kind: 'warning',
          content: 'Generated assertions had syntax errors, attempting repair',
        });
        continue;
      }
      throw err;
    }

    if (validatedResult === undefined) {
      continue;
    }
    const errorMessage = concretizationResultToChatMessage(validatedResult);
    if (errorMessage === undefined) {
      break;
    }
    predicateMessages.push({ role: 'user', content: errorMessage });
    validatedResult = undefined;
    await writeStatus(res, {
      role: 'refinery',
      stage: 'concretize',
      kind: 'warning',
      content: 'Generated assertions were semantically invalid, attempting repair',
    });
  }

  if (validatedResult === undefined) {
    throw new RefineryError.Unsatisfiable({
      result: 'unsatisfiable',
      message: 'Pipeline failed to generate a satisfiable model',
    });
  }

  await writeStatus(res, {
    role: 'refinery',
    stage: 'candidates',
    kind: 'started',
    content: `Generating ${candidateCount} candidate example model${candidateCount === 1 ? '' : 's'}`,
  });

  const fullSource = `${structureSource}\n\n${finalAssertions}`;
  const candidateTasks = Array.from({ length: candidateCount }, (_value, index) => {
    const randomSeed = index + 1;
    return req.refinery.generate(
      {
        input: { source: fullSource },
        randomSeed,
        format: {
          ...format,
          source: { ...(format.source ?? {}), enabled: true },
          json: {
            ...(format.json ?? {}),
            enabled: true,
            nonExistingObjects: 'discard',
          },
        },
      },
      {
        onStatus: 'ignore',
        signal: req.signal,
      },
    );
  });

  const candidateResults = await Promise.all(candidateTasks);
  await writeStatus(res, {
    role: 'assistant',
    stage: 'candidates',
    kind: 'completed',
    content: `Generated ${candidateResults.length} candidate example model${candidateResults.length === 1 ? '' : 's'}`,
  });

  await writeStatus(res, {
    role: 'refinery',
    stage: 'critique',
    kind: 'started',
    content: 'Critiquing generated models against the original description',
  });

  const critiqueResults = await Promise.all(
    candidateResults.map((candidate, index) => {
      const critiqueSource = sanitizeCandidateSourceForCritique(
        candidate.source ?? fullSource,
      );
      req.log.info(
        {
          randomSeed: index + 1,
          critiqueSource,
        },
        'Pipeline candidate critique input',
      );
      return critiqueCandidate(
        req.openai,
        req.signal,
        text,
        structureSource,
        critiqueSource,
      );
    }),
  );

  const candidates = candidateResults.map((candidate, index) => ({
    randomSeed: index + 1,
    source: candidate.source,
    json: candidate.json,
    critique: deduplicateFindings(critiqueResults[index] ?? []),
  }));

  req.log.info({ critiqueResults }, 'Pipeline critique stage output');

  const findings = deduplicateFindings(critiqueResults.flat());
  req.log.info({ findings }, 'Pipeline aggregated findings');
  await writeStatus(res, {
    role: 'assistant',
    stage: 'aggregate',
    kind: 'completed',
    content:
      findings.length === 0
        ? 'No strong mismatches were found across the generated candidates'
        : `Found ${findings.length} confirmed review issue${findings.length === 1 ? '' : 's'}`,
  });

  const primaryCandidate = candidateResults[0];
  const result: TextToModelPipelineResult = {
    ...validatedResult,
    source: primaryCandidate?.source ?? validatedResult.source,
    json: primaryCandidate?.json ?? validatedResult.json,
    extractedDomain,
    structureSource,
    assumptions: unique(assumptions.filter((value) => value.trim().length > 0)),
    findings,
    candidates,
  };

  if (!(format?.json.enabled ?? true)) {
    delete result.json;
    for (const candidate of result.candidates) {
      delete candidate.json;
    }
  }

  await res.writeSuccess(result);
};

export default textToModelPipeline;
