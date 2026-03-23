import { BotRallyPoint } from '../../../domain/bot/entities/BotConfiguration';

export interface BlockPosition {
  x: number;
  y: number;
  z: number;
}

export interface ShelterLayoutDimensions {
  width: number;
  length: number;
  wallHeight: number;
  roofAccessStepZ: number;
}

export class ShelterLayoutService {
  constructor(private readonly dimensions: ShelterLayoutDimensions) {}

  getOrigin(rallyPoint: BotRallyPoint): BlockPosition {
    return {
      x: rallyPoint.x - Math.floor(this.dimensions.width / 2),
      y: rallyPoint.y,
      z: rallyPoint.z - Math.floor(this.dimensions.length / 2),
    };
  }

  getDoorPosition(rallyPoint: BotRallyPoint): BlockPosition {
    const origin = this.getOrigin(rallyPoint);

    return {
      x: origin.x + Math.floor(this.dimensions.width / 2),
      y: origin.y,
      z: origin.z + this.dimensions.length - 1,
    };
  }

  getInteriorAnchor(rallyPoint: BotRallyPoint): BlockPosition {
    const doorPosition = this.getDoorPosition(rallyPoint);

    return {
      x: doorPosition.x,
      y: doorPosition.y,
      z: doorPosition.z - 1,
    };
  }

  getBedRowZ(): number {
    return Math.max(1, this.dimensions.length - 4);
  }

  getBedFootPositions(rallyPoint: BotRallyPoint): BlockPosition[] {
    const origin = this.getOrigin(rallyPoint);
    const centerX = Math.floor(this.dimensions.width / 2);
    const bedRowZ = this.getBedRowZ();

    return [-2, 0, 2].map((offsetX) => ({
      x: origin.x + centerX + offsetX,
      y: origin.y,
      z: origin.z + bedRowZ,
    }));
  }

  getWallPositions(rallyPoint: BotRallyPoint): BlockPosition[] {
    const origin = this.getOrigin(rallyPoint);
    const doorPosition = this.getDoorPosition(rallyPoint);
    const positions: BlockPosition[] = [];

    for (let y = 0; y < this.dimensions.wallHeight; y += 1) {
      for (let x = 0; x < this.dimensions.width; x += 1) {
        for (let z = 0; z < this.dimensions.length; z += 1) {
          const isPerimeter =
            x === 0 ||
            x === this.dimensions.width - 1 ||
            z === 0 ||
            z === this.dimensions.length - 1;

          if (!isPerimeter) {
            continue;
          }

          const position = {
            x: origin.x + x,
            y: origin.y + y,
            z: origin.z + z,
          };

          const isDoorOpening =
            position.x === doorPosition.x &&
            position.z === doorPosition.z &&
            position.y < doorPosition.y + 2;

          if (isDoorOpening) {
            continue;
          }

          positions.push(position);
        }
      }
    }

    return positions;
  }

  getRoofPositions(rallyPoint: BotRallyPoint): BlockPosition[] {
    const origin = this.getOrigin(rallyPoint);
    const roofY = origin.y + this.dimensions.wallHeight;
    const positions: BlockPosition[] = [];

    for (let x = 0; x < this.dimensions.width; x += 1) {
      for (let z = 0; z < this.dimensions.length; z += 1) {
        positions.push({
          x: origin.x + x,
          y: roofY,
          z: origin.z + z,
        });
      }
    }

    return positions;
  }

  getRoofAccessStepPositions(rallyPoint: BotRallyPoint): BlockPosition[] {
    const origin = this.getOrigin(rallyPoint);

    return [
      {
        x: origin.x + this.dimensions.width + 2,
        y: origin.y,
        z: origin.z + this.dimensions.roofAccessStepZ,
      },
      {
        x: origin.x + this.dimensions.width + 1,
        y: origin.y + 1,
        z: origin.z + this.dimensions.roofAccessStepZ,
      },
      {
        x: origin.x + this.dimensions.width,
        y: origin.y + 2,
        z: origin.z + this.dimensions.roofAccessStepZ,
      },
    ];
  }

  getRoofAccessStandingPosition(rallyPoint: BotRallyPoint): BlockPosition {
    const topStep = this.getRoofAccessStepPositions(rallyPoint)[2];

    return {
      x: topStep.x,
      y: topStep.y + 1,
      z: topStep.z,
    };
  }

  getDoorwayPassagePositions(rallyPoint: BotRallyPoint): BlockPosition[] {
    const doorPosition = this.getDoorPosition(rallyPoint);

    return [
      { ...doorPosition },
      this.getInteriorAnchor(rallyPoint),
    ];
  }

  getBedAccessCandidatePositions(rallyPoint: BotRallyPoint, bedPosition: BlockPosition): BlockPosition[] {
    const candidates = [
      { x: bedPosition.x, y: bedPosition.y, z: bedPosition.z + 1 },
      { x: bedPosition.x, y: bedPosition.y, z: bedPosition.z - 1 },
      { x: bedPosition.x - 1, y: bedPosition.y, z: bedPosition.z },
      { x: bedPosition.x + 1, y: bedPosition.y, z: bedPosition.z },
    ];

    return candidates.filter((candidate) => this.isInsideInterior(candidate, rallyPoint));
  }

  getInteriorFloorPositions(rallyPoint: BotRallyPoint): BlockPosition[] {
    const origin = this.getOrigin(rallyPoint);
    const positions: BlockPosition[] = [];

    for (let z = 1; z < this.dimensions.length - 1; z += 1) {
      for (let x = 1; x < this.dimensions.width - 1; x += 1) {
        positions.push({
          x: origin.x + x,
          y: origin.y,
          z: origin.z + z,
        });
      }
    }

    return positions;
  }

  isInsideInterior(position: BlockPosition, rallyPoint: BotRallyPoint): boolean {
    const origin = this.getOrigin(rallyPoint);
    const minX = origin.x + 1;
    const maxX = origin.x + this.dimensions.width - 2;
    const minZ = origin.z + 1;
    const maxZ = origin.z + this.dimensions.length - 2;

    return (
      position.x >= minX &&
      position.x <= maxX &&
      position.z >= minZ &&
      position.z <= maxZ &&
      position.y === rallyPoint.y
    );
  }
}
