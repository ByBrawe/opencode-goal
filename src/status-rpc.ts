import { Rpc } from '@opencode/plugin/rpc'

// Shared, implementation-free contract. No filesystem or Goal lifecycle
// code is loaded by a remote client importing this module.
export const GoalStatusRpc = Rpc.define({
  id: 'opencode-goal-status',
  methods: {
    read: {
      input: {
        type: 'object', additionalProperties: false,
        properties: { sessionID: { type: 'string', minLength: 1, maxLength: 256 } },
        required: ['sessionID'],
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          schemaVersion: { type: 'integer', const: 1 },
          sessionID: { type: 'string' }, directory: { type: 'string' },
          text: { type: 'string', maxLength: 4096 },
        },
        required: ['schemaVersion', 'sessionID', 'directory', 'text'],
      },
    },
  },
  events: {},
})
