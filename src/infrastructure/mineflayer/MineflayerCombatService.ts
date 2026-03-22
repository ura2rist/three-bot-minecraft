import { Entity } from 'prismarine-entity';
import { Item } from 'prismarine-item';
import { BotWithPathfinder } from './MineflayerPortsShared';

const MELEE_WEAPON_PRIORITY: readonly string[] = [
  'netherite_sword',
  'diamond_sword',
  'iron_sword',
  'stone_sword',
  'golden_sword',
  'wooden_sword',
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
  'golden_axe',
  'wooden_axe',
] as const;

export class MineflayerCombatService {
  constructor(private readonly bot: BotWithPathfinder) {}

  async equipWeaponIfAvailable(): Promise<boolean> {
    const weapon = this.findBestMeleeWeapon();

    if (!weapon) {
      return false;
    }

    if (this.bot.heldItem?.type === weapon.type) {
      return true;
    }

    await this.bot.equip(weapon, 'hand').catch(() => undefined);
    return this.bot.heldItem?.type === weapon.type;
  }

  async attackTarget(target: Entity): Promise<void> {
    if (!target.isValid) {
      return;
    }

    await this.equipWeaponIfAvailable();
    await this.bot.lookAt(target.position.offset(0, Math.max(target.height / 2, 0.5), 0), true);
    this.bot.attack(target);
  }

  private findBestMeleeWeapon(): Item | undefined {
    const inventoryItems = this.bot.inventory.items();

    for (const itemName of MELEE_WEAPON_PRIORITY) {
      const weapon = inventoryItems.find((item) => item.name === itemName);

      if (weapon) {
        return weapon;
      }
    }

    return undefined;
  }
}
