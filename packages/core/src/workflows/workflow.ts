import type { Span } from '@opentelemetry/api';
import { context as otlpContext, trace } from '@opentelemetry/api';
import type { z } from 'zod';

import type { MastraPrimitives } from '../action';
import { MastraBase } from '../base';

import type { Mastra } from '../mastra';
import { Step } from './step';
import type {
  ActionContext,
  RetryConfig,
  StepAction,
  StepConfig,
  StepDef,
  StepGraph,
  StepNode,
  StepVariableType,
  WorkflowOptions,
  WorkflowRunState,
} from './types';
import { WhenConditionReturnValue } from './types';
import { isVariableReference } from './utils';
import type { WorkflowResultReturn } from './workflow-instance';
import { WorkflowInstance } from './workflow-instance';

export class Workflow<
  TSteps extends Step<string, any, any>[] = Step<string, any, any>[],
  TTriggerSchema extends z.ZodObject<any> = any,
> extends MastraBase {
  name: string;
  triggerSchema?: TTriggerSchema;
  events?: Record<string, { schema: z.ZodObject<any> }>;
  #retryConfig?: RetryConfig;
  #mastra?: Mastra;
  #runs: Map<string, WorkflowInstance<TSteps, TTriggerSchema>> = new Map();
  #onStepTransition: Set<(state: WorkflowRunState) => void | Promise<void>> = new Set();
  // registers stepIds on `after` calls
  #afterStepStack: string[] = [];
  #lastStepStack: string[] = [];
  #ifStack: {
    condition: StepConfig<any, any, any, TTriggerSchema>['when'];
    elseStepKey: string;
    condStep: StepAction<any, any, any, any>;
  }[] = [];
  #stepGraph: StepGraph = { initial: [] };
  #serializedStepGraph: StepGraph = { initial: [] };
  #stepSubscriberGraph: Record<string, StepGraph> = {};
  #serializedStepSubscriberGraph: Record<string, StepGraph> = {};
  #steps: Record<string, StepAction<any, any, any, any>> = {};

  /**
   * Creates a new Workflow instance
   * @param name - Identifier for the workflow (not necessarily unique)
   * @param logger - Optional logger instance
   */
  constructor({ name, triggerSchema, retryConfig, mastra, events }: WorkflowOptions<TTriggerSchema>) {
    super({ component: 'WORKFLOW', name });

    this.name = name;
    this.#retryConfig = retryConfig;
    this.triggerSchema = triggerSchema;
    this.events = events;

    if (mastra) {
      this.__registerPrimitives({
        telemetry: mastra.getTelemetry(),
        logger: mastra.getLogger(),
      });
      this.#mastra = mastra;
    }
  }

  step<
    TStep extends StepAction<any, any, any, any>,
    CondStep extends StepVariableType<any, any, any, any>,
    VarStep extends StepVariableType<any, any, any, any>,
  >(step: TStep, config?: StepConfig<TStep, CondStep, VarStep, TTriggerSchema>) {
    const { variables = {} } = config || {};

    const requiredData: Record<string, any> = {};

    // Add valid variables to requiredData
    for (const [key, variable] of Object.entries(variables)) {
      if (variable && isVariableReference(variable)) {
        requiredData[key] = variable;
      }
    }

    const stepKey = this.#makeStepKey(step);
    const when = config?.['#internal']?.when || config?.when;

    const graphEntry: StepNode = {
      step,
      config: {
        ...this.#makeStepDef(stepKey),
        ...config,
        loopLabel: config?.['#internal']?.loopLabel,
        loopType: config?.['#internal']?.loopType,
        serializedWhen: typeof when === 'function' ? when.toString() : when,
        data: requiredData,
      },
    };

    this.#steps[stepKey] = step;

    const parentStepKey = this.#afterStepStack[this.#afterStepStack.length - 1];
    const stepGraph = this.#stepSubscriberGraph[parentStepKey || ''];
    const serializedStepGraph = this.#serializedStepSubscriberGraph[parentStepKey || ''];

    // if we are in an after chain and we have a stepGraph
    if (parentStepKey && stepGraph) {
      // if the stepGraph has an initial, but it doesn't contain the current step, add it to the initial
      if (!stepGraph.initial.some(step => step.step.id === stepKey)) {
        stepGraph.initial.push(graphEntry);
        if (serializedStepGraph) serializedStepGraph.initial.push(graphEntry);
      }
      // add the current step to the stepGraph
      stepGraph[stepKey] = [];
      if (serializedStepGraph) serializedStepGraph[stepKey] = [];
    } else {
      // Normal step addition to main graph
      if (!this.#stepGraph[stepKey]) this.#stepGraph[stepKey] = [];
      this.#stepGraph.initial.push(graphEntry);
      this.#serializedStepGraph.initial.push(graphEntry);
    }
    this.#lastStepStack.push(stepKey);

    return this;
  }

  #makeStepKey(step: Step<any, any, any>) {
    // return `${step.id}${this.#delimiter}${Object.keys(this.steps2).length}`;
    return `${step.id}`;
  }

  then<
    TStep extends StepAction<any, any, any, any>,
    CondStep extends StepVariableType<any, any, any, any>,
    VarStep extends StepVariableType<any, any, any, any>,
  >(step: TStep, config?: StepConfig<TStep, CondStep, VarStep, TTriggerSchema>) {
    const { variables = {} } = config || {};

    const requiredData: Record<string, any> = {};

    // Add valid variables to requiredData
    for (const [key, variable] of Object.entries(variables)) {
      if (variable && isVariableReference(variable)) {
        requiredData[key] = variable;
      }
    }

    const lastStepKey = this.#lastStepStack[this.#lastStepStack.length - 1];
    const stepKey = this.#makeStepKey(step);
    const when = config?.['#internal']?.when || config?.when;

    const graphEntry: StepNode = {
      step,
      config: {
        ...this.#makeStepDef(stepKey),
        ...config,
        loopLabel: config?.['#internal']?.loopLabel,
        loopType: config?.['#internal']?.loopType,
        serializedWhen: typeof when === 'function' ? when.toString() : when,
        data: requiredData,
      },
    };

    this.#steps[stepKey] = step;
    // if then is called without a step, we are done
    if (!lastStepKey) return this;

    const parentStepKey = this.#afterStepStack[this.#afterStepStack.length - 1];
    const stepGraph = this.#stepSubscriberGraph[parentStepKey || ''];
    const serializedStepGraph = this.#serializedStepSubscriberGraph[parentStepKey || ''];

    if (parentStepKey && stepGraph && stepGraph[lastStepKey]) {
      stepGraph[lastStepKey].push(graphEntry);
      if (serializedStepGraph && serializedStepGraph[lastStepKey]) serializedStepGraph[lastStepKey].push(graphEntry);
    } else {
      // add the step to the graph if not already there.. it should be there though, unless magic
      if (!this.#stepGraph[lastStepKey]) this.#stepGraph[lastStepKey] = [];
      if (!this.#serializedStepGraph[lastStepKey]) this.#serializedStepGraph[lastStepKey] = [];

      // add the step to the graph
      this.#stepGraph[lastStepKey].push(graphEntry);
      this.#serializedStepGraph[lastStepKey].push(graphEntry);
    }

    return this;
  }

  private loop<
    FallbackStep extends StepAction<any, any, any, any>,
    CondStep extends StepVariableType<any, any, any, any>,
    VarStep extends StepVariableType<any, any, any, any>,
  >(
    applyOperator: (op: string, value: any, target: any) => { status: string },
    condition: StepConfig<FallbackStep, CondStep, VarStep, TTriggerSchema, TSteps>['when'],
    fallbackStep: FallbackStep,
    loopType?: 'while' | 'until',
  ) {
    const lastStepKey = this.#lastStepStack[this.#lastStepStack.length - 1];
    // If no last step, we can't do anything
    if (!lastStepKey) return this;

    const fallbackStepKey = this.#makeStepKey(fallbackStep);

    // Store the fallback step
    this.#steps[fallbackStepKey] = fallbackStep;

    // Create a check step that evaluates the condition
    const checkStepKey = `__${fallbackStepKey}_${loopType}_loop_check`;
    const checkStep = {
      id: checkStepKey,
      execute: async ({ context }: any) => {
        if (typeof condition === 'function') {
          const result = await condition({ context });
          if (loopType === 'while') {
            return { status: result ? 'continue' : 'complete' };
          } else {
            return { status: result ? 'complete' : 'continue' };
          }
        }

        // For query-based conditions, we need to:
        // 1. Get the actual value from the reference
        // 2. Compare it with the query
        if (condition && 'ref' in condition) {
          const { ref, query } = condition;
          // Handle both string IDs and step objects with IDs
          const stepId = typeof ref.step === 'string' ? ref.step : 'id' in ref.step ? ref.step.id : null;
          if (!stepId) {
            return { status: 'continue' }; // If we can't get the step ID, continue looping
          }

          const stepOutput = context.steps?.[stepId]?.output;
          if (!stepOutput) {
            return { status: 'continue' }; // If we can't find the value, continue looping
          }

          // Get the value at the specified path
          const value = ref.path.split('.').reduce((obj, key) => obj?.[key], stepOutput);

          // Compare the value with the query
          const operator = Object.keys(query)[0] as keyof typeof query;
          const target = query[operator];

          return applyOperator(operator as string, value, target);
        }

        return { status: 'continue' };
      },
    };
    this.#steps[checkStepKey] = checkStep;

    // Loop finished step
    const loopFinishedStepKey = `__${fallbackStepKey}_${loopType}_loop_finished`;
    const loopFinishedStep = {
      id: loopFinishedStepKey,
      execute: async ({ context }: any) => {
        return { success: true };
      },
    };
    this.#steps[checkStepKey] = checkStep;

    // First add the check step after the last step
    this.then(checkStep, {
      '#internal': {
        loopLabel: `${fallbackStepKey} ${loopType} loop check`,
      },
    });

    // Then create a branch after the check step that loops back to the fallback step
    this.after(checkStep)
      .step(fallbackStep, {
        when: async ({ context }) => {
          const checkStepResult = context.steps?.[checkStepKey];
          if (checkStepResult?.status !== 'success') {
            return WhenConditionReturnValue.ABORT;
          }

          const status = checkStepResult?.output?.status;
          return status === 'continue' ? WhenConditionReturnValue.CONTINUE : WhenConditionReturnValue.CONTINUE_FAILED;
        },
        '#internal': {
          //@ts-ignore
          when: condition,
          //@ts-ignore
          loopType,
        },
      })
      .then(checkStep, {
        '#internal': {
          loopLabel: `${fallbackStepKey} ${loopType} loop check`,
        },
      })
      .step(loopFinishedStep, {
        when: async ({ context }) => {
          const checkStepResult = context.steps?.[checkStepKey];
          if (checkStepResult?.status !== 'success') {
            return WhenConditionReturnValue.CONTINUE_FAILED;
          }

          const status = checkStepResult?.output?.status;
          return status === 'complete' ? WhenConditionReturnValue.CONTINUE : WhenConditionReturnValue.CONTINUE_FAILED;
        },
        '#internal': {
          loopLabel: `${fallbackStepKey} ${loopType} loop finished`,
          //@ts-ignore
          loopType,
        },
      });

    return this;
  }

  while<
    FallbackStep extends StepAction<any, any, any, any>,
    CondStep extends StepVariableType<any, any, any, any>,
    VarStep extends StepVariableType<any, any, any, any>,
  >(condition: StepConfig<FallbackStep, CondStep, VarStep, TTriggerSchema>['when'], fallbackStep: FallbackStep) {
    const applyOperator = (operator: string, value: any, target: any) => {
      switch (operator) {
        case '$eq':
          return { status: value !== target ? 'complete' : 'continue' };
        case '$ne':
          return { status: value === target ? 'complete' : 'continue' };
        case '$gt':
          return { status: value <= target ? 'complete' : 'continue' };
        case '$gte':
          return { status: value < target ? 'complete' : 'continue' };
        case '$lt':
          return { status: value >= target ? 'complete' : 'continue' };
        case '$lte':
          return { status: value > target ? 'complete' : 'continue' };
        default:
          return { status: 'continue' };
      }
    };

    return this.loop(applyOperator, condition, fallbackStep, 'while');
  }

  until<
    FallbackStep extends StepAction<any, any, any, any>,
    CondStep extends StepVariableType<any, any, any, any>,
    VarStep extends StepVariableType<any, any, any, any>,
  >(
    condition: StepConfig<FallbackStep, CondStep, VarStep, TTriggerSchema, TSteps>['when'],
    fallbackStep: FallbackStep,
  ) {
    const applyOperator = (operator: string, value: any, target: any) => {
      switch (operator) {
        case '$eq':
          return { status: value === target ? 'complete' : 'continue' };
        case '$ne':
          return { status: value !== target ? 'complete' : 'continue' };
        case '$gt':
          return { status: value > target ? 'complete' : 'continue' };
        case '$gte':
          return { status: value >= target ? 'complete' : 'continue' };
        case '$lt':
          return { status: value < target ? 'complete' : 'continue' };
        case '$lte':
          return { status: value <= target ? 'complete' : 'continue' };
        default:
          return { status: 'continue' };
      }
    };

    return this.loop(applyOperator, condition, fallbackStep, 'until');
  }

  if<TStep extends StepAction<any, any, any, any>>(condition: StepConfig<TStep, any, any, TTriggerSchema>['when']) {
    const lastStep = this.#steps[this.#lastStepStack[this.#lastStepStack.length - 1] ?? ''];
    if (!lastStep) {
      throw new Error('Condition requires a step to be executed after');
    }

    this.after(lastStep);

    const ifStepKey = `__${lastStep.id}_if`;
    this.step(
      {
        id: ifStepKey,
        execute: async ({ context }) => {
          return { executed: true };
        },
      },
      {
        when: condition,
      },
    );

    const elseStepKey = `__${lastStep.id}_else`;
    this.#ifStack.push({ condition, elseStepKey, condStep: lastStep });

    return this;
  }

  else() {
    const activeCondition = this.#ifStack.pop();
    if (!activeCondition) {
      throw new Error('No active condition found');
    }

    this.after(activeCondition.condStep).step(
      {
        id: activeCondition.elseStepKey,
        execute: async ({ context }) => {
          return { executed: true };
        },
      },
      {
        when:
          typeof activeCondition.condition === 'function'
            ? async payload => {
                // @ts-ignore
                const result = await activeCondition.condition(payload);
                return !result;
              }
            : { not: activeCondition.condition },
      },
    );

    return this;
  }

  after<TStep extends StepAction<any, any, any, any>>(steps: TStep | TStep[]) {
    const stepsArray = Array.isArray(steps) ? steps : [steps];
    const stepKeys = stepsArray.map(step => this.#makeStepKey(step));

    // Create a compound key for multiple steps
    const compoundKey = stepKeys.join('&&');
    this.#afterStepStack.push(compoundKey);

    // Initialize subscriber array for this compound step if it doesn't exist
    if (!this.#stepSubscriberGraph[compoundKey]) {
      this.#stepSubscriberGraph[compoundKey] = { initial: [] };
      this.#serializedStepSubscriberGraph[compoundKey] = { initial: [] };
    }

    return this as Omit<typeof this, 'then' | 'after'>;
  }

  afterEvent(eventName: string) {
    const event = this.events?.[eventName];
    if (!event) {
      throw new Error(`Event ${eventName} not found`);
    }

    const lastStep = this.#steps[this.#lastStepStack[this.#lastStepStack.length - 1] ?? ''];
    if (!lastStep) {
      throw new Error('Condition requires a step to be executed after');
    }

    const eventStepKey = `__${eventName}_event`;
    const eventStep = new Step({
      id: eventStepKey,
      execute: async ({ context, suspend }) => {
        if (context.inputData?.resumedEvent) {
          return { executed: true, resumedEvent: context.inputData?.resumedEvent };
        }

        await suspend();
        return { executed: false };
      },
    });

    this.after(lastStep).step(eventStep).after(eventStep);

    return this;
  }

  /**
   * Executes the workflow with the given trigger data
   * @param triggerData - Initial data to start the workflow with
   * @returns Promise resolving to workflow results or rejecting with error
   * @throws Error if trigger schema validation fails
   */

  createRun({
    runId,
    events,
  }: { runId?: string; events?: Record<string, { schema: z.ZodObject<any> }> } = {}): WorkflowResultReturn<
    TTriggerSchema,
    TSteps
  > {
    const run = new WorkflowInstance<TSteps, TTriggerSchema>({
      logger: this.logger,
      name: this.name,
      mastra: this.#mastra,
      retryConfig: this.#retryConfig,
      steps: this.#steps,
      runId,
      stepGraph: this.#stepGraph,
      stepSubscriberGraph: this.#stepSubscriberGraph,
      onStepTransition: this.#onStepTransition,
      onFinish: () => {
        this.#runs.delete(run.runId);
      },
      events,
    });
    this.#runs.set(run.runId, run);
    return {
      start: run.start.bind(run),
      runId: run.runId,
      watch: run.watch.bind(run),
      resume: run.resume.bind(run),
      resumeWithEvent: run.resumeWithEvent.bind(run),
    };
  }

  /**
   * Gets a workflow run instance by ID
   * @param runId - ID of the run to retrieve
   * @returns The workflow run instance if found, undefined otherwise
   */
  getRun(runId: string) {
    return this.#runs.get(runId);
  }

  /**
   * Rebuilds the machine with the current steps configuration and validates the workflow
   *
   * This is the last step of a workflow builder method chain
   * @throws Error if validation fails
   *
   * @returns this instance for method chaining
   */
  commit() {
    return this;
  }

  // record all object paths that leads to a suspended state
  #getSuspendedPaths({
    value,
    path,
    suspendedPaths,
  }: {
    value: string | Record<string, string>;
    path: string;
    suspendedPaths: Set<string>;
  }) {
    if (typeof value === 'string') {
      if (value === 'suspended') {
        suspendedPaths.add(path);
      }
    } else {
      Object.keys(value).forEach(key =>
        this.#getSuspendedPaths({ value: value[key]!, path: path ? `${path}.${key}` : key, suspendedPaths }),
      );
    }
  }

  async #loadWorkflowSnapshot(runId: string) {
    if (!this.#mastra?.storage) {
      this.logger.debug('Snapshot cannot be loaded. Mastra engine is not initialized', { runId });
      return;
    }

    const activeRun = this.#runs.get(runId);
    if (activeRun) {
      await activeRun.persistWorkflowSnapshot();
    }
    return this.#mastra.storage.loadWorkflowSnapshot({ runId, workflowName: this.name });
  }

  getExecutionSpan(runId: string) {
    return this.#runs.get(runId)?.executionSpan;
  }

  #makeStepDef<TStepId extends TSteps[number]['id'], TSteps extends Step<any, any, any>[]>(
    stepId: TStepId,
  ): StepDef<TStepId, TSteps, any, any>[TStepId] {
    const executeStep = (
      handler: (data: any) => Promise<(data: any) => void>,
      spanName: string,
      attributes?: Record<string, string>,
    ) => {
      return async (data: any) => {
        return await otlpContext.with(
          trace.setSpan(otlpContext.active(), this.getExecutionSpan(attributes?.runId ?? data?.runId) as Span),
          async () => {
            if (this?.telemetry) {
              return this.telemetry.traceMethod(handler, {
                spanName,
                attributes,
              })(data);
            } else {
              return handler(data);
            }
          },
        );
      };
    };

    // NOTE: destructuring rest breaks some injected runtime fields, like runId
    // TODO: investigate why that is exactly
    const handler = async ({ context, ...rest }: ActionContext<TSteps[number]['inputSchema']>) => {
      const targetStep = this.#steps[stepId];
      if (!targetStep) throw new Error(`Step not found`);

      const { payload = {}, execute = async () => {} } = targetStep;

      // Merge static payload with dynamically resolved variables
      // Variables take precedence over payload values

      // Only trace if telemetry is available and action exists
      const finalAction = this.telemetry
        ? executeStep(execute, `workflow.${this.name}.action.${stepId}`, {
            componentName: this.name,
            runId: rest.runId as string,
          })
        : execute;

      return finalAction
        ? await finalAction({
            context: { ...context, inputData: { ...(context?.inputData || {}), ...(payload as {}) } },
            ...rest,
          })
        : {};
    };

    // Only trace handler if telemetry is available

    const finalHandler = ({ context, ...rest }: ActionContext<TSteps[number]['inputSchema']>) => {
      if (this.getExecutionSpan(rest?.runId as string)) {
        return executeStep(handler, `workflow.${this.name}.step.${stepId}`, {
          componentName: this.name,
          runId: rest?.runId as string,
        })({ context, ...rest });
      }

      return handler({ context, ...rest });
    };

    return {
      handler: finalHandler,
      data: {},
    };
  }

  #getActivePathsAndStatus(value: Record<string, any>): Array<{
    stepPath: string[];
    stepId: string;
    status: string;
  }> {
    const paths: Array<{
      stepPath: string[];
      stepId: string;
      status: string;
    }> = [];

    const traverse = (current: Record<string, any>, path: string[] = []) => {
      for (const [key, value] of Object.entries(current)) {
        const currentPath = [...path, key];

        if (typeof value === 'string') {
          // Found a leaf state
          paths.push({
            stepPath: currentPath,
            stepId: key,
            status: value,
          });
        } else if (typeof value === 'object' && value !== null) {
          // Continue traversing
          traverse(value, currentPath);
        }
      }
    };

    traverse(value);
    return paths;
  }

  async getState(runId: string): Promise<WorkflowRunState | null> {
    // If this is the currently running workflow
    const run = this.#runs.get(runId);
    if (run) {
      return run.getState();
    }

    // If workflow is suspended/stored, get from storage
    const storedSnapshot = await this.#mastra?.storage?.loadWorkflowSnapshot({
      runId,
      workflowName: this.name,
    });

    if (storedSnapshot) {
      const parsed = storedSnapshot;

      const m = this.#getActivePathsAndStatus(parsed.value);

      return {
        runId,
        value: parsed.value,
        context: parsed.context,
        activePaths: m,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  async resume({
    runId,
    stepId,
    context: resumeContext,
  }: {
    runId: string;
    stepId: string;
    context?: Record<string, any>;
  }) {
    this.logger.warn(`Please use 'resume' on the 'createRun' call instead, resume is deprecated`);

    const activeRun = this.#runs.get(runId);
    if (activeRun) {
      return activeRun.resume({ stepId, context: resumeContext });
    }

    const run = this.createRun({ runId });
    return run.resume({ stepId, context: resumeContext });
  }

  watch(onTransition: (state: WorkflowRunState) => void): () => void {
    this.logger.warn(`Please use 'watch' on the 'createRun' call instead, watch is deprecated`);
    this.#onStepTransition.add(onTransition);

    return () => {
      this.#onStepTransition.delete(onTransition);
    };
  }

  async resumeWithEvent(runId: string, eventName: string, data: any) {
    this.logger.warn(`Please use 'resumeWithEvent' on the 'createRun' call instead, resumeWithEvent is deprecated`);
    const event = this.events?.[eventName];
    if (!event) {
      throw new Error(`Event ${eventName} not found`);
    }

    const results = await this.resume({ runId, stepId: `__${eventName}_event`, context: { resumedEvent: data } });
    return results;
  }

  __registerMastra(mastra: Mastra) {
    this.#mastra = mastra;
  }

  __registerPrimitives(p: MastraPrimitives) {
    if (p.telemetry) {
      this.__setTelemetry(p.telemetry);
    }

    if (p.logger) {
      this.__setLogger(p.logger);
    }
  }

  get stepGraph() {
    return this.#stepGraph;
  }

  get stepSubscriberGraph() {
    return this.#stepSubscriberGraph;
  }

  get serializedStepGraph() {
    return this.#serializedStepGraph;
  }

  get serializedStepSubscriberGraph() {
    return this.#serializedStepSubscriberGraph;
  }

  get steps() {
    return this.#steps;
  }
}
