// language: JavaScript (Node 20+ ESM), file: src/agent/tools/think.js
// The oh-my-pi think tool: a private scratchpad for reasoning.
//
// omp routes this to the model's native reasoning channel when the transport
// supports one, and to a hidden tool when it does not. We cannot know the
// transport here — we send one JSON schema to every provider — so it is the
// second form: a tool whose result is never shown to the user, that exists to
// make the model write its reasoning down before it acts.
//
// The reason it is not useless: tool-call models plan better when the plan is
// an artifact than when it is latent. Writing "the bug is probably in X, check
// X first" makes the next call more likely to be the right one.

export const thinkTools = [
  {
    name: 'think',
    description: 'Reason out loud before acting: what you know, what you suspect, what you will try next, and how you will know if it worked. Private — the user does not see this. Use before a multi-step change, before debugging, or when a decision is not obvious.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning' },
      },
      required: ['thought'],
      additionalProperties: false,
    },
    // never shown, never dangerous — the output is thinking, not a side effect
    isDangerous: false,
    hidden: true,
    async execute({ thought }) {
      // Nothing to do. The value is the act of writing it: the model that
      // states a hypothesis before testing it chooses a better next step.
      return 'ok';
    },
  },
];
