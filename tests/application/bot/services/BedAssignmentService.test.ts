import test from 'node:test';
import assert from 'node:assert/strict';
import { BedAssignmentService } from '../../../../src/application/bot/services/BedAssignmentService';

test('BedAssignmentService rotates bed preference by role', () => {
  const service = new BedAssignmentService();

  assert.deepEqual(service.getAssignmentOrder('farm', 3), [0, 1, 2]);
  assert.deepEqual(service.getAssignmentOrder('mine', 3), [1, 2, 0]);
  assert.deepEqual(service.getAssignmentOrder('trading', 3), [2, 0, 1]);
});

test('BedAssignmentService handles zero beds', () => {
  const service = new BedAssignmentService();
  assert.deepEqual(service.getAssignmentOrder('farm', 0), []);
});

test('BedAssignmentService collapses all roles onto the only available bed', () => {
  const service = new BedAssignmentService();

  assert.deepEqual(service.getAssignmentOrder('farm', 1), [0]);
  assert.deepEqual(service.getAssignmentOrder('mine', 1), [0]);
  assert.deepEqual(service.getAssignmentOrder('trading', 1), [0]);
});

test('BedAssignmentService wraps preferred indexes when only two beds are available', () => {
  const service = new BedAssignmentService();

  assert.deepEqual(service.getAssignmentOrder('farm', 2), [0, 1]);
  assert.deepEqual(service.getAssignmentOrder('mine', 2), [1, 0]);
  assert.deepEqual(service.getAssignmentOrder('trading', 2), [0, 1]);
});

test('BedAssignmentService wraps preferred indexes when more beds than default roles are available', () => {
  const service = new BedAssignmentService();

  assert.deepEqual(service.getAssignmentOrder('farm', 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(service.getAssignmentOrder('mine', 5), [1, 2, 3, 4, 0]);
  assert.deepEqual(service.getAssignmentOrder('trading', 5), [2, 3, 4, 0, 1]);
});
