import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ShelterLayoutService,
} from '../../../../src/application/bot/services/ShelterLayoutService';

const layout = new ShelterLayoutService({
  width: 9,
  length: 6,
  wallHeight: 3,
  roofAccessStepZ: 1,
});

const rallyPoint = { x: 215, y: 64, z: -77 };

test('ShelterLayoutService derives the main shelter points deterministically', () => {
  assert.deepEqual(layout.getOrigin(rallyPoint), { x: 211, y: 64, z: -80 });
  assert.deepEqual(layout.getDoorPosition(rallyPoint), { x: 215, y: 64, z: -75 });
  assert.deepEqual(layout.getInteriorAnchor(rallyPoint), { x: 215, y: 64, z: -76 });
  assert.deepEqual(layout.getBedFootPositions(rallyPoint), [
    { x: 213, y: 64, z: -78 },
    { x: 215, y: 64, z: -78 },
    { x: 217, y: 64, z: -78 },
  ]);
});

test('ShelterLayoutService exposes roof and wall geometry for the taller house', () => {
  assert.equal(layout.getWallPositions(rallyPoint).length, 76);
  assert.equal(layout.getRoofPositions(rallyPoint).length, 54);
  assert.deepEqual(layout.getRoofAccessStepPositions(rallyPoint), [
    { x: 222, y: 64, z: -79 },
    { x: 221, y: 65, z: -79 },
    { x: 220, y: 66, z: -79 },
  ]);
});

test('ShelterLayoutService reports whether a position is inside the interior', () => {
  assert.equal(layout.isInsideInterior({ x: 215, y: 64, z: -76 }, rallyPoint), true);
  assert.equal(layout.isInsideInterior({ x: 215, y: 64, z: -75 }, rallyPoint), false);
  assert.equal(layout.isInsideInterior({ x: 213, y: 65, z: -78 }, rallyPoint), false);
});
