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
