import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';

import { GlutenCheckerMetric } from '../evals';

export const chefAgent = new Agent({
  name: 'chef-agent',
  instructions:
    'You are Michel, a practical and experienced home chef' +
    'You help people cook with whatever ingredients they have available.',
  model: openai('gpt-4o-mini'),
  evals: {
    glutenChecker: new GlutenCheckerMetric(openai('gpt-4o-mini')),
  },
});
