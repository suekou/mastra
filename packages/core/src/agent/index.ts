import { randomUUID } from 'crypto';
import type {
  AssistantContent,
  CoreAssistantMessage,
  CoreMessage,
  CoreToolMessage,
  CoreUserMessage,
  GenerateObjectResult,
  GenerateTextResult,
  LanguageModelV1,
  StreamObjectResult,
  StreamTextResult,
  TextPart,
  ToolCallPart,
  UserContent,
} from 'ai';
import type { JSONSchema7 } from 'json-schema';
import type { ZodSchema, z } from 'zod';

import type { MastraPrimitives, MastraUnion } from '../action';
import { MastraBase } from '../base';
import type { Metric } from '../eval';
import { AvailableHooks, executeHook } from '../hooks';
import type { GenerateReturn, StreamReturn } from '../llm';
import type { MastraLLMBase } from '../llm/model';
import { MastraLLM } from '../llm/model';
import { RegisteredLogger } from '../logger';
import type { Mastra } from '../mastra';
import type { MastraMemory } from '../memory/memory';
import type { MemoryConfig, StorageThreadType } from '../memory/types';
import { InstrumentClass } from '../telemetry';
import type { CoreTool } from '../tools/types';
import { makeCoreTool, createMastraProxy, ensureToolProperties } from '../utils';
import type { CompositeVoice } from '../voice';

import type {
  AgentConfig,
  AgentGenerateOptions,
  AgentStreamOptions,
  AiMessageType,
  MastraLanguageModel,
  ToolsetsInput,
  ToolsInput,
} from './types';

export * from './types';

@InstrumentClass({
  prefix: 'agent',
  excludeMethods: ['__setTools', '__setLogger', '__setTelemetry', 'log'],
})
export class Agent<
  TTools extends ToolsInput = ToolsInput,
  TMetrics extends Record<string, Metric> = Record<string, Metric>,
> extends MastraBase {
  public name: string;
  readonly llm: MastraLLMBase;
  instructions: string;
  readonly model?: MastraLanguageModel;
  #mastra?: Mastra;
  #memory?: MastraMemory;
  tools: TTools;
  /** @deprecated This property is deprecated. Use evals instead. */
  metrics: TMetrics;
  evals: TMetrics;
  voice?: CompositeVoice;

  constructor(config: AgentConfig<TTools, TMetrics>) {
    super({ component: RegisteredLogger.AGENT });

    this.name = config.name;
    this.instructions = config.instructions;

    if (!config.model) {
      throw new Error(`LanguageModel is required to create an Agent. Please provide the 'model'.`);
    }

    this.llm = new MastraLLM({ model: config.model, mastra: config.mastra });

    this.tools = {} as TTools;

    this.metrics = {} as TMetrics;
    this.evals = {} as TMetrics;

    if (config.tools) {
      this.tools = ensureToolProperties(config.tools) as TTools;
    }

    if (config.mastra) {
      this.__registerMastra(config.mastra);
      this.__registerPrimitives({
        telemetry: config.mastra.getTelemetry(),
        logger: config.mastra.getLogger(),
      });
    }

    if (config.metrics) {
      this.logger.warn('The metrics property is deprecated. Please use evals instead to add evaluation metrics.');
      this.metrics = config.metrics;
      this.evals = config.metrics;
    }

    if (config.evals) {
      this.evals = config.evals;
    }

    if (config.memory) {
      this.#memory = config.memory;
    }

    if (config.voice) {
      this.voice = config.voice;
      this.voice?.addTools(this.tools);
      this.voice?.updateConfig({ instructions: config.instructions });
    }
  }

  public hasOwnMemory(): boolean {
    return Boolean(this.#memory);
  }
  public getMemory(): MastraMemory | undefined {
    return this.#memory ?? this.#mastra?.memory;
  }

  __updateInstructions(newInstructions: string) {
    this.instructions = newInstructions;
    this.logger.debug(`[Agents:${this.name}] Instructions updated.`, { model: this.model, name: this.name });
  }

  __registerPrimitives(p: MastraPrimitives) {
    if (p.telemetry) {
      this.__setTelemetry(p.telemetry);
    }

    if (p.logger) {
      this.__setLogger(p.logger);
    }

    this.llm.__registerPrimitives(p);

    this.logger.debug(`[Agents:${this.name}] initialized.`, { model: this.model, name: this.name });
  }

  __registerMastra(mastra: Mastra) {
    this.#mastra = mastra;
    this.llm.__registerMastra(mastra);
  }

  /**
   * Set the concrete tools for the agent
   * @param tools
   */
  __setTools(tools: TTools) {
    this.tools = tools;
    this.logger.debug(`[Agents:${this.name}] Tools set for agent ${this.name}`, { model: this.model, name: this.name });
  }

  async generateTitleFromUserMessage({ message }: { message: CoreUserMessage }) {
    // need to use text, not object output or it will error for models that don't support structured output (eg Deepseek R1)
    const { text } = await this.llm.__text<{ title: string }>({
      messages: [
        {
          role: 'system',
          content: `\n
      - you will generate a short title based on the first message a user begins a conversation with
      - ensure it is not more than 80 characters long
      - the title should be a summary of the user's message
      - do not use quotes or colons
      - the entire text you return will be used as the title`,
        },
        {
          role: 'user',
          content: JSON.stringify(message),
        },
      ],
    });

    // Strip out any r1 think tags if present
    const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return cleanedText;
  }

  getMostRecentUserMessage(messages: Array<CoreMessage>) {
    const userMessages = messages.filter(message => message.role === 'user');
    return userMessages.at(-1);
  }

  async genTitle(userMessage: CoreUserMessage | undefined) {
    let title = `New Thread ${new Date().toISOString()}`;
    try {
      if (userMessage) {
        title = await this.generateTitleFromUserMessage({
          message: userMessage,
        });
      }
    } catch (e) {
      console.error('Error generating title:', e);
    }
    return title;
  }

  async fetchMemory({
    threadId,
    memoryConfig,
    resourceId,
    userMessages,
    runId,
  }: {
    resourceId: string;
    threadId: string;
    memoryConfig?: MemoryConfig;
    userMessages: CoreMessage[];
    time?: Date;
    keyword?: string;
    runId?: string;
  }) {
    const memory = this.getMemory();
    if (memory) {
      const thread = await memory.getThreadById({ threadId });
      if (!thread) {
        return { threadId: threadId || '', messages: userMessages };
      }

      const userMessage = this.getMostRecentUserMessage(userMessages);
      const newMessages = userMessage ? [userMessage] : userMessages;

      const messages = newMessages.map(u => {
        return {
          id: this.getMemory()?.generateId()!,
          createdAt: new Date(),
          threadId: threadId,
          ...u,
          content: u.content as UserContent | AssistantContent,
          role: u.role as 'user' | 'assistant',
          type: 'text' as 'text' | 'tool-call' | 'tool-result',
        };
      });

      const [memoryMessages, memorySystemMessage] =
        threadId && memory
          ? await Promise.all([
              memory
                .rememberMessages({
                  threadId,
                  resourceId,
                  config: memoryConfig,
                  vectorMessageSearch: messages
                    .slice(-1)
                    .map(m => {
                      if (typeof m === `string`) {
                        return m;
                      }
                      return m?.content || ``;
                    })
                    .join(`\n`),
                })
                .then(r => r.messages),
              memory.getSystemMessage({ threadId, memoryConfig }),
            ])
          : [[], null];

      this.logger.debug('Saved messages to memory', {
        threadId,
        runId,
      });

      return {
        threadId: thread.id,
        messages: [
          memorySystemMessage
            ? {
                role: 'system' as const,
                content: memorySystemMessage,
              }
            : null,
          ...this.sanitizeResponseMessages(memoryMessages),
          ...newMessages,
        ].filter((message): message is NonNullable<typeof message> => Boolean(message)),
      };
    }

    return { threadId: threadId || '', messages: userMessages };
  }

  async saveResponse({
    result,
    threadId,
    resourceId,
    runId,
    memoryConfig,
  }: {
    runId: string;
    resourceId: string;
    result: Record<string, any>;
    threadId: string;
    memoryConfig: MemoryConfig | undefined;
  }) {
    const { response } = result;
    try {
      if (response.messages) {
        const ms = Array.isArray(response.messages) ? response.messages : [response.messages];

        const responseMessagesWithoutIncompleteToolCalls = this.sanitizeResponseMessages(ms);

        const memory = this.getMemory();

        if (memory) {
          this.logger.debug(
            `[Agent:${this.name}] - Memory persistence: store=${this.getMemory()?.constructor.name} threadId=${threadId}`,
            {
              runId,
              resourceId,
              threadId,
              memoryStore: this.getMemory()?.constructor.name,
            },
          );

          await memory.saveMessages({
            memoryConfig,
            messages: responseMessagesWithoutIncompleteToolCalls.map(
              (message: CoreMessage | CoreAssistantMessage, index) => {
                const messageId = randomUUID();
                let toolCallIds: string[] | undefined;
                let toolCallArgs: Record<string, unknown>[] | undefined;
                let toolNames: string[] | undefined;
                let type: 'text' | 'tool-call' | 'tool-result' = 'text';

                if (message.role === 'tool') {
                  toolCallIds = (message as CoreToolMessage).content.map(content => content.toolCallId);
                  type = 'tool-result';
                }
                if (message.role === 'assistant') {
                  const assistantContent = (message as CoreAssistantMessage).content as Array<TextPart | ToolCallPart>;

                  const assistantToolCalls = assistantContent
                    .map(content => {
                      if (content.type === 'tool-call') {
                        return {
                          toolCallId: content.toolCallId,
                          toolArgs: content.args,
                          toolName: content.toolName,
                        };
                      }
                      return undefined;
                    })
                    ?.filter(Boolean) as Array<{
                    toolCallId: string;
                    toolArgs: Record<string, unknown>;
                    toolName: string;
                  }>;

                  toolCallIds = assistantToolCalls?.map(toolCall => toolCall.toolCallId);

                  toolCallArgs = assistantToolCalls?.map(toolCall => toolCall.toolArgs);
                  toolNames = assistantToolCalls?.map(toolCall => toolCall.toolName);
                  type = assistantContent?.[0]?.type as 'text' | 'tool-call' | 'tool-result';
                }

                return {
                  id: messageId,
                  threadId: threadId,
                  role: message.role as any,
                  content: message.content as any,
                  createdAt: new Date(Date.now() + index), // use Date.now() + index to make sure every message is atleast one millisecond apart
                  toolCallIds: toolCallIds?.length ? toolCallIds : undefined,
                  toolCallArgs: toolCallArgs?.length ? toolCallArgs : undefined,
                  toolNames: toolNames?.length ? toolNames : undefined,
                  type,
                };
              },
            ),
          });
        }
      }
    } catch (err) {
      this.logger.error(`[Agent:${this.name}] - Failed to save assistant response`, {
        error: err,
        runId: runId,
      });
    }
  }

  sanitizeResponseMessages(messages: Array<CoreMessage>): Array<CoreMessage> {
    let toolResultIds: Array<string> = [];
    let toolCallIds: Array<string> = [];

    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;

      if (message.role === 'tool') {
        for (const content of message.content) {
          if (content.type === 'tool-result') {
            toolResultIds.push(content.toolCallId);
          }
        }
      } else if (message.role === 'assistant' || message.role === 'user') {
        for (const content of message.content) {
          if (typeof content !== `string`) {
            if (content.type === `tool-call`) {
              toolCallIds.push(content.toolCallId);
            }
          }
        }
      }
    }

    const messagesBySanitizedContent = messages.map(message => {
      if (message.role !== 'assistant' && message.role !== `tool` && message.role !== `user`) return message;

      if (!message.content || typeof message.content === 'string' || typeof message.content === 'number') {
        return message;
      }

      const sanitizedContent = message.content.filter(content => {
        if (content.type === `tool-call`) {
          return toolResultIds.includes(content.toolCallId);
        }
        if (content.type === `text`) {
          return content.text.trim() !== ``;
        }
        if (content.type === `tool-result`) {
          return toolCallIds.includes(content.toolCallId);
        }
        return true;
      });

      return {
        ...message,
        content: sanitizedContent,
      };
    });

    return messagesBySanitizedContent.filter(message => {
      if (typeof message.content === `string`) {
        return message.content !== '';
      }

      if (Array.isArray(message.content)) {
        return (
          message.content.length &&
          message.content.every(c => {
            if (c.type === `text`) {
              return c.text && c.text !== '';
            }
            return true;
          })
        );
      }

      return true;
    }) as Array<CoreMessage>;
  }

  convertTools({
    toolsets,
    threadId,
    resourceId,
    runId,
  }: {
    toolsets?: ToolsetsInput;
    threadId?: string;
    resourceId?: string;
    runId?: string;
  }): Record<string, CoreTool> {
    this.logger.debug(`[Agents:${this.name}] - Assigning tools`, { runId, threadId, resourceId });

    // Get memory tools if available
    const memory = this.getMemory();
    const memoryTools = memory?.getTools?.();

    let mastraProxy = undefined;
    const logger = this.logger;
    if (this.#mastra) {
      mastraProxy = createMastraProxy({ mastra: this.#mastra, logger });
    }

    const converted = Object.entries(this.tools || {}).reduce(
      (memo, value) => {
        const k = value[0];
        const tool = this.tools[k];

        if (tool) {
          const options = {
            name: k,
            runId,
            threadId,
            resourceId,
            logger: this.logger,
            mastra: mastraProxy as MastraUnion | undefined,
            memory,
            agentName: this.name,
          };
          memo[k] = makeCoreTool(tool, options);
        }
        return memo;
      },
      {} as Record<string, CoreTool>,
    );

    // Convert memory tools with proper context
    const convertedMemoryTools = memoryTools
      ? Object.entries(memoryTools).reduce(
          (memo, [k, tool]) => {
            memo[k] = {
              description: tool.description,
              parameters: tool.parameters,
              execute:
                typeof tool?.execute === 'function'
                  ? async (args, options) => {
                      try {
                        this.logger.debug(`[Agent:${this.name}] - Executing memory tool ${k}`, {
                          name: k,
                          description: tool.description,
                          args,
                          runId,
                          threadId,
                          resourceId,
                        });
                        return (
                          tool?.execute?.(
                            {
                              context: args,
                              mastra: mastraProxy as MastraUnion | undefined,
                              memory,
                              runId,
                              threadId,
                              resourceId,
                            },
                            options,
                          ) ?? undefined
                        );
                      } catch (err) {
                        this.logger.error(`[Agent:${this.name}] - Failed memory tool execution`, {
                          error: err,
                          runId,
                          threadId,
                          resourceId,
                        });
                        throw err;
                      }
                    }
                  : undefined,
            };
            return memo;
          },
          {} as Record<string, CoreTool>,
        )
      : {};

    const toolsFromToolsetsConverted: Record<string, CoreTool> = {
      ...converted,
      ...convertedMemoryTools,
    };

    const toolsFromToolsets = Object.values(toolsets || {});

    if (toolsFromToolsets.length > 0) {
      this.logger.debug(`[Agent:${this.name}] - Adding tools from toolsets ${Object.keys(toolsets || {}).join(', ')}`, {
        runId,
      });
      toolsFromToolsets.forEach(toolset => {
        Object.entries(toolset).forEach(([toolName, tool]) => {
          const toolObj = tool;
          const options = {
            name: toolName,
            runId,
            threadId,
            resourceId,
            logger: this.logger,
            agentName: this.name,
          };
          toolsFromToolsetsConverted[toolName] = makeCoreTool(toolObj, options, 'toolset');
        });
      });
    }

    return toolsFromToolsetsConverted;
  }

  async preExecute({
    resourceId,
    runId,
    threadId,
    memoryConfig,
    messages,
  }: {
    runId?: string;
    threadId: string;
    memoryConfig?: MemoryConfig;
    messages: CoreMessage[];
    resourceId: string;
  }) {
    let coreMessages: CoreMessage[] = [];
    let threadIdToUse = threadId;

    this.logger.debug(`Saving user messages in memory for agent ${this.name}`, { runId });
    const saveMessageResponse = await this.fetchMemory({
      threadId,
      resourceId,
      userMessages: messages,
      memoryConfig,
    });

    coreMessages = saveMessageResponse.messages;
    threadIdToUse = saveMessageResponse.threadId;
    return { coreMessages, threadIdToUse };
  }

  __primitive({
    instructions,
    messages,
    context,
    threadId,
    memoryConfig,
    resourceId,
    runId,
    toolsets,
  }: {
    instructions?: string;
    toolsets?: ToolsetsInput;
    resourceId?: string;
    threadId?: string;
    memoryConfig?: MemoryConfig;
    context?: CoreMessage[];
    runId?: string;
    messages: CoreMessage[];
  }) {
    return {
      before: async () => {
        if (process.env.NODE_ENV !== 'test') {
          this.logger.debug(`[Agents:${this.name}] - Starting generation`, { runId });
        }

        const systemMessage: CoreMessage = {
          role: 'system',
          content: instructions || `${this.instructions}.`,
        };

        let coreMessages = messages;
        let threadIdToUse = threadId;

        const memory = this.getMemory();

        if (threadId && memory && !resourceId) {
          throw new Error(
            `A resourceId must be provided when passing a threadId and using Memory. Saw threadId ${threadId} but resourceId is ${resourceId}`,
          );
        }

        if (memory && resourceId) {
          this.logger.debug(
            `[Agent:${this.name}] - Memory persistence enabled: store=${this.getMemory()?.constructor.name}, resourceId=${resourceId}`,
            {
              runId,
              resourceId,
              threadId: threadIdToUse,
              memoryStore: this.getMemory()?.constructor.name,
            },
          );

          let thread = threadIdToUse ? await memory.getThreadById({ threadId: threadIdToUse }) : undefined;
          if (!thread) {
            thread = await memory.createThread({
              threadId: threadIdToUse,
              resourceId,
              memoryConfig,
            });
          }
          threadIdToUse = thread.id;

          const preExecuteResult = await this.preExecute({
            resourceId,
            runId,
            threadId: threadIdToUse,
            memoryConfig,
            messages,
          });

          coreMessages = preExecuteResult.coreMessages;
          threadIdToUse = preExecuteResult.threadIdToUse;
        }

        let convertedTools: Record<string, CoreTool> | undefined;

        if ((toolsets && Object.keys(toolsets || {}).length > 0) || (this.getMemory() && resourceId)) {
          const reasons = [];
          if (toolsets && Object.keys(toolsets || {}).length > 0) {
            reasons.push(`toolsets present (${Object.keys(toolsets || {}).length} tools)`);
          }
          if (this.getMemory() && resourceId) {
            reasons.push('memory and resourceId available');
          }

          this.logger.debug(`[Agent:${this.name}] - Enhancing tools: ${reasons.join(', ')}`, {
            runId,
            toolsets: toolsets ? Object.keys(toolsets) : undefined,
            hasMemory: !!this.getMemory(),
            hasResourceId: !!resourceId,
          });
          convertedTools = this.convertTools({
            toolsets,
            threadId: threadIdToUse,
            resourceId,
            runId,
          });
        }

        const messageObjects = [systemMessage, ...(context || []), ...coreMessages];

        return { messageObjects, convertedTools, threadId: threadIdToUse as string };
      },
      after: async ({
        result,
        threadId,
        memoryConfig,
        outputText,
        runId,
      }: {
        runId: string;
        result: Record<string, any>;
        threadId: string;
        memoryConfig: MemoryConfig | undefined;
        outputText: string;
      }) => {
        const resToLog = {
          text: result?.text,
          object: result?.object,
          toolResults: result?.toolResults,
          toolCalls: result?.toolCalls,
          usage: result?.usage,
          steps: result?.steps?.map((s: any) => {
            return {
              stepType: s?.stepType,
              text: result?.text,
              object: result?.object,
              toolResults: result?.toolResults,
              toolCalls: result?.toolCalls,
              usage: result?.usage,
            };
          }),
        };
        this.logger.debug(`[Agent:${this.name}] - Post processing LLM response`, {
          runId,
          result: resToLog,
          threadId,
        });
        const memory = this.getMemory();
        const thread = threadId ? await memory?.getThreadById({ threadId }) : undefined;
        if (memory && resourceId && thread) {
          try {
            const userMessage = this.getMostRecentUserMessage(messages);
            const newMessages = userMessage ? [userMessage] : messages;
            const threadMessages = newMessages.map(u => {
              return {
                id: this.getMemory()?.generateId()!,
                createdAt: new Date(),
                threadId: thread.id,
                ...u,
                content: u.content as UserContent | AssistantContent,
                role: u.role as 'user' | 'assistant',
                type: 'text' as 'text' | 'tool-call' | 'tool-result',
              };
            });

            await Promise.all([
              (async () => {
                await memory.saveMessages({ messages: threadMessages, memoryConfig });
                await this.saveResponse({
                  result,
                  threadId,
                  resourceId,
                  memoryConfig,
                  runId,
                });
              })(),
              (async () => {
                if (!thread.title?.startsWith('New Thread')) {
                  return;
                }

                const config = memory.getMergedThreadConfig(memoryConfig);
                const title = config?.threads?.generateTitle ? await this.genTitle(userMessage) : undefined;
                if (!title) {
                  return;
                }

                return memory.createThread({
                  threadId: thread.id,
                  resourceId,
                  memoryConfig,
                  title,
                });
              })(),
            ]);
          } catch (e) {
            this.logger.error('Error saving response', {
              error: e,
              runId,
              result: resToLog,
              threadId,
            });
          }
        }

        if (Object.keys(this.evals || {}).length > 0) {
          const input = messages.map(message => message.content).join('\n');
          const runIdToUse = runId || crypto.randomUUID();
          for (const metric of Object.values(this.evals || {})) {
            executeHook(AvailableHooks.ON_GENERATION, {
              input,
              output: outputText,
              runId: runIdToUse,
              metric,
              agentName: this.name,
              instructions: instructions || this.instructions,
            });
          }
        }
      },
    };
  }

  async generate<Z extends ZodSchema | JSONSchema7 | undefined = undefined>(
    messages: string | string[] | CoreMessage[] | AiMessageType[],
    args?: AgentGenerateOptions<Z> & { output?: never; experimental_output?: never },
  ): Promise<GenerateTextResult<any, Z extends ZodSchema ? z.infer<Z> : unknown>>;
  async generate<Z extends ZodSchema | JSONSchema7 | undefined = undefined>(
    messages: string | string[] | CoreMessage[] | AiMessageType[],
    args?: AgentGenerateOptions<Z> &
      ({ output: Z; experimental_output?: never } | { experimental_output: Z; output?: never }),
  ): Promise<GenerateObjectResult<Z extends ZodSchema ? z.infer<Z> : unknown>>;
  async generate<Z extends ZodSchema | JSONSchema7 | undefined = undefined>(
    messages: string | string[] | CoreMessage[] | AiMessageType[],
    {
      instructions,
      context,
      threadId: threadIdInFn,
      memoryOptions,
      resourceId,
      maxSteps = 5,
      onStepFinish,
      runId,
      output,
      toolsets,
      temperature,
      toolChoice = 'auto',
      experimental_output,
      telemetry,
      ...rest
    }: AgentGenerateOptions<Z> = {},
  ): Promise<
    | GenerateTextResult<any, Z extends ZodSchema ? z.infer<Z> : unknown>
    | GenerateObjectResult<Z extends ZodSchema ? z.infer<Z> : unknown>
  > {
    let messagesToUse: CoreMessage[] = [];

    if (typeof messages === `string`) {
      messagesToUse = [
        {
          role: 'user',
          content: messages,
        },
      ];
    } else if (Array.isArray(messages)) {
      messagesToUse = messages.map(message => {
        if (typeof message === `string`) {
          return {
            role: 'user',
            content: message,
          };
        }
        return message as CoreMessage;
      });
    } else {
      messagesToUse = [messages];
    }

    const runIdToUse = runId || randomUUID();

    const { before, after } = this.__primitive({
      instructions,
      messages: messagesToUse,
      context,
      threadId: threadIdInFn,
      memoryConfig: memoryOptions,
      resourceId,
      runId: runIdToUse,
      toolsets,
    });

    const { threadId, messageObjects, convertedTools } = await before();

    if (!output && experimental_output) {
      const result = await this.llm.__text({
        messages: messageObjects,
        tools: this.tools,
        convertedTools,
        onStepFinish,
        maxSteps: maxSteps || 5,
        runId: runIdToUse,
        temperature,
        toolChoice: toolChoice || 'auto',
        experimental_output,
        threadId,
        resourceId,
        memory: this.getMemory(),
        ...rest,
      });

      const outputText = result.text;

      await after({ result, threadId, memoryConfig: memoryOptions, outputText, runId: runIdToUse });

      const newResult = result as any;

      newResult.object = result.experimental_output;

      return newResult as unknown as GenerateReturn<Z>;
    }

    if (!output) {
      const result = await this.llm.__text({
        messages: messageObjects,
        tools: this.tools,
        convertedTools,
        onStepFinish,
        maxSteps,
        runId: runIdToUse,
        temperature,
        toolChoice,
        telemetry,
        threadId,
        resourceId,
        memory: this.getMemory(),
        ...rest,
      });

      const outputText = result.text;

      await after({ result, threadId, memoryConfig: memoryOptions, outputText, runId: runIdToUse });

      return result as unknown as GenerateReturn<Z>;
    }

    const result = await this.llm.__textObject({
      messages: messageObjects,
      tools: this.tools,
      structuredOutput: output,
      convertedTools,
      onStepFinish,
      maxSteps,
      runId: runIdToUse,
      temperature,
      toolChoice,
      telemetry,
      memory: this.getMemory(),
      ...rest,
    });

    const outputText = JSON.stringify(result.object);

    await after({ result, threadId, memoryConfig: memoryOptions, outputText, runId: runIdToUse });

    return result as unknown as GenerateReturn<Z>;
  }

  async stream<Z extends ZodSchema | JSONSchema7 | undefined = undefined>(
    messages: string | string[] | CoreMessage[] | AiMessageType[],
    args?: AgentStreamOptions<Z> & { output?: never; experimental_output?: never },
  ): Promise<StreamTextResult<any, Z extends ZodSchema ? z.infer<Z> : unknown>>;
  async stream<Z extends ZodSchema | JSONSchema7 | undefined = undefined>(
    messages: string | string[] | CoreMessage[] | AiMessageType[],
    args?: AgentStreamOptions<Z> &
      ({ output: Z; experimental_output?: never } | { experimental_output: Z; output?: never }),
  ): Promise<StreamObjectResult<any, Z extends ZodSchema ? z.infer<Z> : unknown, any>>;
  async stream<Z extends ZodSchema | JSONSchema7 | undefined = undefined>(
    messages: string | string[] | CoreMessage[] | AiMessageType[],
    {
      instructions,
      context,
      threadId: threadIdInFn,
      memoryOptions,
      resourceId,
      maxSteps = 5,
      onFinish,
      onStepFinish,
      runId,
      toolsets,
      output,
      temperature,
      toolChoice = 'auto',
      experimental_output,
      telemetry,
      ...rest
    }: AgentStreamOptions<Z> = {},
  ): Promise<
    | StreamTextResult<any, Z extends ZodSchema ? z.infer<Z> : unknown>
    | StreamObjectResult<any, Z extends ZodSchema ? z.infer<Z> : unknown, any>
  > {
    const runIdToUse = runId || randomUUID();

    let messagesToUse: CoreMessage[] = [];

    if (typeof messages === `string`) {
      messagesToUse = [
        {
          role: 'user',
          content: messages,
        },
      ];
    } else {
      messagesToUse = messages.map(message => {
        if (typeof message === `string`) {
          return {
            role: 'user',
            content: message,
          };
        }
        return message as CoreMessage;
      });
    }

    const { before, after } = this.__primitive({
      instructions,
      messages: messagesToUse,
      context,
      threadId: threadIdInFn,
      memoryConfig: memoryOptions,
      resourceId,
      runId: runIdToUse,
      toolsets,
    });

    const { threadId, messageObjects, convertedTools } = await before();

    if (!output && experimental_output) {
      this.logger.debug(`Starting agent ${this.name} llm stream call`, {
        runId,
      });

      const streamResult = await this.llm.__stream({
        messages: messageObjects,
        temperature,
        tools: this.tools,
        convertedTools,
        onStepFinish,
        onFinish: async (result: string) => {
          try {
            const res = JSON.parse(result) || {};
            const outputText = res.text;
            await after({ result: res, threadId, memoryConfig: memoryOptions, outputText, runId: runIdToUse });
          } catch (e) {
            this.logger.error('Error saving memory on finish', {
              error: e,
              runId,
            });
          }
          onFinish?.(result);
        },
        maxSteps,
        runId: runIdToUse,
        toolChoice,
        experimental_output,
        memory: this.getMemory(),
        ...rest,
      });

      const newStreamResult = streamResult as any;
      newStreamResult.partialObjectStream = streamResult.experimental_partialOutputStream;
      return newStreamResult as unknown as StreamReturn<Z>;
    } else if (!output) {
      this.logger.debug(`Starting agent ${this.name} llm stream call`, {
        runId,
      });
      return this.llm.__stream({
        messages: messageObjects,
        temperature,
        tools: this.tools,
        convertedTools,
        onStepFinish,
        onFinish: async (result: string) => {
          try {
            const res = JSON.parse(result) || {};
            const outputText = res.text;
            await after({ result: res, threadId, memoryConfig: memoryOptions, outputText, runId: runIdToUse });
          } catch (e) {
            this.logger.error('Error saving memory on finish', {
              error: e,
              runId,
            });
          }
          onFinish?.(result);
        },
        maxSteps,
        runId: runIdToUse,
        toolChoice,
        telemetry,
        memory: this.getMemory(),
        ...rest,
      }) as unknown as StreamReturn<Z>;
    }

    this.logger.debug(`Starting agent ${this.name} llm streamObject call`, {
      runId,
    });

    return this.llm.__streamObject({
      messages: messageObjects,
      tools: this.tools,
      temperature,
      structuredOutput: output,
      convertedTools,
      onStepFinish,
      onFinish: async (result: string) => {
        try {
          const res = JSON.parse(result) || {};
          const outputText = JSON.stringify(res.object);
          await after({ result: res, threadId, memoryConfig: memoryOptions, outputText, runId: runIdToUse });
        } catch (e) {
          this.logger.error('Error saving memory on finish', {
            error: e,
            runId,
          });
        }
        onFinish?.(result);
      },
      runId: runIdToUse,
      toolChoice,
      telemetry,
      memory: this.getMemory(),
      ...rest,
    }) as unknown as StreamReturn<Z>;
  }

  /**
   * Convert text to speech using the configured voice provider
   * @param input Text or text stream to convert to speech
   * @param options Speech options including speaker and provider-specific options
   * @returns Audio stream
   * @deprecated Use agent.voice.speak() instead
   */
  async speak(
    input: string | NodeJS.ReadableStream,
    options?: {
      speaker?: string;
      [key: string]: any;
    },
  ): Promise<NodeJS.ReadableStream | void> {
    if (!this.voice) {
      throw new Error('No voice provider configured');
    }

    this.logger.warn('Warning: agent.speak() is deprecated. Please use agent.voice.speak() instead.');

    try {
      return this.voice.speak(input, options);
    } catch (e) {
      this.logger.error('Error during agent speak', {
        error: e,
      });
      throw e;
    }
  }

  /**
   * Convert speech to text using the configured voice provider
   * @param audioStream Audio stream to transcribe
   * @param options Provider-specific transcription options
   * @returns Text or text stream
   * @deprecated Use agent.voice.listen() instead
   */
  async listen(
    audioStream: NodeJS.ReadableStream,
    options?: {
      [key: string]: any;
    },
  ): Promise<string | NodeJS.ReadableStream | void> {
    if (!this.voice) {
      throw new Error('No voice provider configured');
    }

    this.logger.warn('Warning: agent.listen() is deprecated. Please use agent.voice.listen() instead');

    try {
      return this.voice.listen(audioStream, options);
    } catch (e) {
      this.logger.error('Error during agent listen', {
        error: e,
      });
      throw e;
    }
  }

  /**
   * Get a list of available speakers from the configured voice provider
   * @throws {Error} If no voice provider is configured
   * @returns {Promise<Array<{voiceId: string}>>} List of available speakers
   * @deprecated Use agent.voice.getSpeakers() instead
   */
  async getSpeakers() {
    if (!this.voice) {
      throw new Error('No voice provider configured');
    }

    this.logger.warn('Warning: agent.getSpeakers() is deprecated. Please use agent.voice.getSpeakers() instead.');

    try {
      return await this.voice.getSpeakers();
    } catch (e) {
      this.logger.error('Error during agent getSpeakers', {
        error: e,
      });
      throw e;
    }
  }
}
