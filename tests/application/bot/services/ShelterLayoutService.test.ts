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
    { x: 220, y: 64, z: -79 },
    { x: 221, y: 64, z: -79 },
    { x: 222, y: 64, z: -79 },
    { x: 220, y: 65, z: -79 },
    { x: 221, y: 65, z: -79 },
    { x: 220, y: 66, z: -79 },
  ]);
});

test('ShelterLayoutService exposes doorway passage and roof standing positions for navigation helpers', () => {
  assert.deepEqual(layout.getDoorwayPassagePositions(rallyPoint), [
    { x: 215, y: 64, z: -75 },
    { x: 215, y: 64, z: -76 },
  ]);
  assert.deepEqual(layout.getRoofAccessStandingPosition(rallyPoint), {
    x: 220,
    y: 67,
    z: -79,
  });
});

test('ShelterLayoutService reports whether a position is inside the interior', () => {
  assert.equal(layout.isInsideInterior({ x: 215, y: 64, z: -76 }, rallyPoint), true);
  assert.equal(layout.isInsideInterior({ x: 215, y: 64, z: -75 }, rallyPoint), false);
  assert.equal(layout.isInsideInterior({ x: 213, y: 65, z: -78 }, rallyPoint), false);
});

test('ShelterLayoutService exposes all interior floor positions for adaptive bed placement', () => {
  const interiorFloorPositions = layout.getInteriorFloorPositions(rallyPoint);

  assert.equal(interiorFloorPositions.length, 28);
  assert.deepEqual(interiorFloorPositions[0], { x: 212, y: 64, z: -79 });
  assert.deepEqual(interiorFloorPositions.at(-1), { x: 218, y: 64, z: -76 });
});

test('ShelterLayoutService keeps bed access candidates inside the shelter interior', () => {
  assert.deepEqual(layout.getBedAccessCandidatePositions(rallyPoint, { x: 213, y: 64, z: -78 }), [
    { x: 213, y: 64, z: -77 },
    { x: 213, y: 64, z: -79 },
    { x: 212, y: 64, z: -78 },
    { x: 214, y: 64, z: -78 },
  ]);
});
