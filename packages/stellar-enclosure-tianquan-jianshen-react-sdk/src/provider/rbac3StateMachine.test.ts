import { describe, expect, it } from 'vitest'
import { permissionBindingKey, snapshotContext } from '@stellar-enclosure/stellar-enclosure-web-shared/permissions'
import { snapshot, about } from '../test/permissionFixtures'
import { initialRbac3MachineState, transitionRbac3State } from './rbac3StateMachine'

const binding = snapshotContext(snapshot(), 0)
const loading = () => transitionRbac3State(initialRbac3MachineState, { type: 'INITIALIZE', inputBindingKey: permissionBindingKey(binding), requestEpoch: 0 })
describe('Tianquan-Jianshen state machine', () => {
  it('requires an explicit current snapshot before READY', () => {
    expect(loading().snapshot).toBeNull()
    const invalid = transitionRbac3State(loading(), { type: 'ABOUT_SUCCEEDED', about, snapshot: snapshot({ policyVersion: '12' }), binding })
    expect(invalid.status).toBe('ERROR_RETRYABLE'); expect(invalid.snapshot).toBeNull()
  })
  it('never restores pre-mutation grants after a rejected role change', () => {
    const ready = transitionRbac3State(loading(), { type: 'ABOUT_SUCCEEDED', about, snapshot: snapshot(), binding })
    const replacing = transitionRbac3State(ready, { type: 'REPLACE_ACTIVE_ROLES' })
    expect(replacing.snapshot).toBeNull()
    const rejected = transitionRbac3State(replacing, { type: 'REPLACE_REJECTED', errorCode: 'APP_ROLE_ACTIVATION_MUTEX_VIOLATION' })
    expect(rejected.status).toBe('ERROR_RETRYABLE'); expect(rejected.snapshot).toBeNull()
  })
  it('clears all grant-bearing state on forbidden or expired events', () => {
    const ready = transitionRbac3State(loading(), { type: 'ABOUT_SUCCEEDED', about, snapshot: snapshot(), binding })
    for (const event of [{ type: 'FORBIDDEN', errorCode: 'PERMISSION_DENIED' } as const, { type: 'EXPIRED' } as const]) {
      expect(transitionRbac3State(ready, event).snapshot).toBeNull()
    }
  })
})
