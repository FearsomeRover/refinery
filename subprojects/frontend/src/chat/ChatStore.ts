/*
 * SPDX-FileCopyrightText: 2025 The Refinery Authors <https://refinery.tools/>
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { RefineryChat } from '@tools.refinery/client/chat';
import { makeAutoObservable, runInAction } from 'mobx';
import { nanoid } from 'nanoid';

import type EditorStore from '../editor/EditorStore';

export interface Message {
  id: string;

  role: 'user' | 'refinery' | 'assistant' | 'error';

  content: string;
}

export default class ChatStore {
  message = '';

  log: Message[] = [];

  running = false;

  editorStore: EditorStore | undefined;

  private abortController: AbortController | undefined;

  private client: RefineryChat | undefined;

  constructor() {
    makeAutoObservable<ChatStore, 'abortController' | 'client'>(this, {
      abortController: false,
      client: false,
    });
  }

  setEditorStore(editorStore: EditorStore | undefined) {
    this.editorStore = editorStore;
    const baseURL = editorStore?.backendConfig.chatURL;
    if (baseURL === undefined) {
      this.client = undefined;
      return;
    }
    this.client = new RefineryChat({ baseURL });
  }

  setMessage(value: string) {
    this.message = value;
  }

  get canGenerate(): boolean {
    return (
      this.editorStore !== undefined &&
      this.client !== undefined &&
      !this.running &&
      this.message !== '' &&
      this.editorStore.errorCount === 0
    );
  }

  generate() {
    if (this.editorStore === undefined) {
      return;
    }
    this.pushLog({
      role: 'user',
      content: this.message,
    });
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    (async () => {
      if (this.editorStore === undefined || this.client === undefined) {
        return;
      }
      const result = await this.client.textToModelPipeline(
        {
          metamodel: { source: this.editorStore.state.sliceDoc() },
          text: this.message,
          candidateCount: 3,
          format: {
            source: { enabled: true },
            json: {
              enabled: true,
              nonExistingObjects: 'discard',
              shadowPredicates: 'keep',
            },
          },
        },
        {
          onStatus: (status) =>
            this.pushLog({
              role: status.role,
              content: `[${status.stage}] ${status.content}`,
            }),
          signal,
        },
      );
      this.pushLog({
        role: 'refinery',
        content: 'Successfully generated model pipeline result',
      });
      this.pushLog({
        role: 'assistant',
        content:
          `Extracted domain summary: ${result.extractedDomain.summary}` +
          (result.extractedDomain.entities.length > 0
            ? `\nEntities: ${result.extractedDomain.entities.join(', ')}`
            : '') +
          (result.extractedDomain.relations.length > 0
            ? `\nRelations: ${result.extractedDomain.relations.join(' | ')}`
            : '') +
          (result.extractedDomain.ambiguities.length > 0
            ? `\nAmbiguities: ${result.extractedDomain.ambiguities.join(' | ')}`
            : ''),
      });
      if (result.findings.length > 0) {
        this.pushLog({
          role: 'assistant',
          content: `Confirmed review findings:\n- ${result.findings.join('\n- ')}`,
        });
      }
      if (result.assumptions.length > 0) {
        this.pushLog({
          role: 'assistant',
          content: `Assumptions and notes:\n- ${result.assumptions.join('\n- ')}`,
        });
      }

      const fallbackCandidate = {
        randomSeed: 0,
        json: result.json,
        source: result.source,
      };
      const candidates =
        result.candidates.length > 0 ? result.candidates : [fallbackCandidate];
      const primarySource = candidates[0]?.source ?? result.source;
      if (primarySource !== undefined) {
        this.editorStore.dispatch({
          changes: {
            from: 0,
            to: this.editorStore.state.doc.length,
            insert: primarySource,
          },
        });
      }
      for (const candidate of candidates) {
        const uuid = nanoid();
        this.editorStore.addGeneratedModel(uuid, candidate.randomSeed);
        if (candidate.json !== undefined) {
          this.editorStore.setGeneratedModelSemantics(
            uuid,
            candidate.json,
            candidate.source,
          );
        } else {
          this.editorStore.setGeneratedModelError(
            uuid,
            'No JSON in generated candidate',
          );
        }
      }
    })()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.pushLog({
          role: 'error',
          content: message,
        });
      })
      .finally(() => {
        runInAction(() => (this.running = false));
      });
    this.message = '';
  }

  private pushLog(message: Omit<Message, 'id'>) {
    this.log.push({
      ...message,
      id: nanoid(),
    });
  }

  cancel() {
    this.abortController?.abort();
    this.abortController = undefined;
  }
}
