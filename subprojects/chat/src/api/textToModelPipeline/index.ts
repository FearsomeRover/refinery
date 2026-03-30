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
  type ExtractedDomain,
  type PipelineCandidate,
  type TextToModelPipelineResult,
  TextToModelPipelineRequest,
  type TextToModelPipelineStatus,
} from '@tools.refinery/client/chat';
import type { RequestHandler } from 'express';
import type { OpenAI } from 'openai';
import { z } from 'zod/v3';

import {
  collectIssueDiagnostics,
  concretizationResultToChatMessage,
  invalidProblemToChatMessage,
  runStageLLM,
  runStructuredStageLLM,
  validateAssertionsWithRefinery,
} from '../textToModel/common';

import blindJudgePrompt from './blindJudge.md';
import branchAssertionsPrompt from './branchAssertions.md';
import {
  draftLintToChatMessage,
  lintDraftAssertions,
  normalizeDraftText,
} from './draftLint';
import { extractDomain } from './extractDomain';
import modelCriticPrompt from './modelCritic.md';
import predicatePrompt from './predicates.md';
import {
  analyzeCandidateRichness,
  deriveRichnessPlan,
  rankCandidatesByRichnessAndDiversity,
  type RichnessPlan,
} from './richnessPlan';
import structurePrompt from './structure.md';

const AssertionBranch = z.object({
  explanation: z.string(),
  assertions: z.string(),
});

const AssertionBranchResponse = z.object({
  explanation: z.string(),
  branches: z.array(AssertionBranch),
});

interface ValidatedAssertionBranch {
  branchIndex: number;
  sourceKind: 'seed' | 'variant';
  explanation: string;
  assertions: string;
  normalizedSignature: string;
  validation: ConcretizationSuccessResult;
}

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

function createProgressSignature(
  assertions: string,
  feedback: string[],
): string {
  return JSON.stringify({
    assertions: normalizeDraftText(assertions),
    feedback,
  });
}

function summarizeFeedback(feedback: string[]): string {
  return feedback.join(' | ');
}

function createDomainSummaryBlock(extractedDomain: ExtractedDomain): string {
  return `Summary: ${extractedDomain.summary}
Entities: ${extractedDomain.entities.join(', ')}
Relations: ${extractedDomain.relations.join(' | ')}
Requirements: ${extractedDomain.requirements.join(' | ')}
Examples: ${extractedDomain.examples.join(' | ')}
Ambiguities: ${extractedDomain.ambiguities.join(' | ')}`;
}

function formatTargetSummary(
  label: string,
  targets: { symbolName: string; min: number }[],
): string {
  if (targets.length === 0) {
    return `${label}: none`;
  }
  return `${label}: ${targets
    .map(({ symbolName, min }) => `${symbolName}>=${min}`)
    .join(', ')}`;
}

function createRichnessGuidance(plan: RichnessPlan): string {
  const sections = [
    formatTargetSummary('Central classes', plan.targetInstances),
    formatTargetSummary('Grounded relations', plan.targetRelations),
    plan.optionalFeatures.length === 0
      ? 'Optional prompt-mentioned features: none'
      : `Optional prompt-mentioned features: ${plan.optionalFeatures.join(', ')}`,
    plan.overlapPatterns.length === 0
      ? 'Overlap preference: none'
      : `Overlap preference: ${plan.overlapPatterns.map(({ description }) => description).join(' | ')}`,
  ];
  return sections.join('\n');
}

function normalizeAssertionSignature(assertions: string): string {
  return splitLines(normalizeDraftText(assertions)).sort().join('\n');
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

async function validateAssertionBranch(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  params: {
    branchIndex: number;
    sourceKind: 'seed' | 'variant';
    structureSource: string;
    assertions: string;
    explanation: string;
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    format: Parameters<typeof validateAssertionsWithRefinery>[3];
  },
): Promise<ValidatedAssertionBranch | undefined> {
  const { branchIndex, sourceKind, structureSource, messages, format } = params;
  let { assertions, explanation } = params;

  const prefixLines = `${structureSource}\n\n`.split('\n').length;
  let previousFailureSignature: string | undefined;
  let repeatedFailureCount = 0;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt === 0) {
      await writeStatus(res, {
        role: 'refinery',
        stage: 'predicates',
        kind: 'progress',
        content: `Validating ${sourceKind === 'seed' ? 'seed' : 'branched'} assertion draft ${branchIndex}`,
      });
    } else {
      await writeStatus(res, {
        role: 'refinery',
        stage: 'predicates',
        kind: 'progress',
        content: `Repairing assertion branch ${branchIndex} using precise validation feedback`,
      });
      const repaired = await runStageLLM(req.openai, messages, req.signal);
      assertions = repaired.assertions;
      explanation = repaired.explanation;
      req.log.info(
        {
          branchIndex,
          explanation,
          assertions,
        },
        'Pipeline branch repair output',
      );
    }

    const lintResult = lintDraftAssertions(structureSource, assertions);
    if (!lintResult.passed) {
      const feedbackSignature = createProgressSignature(
        assertions,
        lintResult.errors,
      );
      if (feedbackSignature === previousFailureSignature) {
        repeatedFailureCount += 1;
      } else {
        previousFailureSignature = feedbackSignature;
        repeatedFailureCount = 0;
      }
      if (repeatedFailureCount >= 1) {
        req.log.info(
          { branchIndex, lintResult },
          'Pipeline branch dropped after repeated lint non-progress',
        );
        return undefined;
      }
      messages.push({
        role: 'user',
        content: draftLintToChatMessage(lintResult),
      });
      await writeStatus(res, {
        role: 'refinery',
        stage: 'predicates',
        kind: 'warning',
        content: `Assertion branch ${branchIndex} did not match the structure: ${summarizeFeedback(lintResult.errors)}`,
      });
      continue;
    }

    let validation:
      | Awaited<ReturnType<typeof validateAssertionsWithRefinery>>
      | undefined;
    try {
      validation = await validateAssertionsWithRefinery(
        req.refinery,
        structureSource,
        assertions,
        format,
        req.signal,
      );
    } catch (err) {
      if (err instanceof RefineryError.InvalidProblem) {
        const compilerDiagnostics = collectIssueDiagnostics(
          err.issues,
          prefixLines,
          ({ severity }) => severity === 'error',
        );
        const compilerFeedback = compilerDiagnostics.map(
          ({ adjustedLine, description }) =>
            adjustedLine === undefined
              ? description
              : `Line ${adjustedLine}: ${description}`,
        );
        const feedbackSignature = createProgressSignature(
          assertions,
          compilerFeedback,
        );
        if (feedbackSignature === previousFailureSignature) {
          repeatedFailureCount += 1;
        } else {
          previousFailureSignature = feedbackSignature;
          repeatedFailureCount = 0;
        }
        if (repeatedFailureCount >= 1) {
          req.log.info(
            { branchIndex, compilerDiagnostics },
            'Pipeline branch dropped after repeated compiler non-progress',
          );
          return undefined;
        }
        messages.push({
          role: 'user',
          content: invalidProblemToChatMessage(err, prefixLines),
        });
        await writeStatus(res, {
          role: 'refinery',
          stage: 'predicates',
          kind: 'warning',
          content: `Assertion branch ${branchIndex} had compiler errors: ${summarizeFeedback(compilerFeedback)}`,
        });
        continue;
      }
      throw err;
    }

    if (validation === undefined) {
      continue;
    }

    const semanticErrorMessage = concretizationResultToChatMessage(
      validation.result,
    );
    if (semanticErrorMessage === undefined) {
      await writeStatus(res, {
        role: 'assistant',
        stage: 'predicates',
        kind: 'progress',
        content: `Validated assertion branch ${branchIndex}: ${explanation}`,
      });
      return {
        branchIndex,
        sourceKind,
        explanation,
        assertions,
        normalizedSignature: normalizeAssertionSignature(assertions),
        validation: validation.result,
      };
    }

    const semanticFeedback = semanticErrorMessage
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('*') || line.endsWith(': error.'));
    const feedbackSignature = createProgressSignature(
      assertions,
      semanticFeedback.length === 0 ? [semanticErrorMessage] : semanticFeedback,
    );
    if (feedbackSignature === previousFailureSignature) {
      repeatedFailureCount += 1;
    } else {
      previousFailureSignature = feedbackSignature;
      repeatedFailureCount = 0;
    }
    if (repeatedFailureCount >= 1) {
      req.log.info(
        { branchIndex, semanticFeedback },
        'Pipeline branch dropped after repeated semantic non-progress',
      );
      return undefined;
    }

    messages.push({ role: 'user', content: semanticErrorMessage });
    await writeStatus(res, {
      role: 'refinery',
      stage: 'predicates',
      kind: 'warning',
      content: `Assertion branch ${branchIndex} was semantically invalid, attempting repair`,
    });
  }

  return undefined;
}

async function generateAssertionVariants(
  openai: OpenAI,
  signal: AbortSignal,
  params: {
    text: string;
    structureSource: string;
    seedAssertions: string;
    extractedDomain: ExtractedDomain;
    richnessPlan: RichnessPlan;
    branchCount: number;
  },
): Promise<z.infer<typeof AssertionBranchResponse>> {
  const {
    text,
    structureSource,
    seedAssertions,
    extractedDomain,
    richnessPlan,
    branchCount,
  } = params;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: branchAssertionsPrompt,
    },
    {
      role: 'user',
      content: `## Task

Produce exactly ${branchCount} alternative assertion branches derived from the validated seed assertions.
Do not repeat the seed verbatim.
Every branch must remain faithful to the specification and structure while differing meaningfully from the other branches.

<metamodel>
${structureSource}
</metamodel>

<specification>
${text}
</specification>

<domain-summary>
${createDomainSummaryBlock(extractedDomain)}
</domain-summary>

<seed-assertions>
${seedAssertions}
</seed-assertions>

<richness-guidance>
${createRichnessGuidance(richnessPlan)}
</richness-guidance>`,
    },
  ];
  return runStructuredStageLLM(
    openai,
    messages,
    AssertionBranchResponse,
    'assertion_branch_response',
    signal,
  );
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
  assumptions.push(
    ...extractedDomain.assumptions,
    ...extractedDomain.ambiguities,
  );
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
    const structureMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [
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
${createDomainSummaryBlock(extractedDomain)}
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
        req.log.info(
          {
            diagnostics: collectIssueDiagnostics(
              err.issues,
              0,
              ({ severity }) => severity === 'error',
            ),
          },
          'Pipeline structure compiler issues',
        );
        structureMessages.push({
          role: 'user',
          content: invalidProblemToChatMessage(err, 0),
        });
        await writeStatus(res, {
          role: 'refinery',
          stage: 'structure',
          kind: 'warning',
          content: 'Generated structure had compiler errors, attempting repair',
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

  const richnessPlan = deriveRichnessPlan(
    text,
    extractedDomain,
    structureSource,
  );
  req.log.info({ richnessPlan }, 'Pipeline grounded richness plan');

  const predicateMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    [
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
${createDomainSummaryBlock(extractedDomain)}
</domain-summary>`,
      },
    ];

  let validatedSeedResult: ConcretizationSuccessResult | undefined;
  let seedAssertions = '';
  const prefixLines = `${structureSource}\n\n`.split('\n').length;
  let previousFailureSignature: string | undefined;
  let repeatedFailureCount = 0;

  for (let i = 0; i < 5; i += 1) {
    await writeStatus(res, {
      role: 'refinery',
      stage: 'predicates',
      kind: i === 0 ? 'started' : 'progress',
      content:
        i === 0
          ? 'Generating an initial grounded assertion draft from the description'
          : 'Repairing the generated seed assertions based on precise validation feedback',
    });

    const predicateResult = await runStageLLM(
      req.openai,
      predicateMessages,
      req.signal,
    );
    assumptions.push(predicateResult.explanation);
    seedAssertions = predicateResult.assertions;
    req.log.info(
      {
        explanation: predicateResult.explanation,
        assertions: seedAssertions,
      },
      'Pipeline predicate stage output',
    );
    await writeStatus(res, {
      role: 'assistant',
      stage: 'predicates',
      kind: 'progress',
      content: predicateResult.explanation,
    });

    const previewSource = `${structureSource}\n\n${seedAssertions}`.trim();
    await writeStatus(res, {
      role: 'assistant',
      stage: 'preview',
      kind: 'progress',
      content: `Generated seed Refinery source before validation:\n${previewSource}`,
    });

    const lintResult = lintDraftAssertions(structureSource, seedAssertions);
    if (!lintResult.passed) {
      req.log.info({ lintResult }, 'Pipeline draft lint issues');
      const feedbackSignature = createProgressSignature(
        seedAssertions,
        lintResult.errors,
      );
      if (feedbackSignature === previousFailureSignature) {
        repeatedFailureCount += 1;
      } else {
        previousFailureSignature = feedbackSignature;
        repeatedFailureCount = 0;
      }
      if (repeatedFailureCount >= 1) {
        throw new RefineryError.Unsatisfiable({
          result: 'unsatisfiable',
          message:
            'Pipeline stopped after repeated non-progress in assertion repair',
        });
      }
      predicateMessages.push({
        role: 'user',
        content: draftLintToChatMessage(lintResult),
      });
      await writeStatus(res, {
        role: 'refinery',
        stage: 'predicates',
        kind: 'warning',
        content: `Generated assertions did not match the structural scaffold: ${summarizeFeedback(lintResult.errors)}`,
      });
      continue;
    }

    try {
      await writeStatus(res, {
        role: 'refinery',
        stage: 'concretize',
        kind: 'started',
        content: 'Checking the generated seed problem with Refinery',
      });
      const validation = await validateAssertionsWithRefinery(
        req.refinery,
        structureSource,
        seedAssertions,
        format,
        req.signal,
      );
      validatedSeedResult = validation.result;
      previousFailureSignature = undefined;
      repeatedFailureCount = 0;
    } catch (err) {
      if (err instanceof RefineryError.InvalidProblem) {
        const compilerDiagnostics = collectIssueDiagnostics(
          err.issues,
          prefixLines,
          ({ severity }) => severity === 'error',
        );
        req.log.info(
          { compilerDiagnostics },
          'Pipeline predicate compiler issues',
        );
        const compilerFeedback = compilerDiagnostics.map(
          ({ adjustedLine, description }) =>
            adjustedLine === undefined
              ? description
              : `Line ${adjustedLine}: ${description}`,
        );
        const feedbackSignature = createProgressSignature(
          seedAssertions,
          compilerFeedback,
        );
        if (feedbackSignature === previousFailureSignature) {
          repeatedFailureCount += 1;
        } else {
          previousFailureSignature = feedbackSignature;
          repeatedFailureCount = 0;
        }
        if (repeatedFailureCount >= 1) {
          throw new RefineryError.Unsatisfiable({
            result: 'unsatisfiable',
            message:
              'Pipeline stopped after repeated non-progress in assertion repair',
          });
        }
        predicateMessages.push({
          role: 'user',
          content: invalidProblemToChatMessage(err, prefixLines),
        });
        await writeStatus(res, {
          role: 'refinery',
          stage: 'concretize',
          kind: 'warning',
          content: `Generated seed assertions had compiler errors, attempting repair: ${summarizeFeedback(compilerFeedback)}`,
        });
        continue;
      }
      throw err;
    }

    if (validatedSeedResult === undefined) {
      continue;
    }
    const semanticErrorMessage =
      concretizationResultToChatMessage(validatedSeedResult);
    if (semanticErrorMessage === undefined) {
      break;
    }
    const semanticFeedback = semanticErrorMessage
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('*') || line.endsWith(': error.'));
    const feedbackSignature = createProgressSignature(
      seedAssertions,
      semanticFeedback.length === 0 ? [semanticErrorMessage] : semanticFeedback,
    );
    if (feedbackSignature === previousFailureSignature) {
      repeatedFailureCount += 1;
    } else {
      previousFailureSignature = feedbackSignature;
      repeatedFailureCount = 0;
    }
    if (repeatedFailureCount >= 1) {
      throw new RefineryError.Unsatisfiable({
        result: 'unsatisfiable',
        message:
          'Pipeline stopped after repeated non-progress in assertion repair',
      });
    }
    predicateMessages.push({ role: 'user', content: semanticErrorMessage });
    validatedSeedResult = undefined;
    await writeStatus(res, {
      role: 'refinery',
      stage: 'concretize',
      kind: 'warning',
      content:
        'Generated seed assertions were semantically invalid, attempting repair',
    });
  }

  if (validatedSeedResult === undefined) {
    throw new RefineryError.Unsatisfiable({
      result: 'unsatisfiable',
      message: 'Pipeline failed to generate a satisfiable seed model',
    });
  }

  const validatedBranches: ValidatedAssertionBranch[] = [
    {
      branchIndex: 1,
      sourceKind: 'seed',
      explanation:
        'Seed branch preserving the validated prompt-grounded draft.',
      assertions: seedAssertions,
      normalizedSignature: normalizeAssertionSignature(seedAssertions),
      validation: validatedSeedResult,
    },
  ];
  const seenBranchSignatures = new Set(
    validatedBranches.map((branch) => branch.normalizedSignature),
  );

  if (candidateCount > 1) {
    await writeStatus(res, {
      role: 'refinery',
      stage: 'predicates',
      kind: 'started',
      content: `Generating ${candidateCount - 1} alternative assertion branch${candidateCount === 2 ? '' : 'es'} from the validated seed`,
    });

    const generatedBranches = await generateAssertionVariants(
      req.openai,
      req.signal,
      {
        text,
        structureSource,
        seedAssertions,
        extractedDomain,
        richnessPlan,
        branchCount: candidateCount - 1,
      },
    );
    assumptions.push(generatedBranches.explanation);
    req.log.info(
      { generatedBranches },
      'Pipeline generated assertion branches',
    );
    await writeStatus(res, {
      role: 'assistant',
      stage: 'predicates',
      kind: 'progress',
      content: generatedBranches.explanation,
    });

    let nextBranchIndex = 2;
    for (const rawBranch of generatedBranches.branches) {
      if (validatedBranches.length >= candidateCount) {
        break;
      }
      const normalizedSignature = normalizeAssertionSignature(
        rawBranch.assertions,
      );
      if (
        normalizedSignature === '' ||
        seenBranchSignatures.has(normalizedSignature)
      ) {
        req.log.info(
          {
            branchExplanation: rawBranch.explanation,
            normalizedSignature,
          },
          'Pipeline dropped duplicate assertion branch before validation',
        );
        continue;
      }

      const branchMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
        [
          {
            role: 'system',
            content: branchAssertionsPrompt,
          },
          {
            role: 'user',
            content: `## Task

Repair and preserve this assertion branch so it remains faithful to the specification and distinct from the seed.
Keep the branch-specific modeling choice unless validation feedback forces a change.

<metamodel>
${structureSource}
</metamodel>

<specification>
${text}
</specification>

<domain-summary>
${createDomainSummaryBlock(extractedDomain)}
</domain-summary>

<seed-assertions>
${seedAssertions}
</seed-assertions>

<branch-goal>
${rawBranch.explanation}
</branch-goal>

<branch-assertions>
${rawBranch.assertions}
</branch-assertions>

<richness-guidance>
${createRichnessGuidance(richnessPlan)}
</richness-guidance>`,
          },
        ];

      const validatedBranch = await validateAssertionBranch(req, res, {
        branchIndex: nextBranchIndex,
        sourceKind: 'variant',
        structureSource,
        assertions: rawBranch.assertions,
        explanation: rawBranch.explanation,
        messages: branchMessages,
        format,
      });
      nextBranchIndex += 1;
      if (validatedBranch === undefined) {
        continue;
      }
      if (seenBranchSignatures.has(validatedBranch.normalizedSignature)) {
        req.log.info(
          {
            branchIndex: validatedBranch.branchIndex,
            normalizedSignature: validatedBranch.normalizedSignature,
          },
          'Pipeline dropped duplicate assertion branch after repair',
        );
        continue;
      }
      seenBranchSignatures.add(validatedBranch.normalizedSignature);
      validatedBranches.push(validatedBranch);
      assumptions.push(validatedBranch.explanation);
    }
  }

  const branchesForGeneration = validatedBranches.slice(0, candidateCount);
  await writeStatus(res, {
    role: 'refinery',
    stage: 'candidates',
    kind: 'started',
    content: `Generating ${branchesForGeneration.length} example model${branchesForGeneration.length === 1 ? '' : 's'} from validated assertion branch${branchesForGeneration.length === 1 ? '' : 'es'}`,
  });

  const candidateResults = await Promise.all(
    branchesForGeneration.map((branch) =>
      req.refinery.generate(
        {
          input: {
            source: `${structureSource}\n\n${branch.assertions}`,
          },
          randomSeed: branch.branchIndex,
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
      ),
    ),
  );
  await writeStatus(res, {
    role: 'assistant',
    stage: 'candidates',
    kind: 'completed',
    content: `Generated ${candidateResults.length} example model${candidateResults.length === 1 ? '' : 's'} from ${branchesForGeneration.length} validated branch${branchesForGeneration.length === 1 ? '' : 'es'}`,
  });

  await writeStatus(res, {
    role: 'refinery',
    stage: 'critique',
    kind: 'started',
    content:
      'Evaluating all generated examples against the original description',
  });

  const critiqueResults = await Promise.all(
    candidateResults.map((candidate, index) => {
      const branch = branchesForGeneration[index];
      const critiqueSource = sanitizeCandidateSourceForCritique(
        candidate.source ?? `${structureSource}\n\n${branch?.assertions ?? ''}`,
      );
      req.log.info(
        {
          randomSeed: branch?.branchIndex,
          branchExplanation: branch?.explanation,
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

  const candidates: PipelineCandidate[] = candidateResults.map(
    (candidate, index) => {
      const branch = branchesForGeneration[index];
      return {
        randomSeed: branch?.branchIndex ?? index + 1,
        branchIndex: branch?.branchIndex,
        branchExplanation: branch?.explanation,
        source: candidate.source,
        json: candidate.json,
        critique: deduplicateFindings(critiqueResults[index] ?? []),
      };
    },
  );

  req.log.info({ critiqueResults }, 'Pipeline critique stage output');

  const richnessAnalyses = candidates.map((candidate) =>
    analyzeCandidateRichness(
      candidate.randomSeed,
      candidate.json,
      richnessPlan,
    ),
  );
  const rankedAnalyses = rankCandidatesByRichnessAndDiversity(
    richnessAnalyses,
    candidates.map((candidate) => candidate.critique.length),
  );
  const candidateBySeed = new Map(
    candidates.map((candidate) => [candidate.randomSeed, candidate]),
  );
  const rankedCandidates = rankedAnalyses
    .map((analysis) => candidateBySeed.get(analysis.randomSeed))
    .filter(
      (candidate): candidate is NonNullable<typeof candidate> =>
        candidate !== undefined,
    );

  req.log.info(
    {
      richnessPlan,
      richnessAnalyses: rankedAnalyses,
      validatedBranches: branchesForGeneration.map((branch) => ({
        branchIndex: branch.branchIndex,
        sourceKind: branch.sourceKind,
        explanation: branch.explanation,
      })),
    },
    'Pipeline branch-aware candidate ranking',
  );

  const findings = deduplicateFindings(critiqueResults.flat());
  req.log.info({ findings }, 'Pipeline aggregated findings');
  await writeStatus(res, {
    role: 'assistant',
    stage: 'aggregate',
    kind: 'completed',
    content:
      findings.length === 0
        ? 'Evaluated branched examples against the prompt and ranked them by fidelity, richness, and diversity'
        : `Evaluated branched examples against the prompt, ranked them by fidelity, richness, and diversity, and found ${findings.length} confirmed review issue${findings.length === 1 ? '' : 's'}`,
  });

  const primaryCandidate = rankedCandidates[0];
  const result: TextToModelPipelineResult = {
    ...validatedSeedResult,
    source: primaryCandidate?.source ?? validatedSeedResult.source,
    json: primaryCandidate?.json ?? validatedSeedResult.json,
    extractedDomain,
    structureSource,
    assumptions: unique(assumptions.filter((value) => value.trim().length > 0)),
    findings,
    candidates: rankedCandidates,
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
