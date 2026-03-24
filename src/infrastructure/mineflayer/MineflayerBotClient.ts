import mineflayer from 'mineflayer';
import { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { BotActivityEvent } from '../../application/bot/events/BotActivityEvent';
import { BotPriorityLifecycleSubscriber } from '../../application/bot/subscribers/BotPriorityLifecycleSubscriber';
import { BotThreatPrioritySubscriber } from '../../application/bot/subscribers/BotThreatPrioritySubscriber';
import { BotPriorityCoordinator } from '../../application/bot/services/BotPriorityCoordinator';
import { SquadWeaponReadinessTracker } from '../../application/bot/services/SquadWeaponReadinessTracker';
import { BotClient } from '../../application/bot/ports/BotClient';
import { TradingRoleSettingsProvider } from '../../application/bot/ports/TradingRoleSettingsProvider';
import { EstablishMicroBaseService } from '../../application/bot/services/EstablishMicroBaseService';
import { DeterministicMicroBaseAssignmentPolicy } from '../../application/bot/services/DeterministicMicroBaseAssignmentPolicy';
import { EnsureCraftingTableNearRallyPointService } from '../../application/bot/services/EnsureCraftingTableNearRallyPointService';
import { RandomCraftingTableAssignmentPolicy } from '../../application/bot/services/RandomCraftingTableAssignmentPolicy';
import { BotConfiguration } from '../../domain/bot/entities/BotConfiguration';
import { TradingRoleSettings } from '../../domain/bot/entities/RoleSettings';
import { Logger } from '../../application/shared/ports/Logger';
import { LightAuthBotAuthenticator } from './LightAuthBotAuthenticator';
import { MineflayerAutoEatController } from './MineflayerAutoEatController';
import { MineflayerCraftingTablePlacementPort } from './MineflayerCraftingTablePlacementPort';
import { MineflayerItemCraftingPort } from './MineflayerItemCraftingPort';
import { MineflayerCombatService } from './MineflayerCombatService';
import { MicroBaseScenarioCancelledError, MineflayerMicroBasePort } from './MineflayerMicroBasePort';
import { MineflayerNearbyDroppedItemCollector } from './MineflayerNearbyDroppedItemCollector';
import { MineflayerLogHarvestingPort } from './MineflayerLogHarvestingPort';
import { MineflayerSquadDefenseController } from './MineflayerSquadDefenseController';
import { MineflayerTradingRoutine } from './MineflayerTradingRoutine';
import type { BotWithPathfinder, PathfinderApi, PathfinderMovements } from './MineflayerPortsShared';
import { InMemoryEventBus } from '../events/InMemoryEventBus';

const mineflayerPathfinder = require('../../../.vendor/mineflayer-pathfinder-master');
const pathfinderPlugin = mineflayerPathfinder.pathfinder as (bot: mineflayer.Bot) => void;
const Movements = mineflayerPathfinder.Movements as new (bot: mineflayer.Bot) => PathfinderMovements;
const GoalNear = mineflayerPathfinder.goals.GoalNear as new (
  x: number,
  y: number,
  z: number,
  range: number,
) => unknown;
const GoalNearXZ = mineflayerPathfinder.goals.GoalNearXZ as new (
  x: number,
  z: number,
  range: number,
) => unknown;

interface StringEventBot {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

type BotWithClient = mineflayer.Bot & {
  pathfinder?: PathfinderApi;
  _client: mineflayer.Bot['_client'] & {
    _lastDisconnectReason?: string;
  };
};

class RallyNavigationCancelledError extends Error {
  constructor() {
    super('Rally navigation was superseded by a newer attempt.');
    this.name = 'RallyNavigationCancelledError';
  }
}

export class MineflayerBotClient implements BotClient {
  private readonly rallyGoalRange = 1;
  private readonly rallyMinDistanceToMove = this.parseInteger(
    process.env.BOT_RALLY_MOVE_DISTANCE_THRESHOLD,
    5,
  );
  private readonly rallyStepDistance = this.parseInteger(process.env.BOT_RALLY_STEP_DISTANCE, 40);
  private readonly rallyHorizontalGoalRange = this.parseInteger(
    process.env.BOT_RALLY_HORIZONTAL_GOAL_RANGE,
    3,
  );
  private readonly rallyTimeoutMs = this.parseInteger(process.env.BOT_RALLY_TIMEOUT_MS, 120000);
  private readonly rallyRetryDelayMs = this.parseInteger(process.env.BOT_RALLY_RETRY_DELAY_MS, 3000);
  private readonly rallySingleAttemptTimeoutMs = this.parseInteger(
    process.env.BOT_RALLY_SINGLE_ATTEMPT_TIMEOUT_MS,
    15000,
  );
  private readonly rallyStabilizationTicks = this.parseInteger(
    process.env.BOT_RALLY_STABILIZATION_TICKS,
    20,
  );
  private readonly configurationFallbackDelayMs = this.parseInteger(
    process.env.BOT_CONFIGURATION_FALLBACK_DELAY_MS,
    1500,
  );
  private readonly rallyDoorSearchRadius = 6;
  private readonly loginTimeoutMs = this.parseInteger(process.env.BOT_LOGIN_TIMEOUT_MS, 20000);
  private readonly spawnTimeoutMs = this.parseInteger(process.env.BOT_SPAWN_TIMEOUT_MS, 20000);
  private readonly retryDelayMs = this.parseInteger(process.env.BOT_CONNECT_RETRY_DELAY_MS, 7000);
  private readonly maxRetries = this.parseInteger(process.env.BOT_CONNECT_MAX_RETRIES, 2);
  private readonly reconnectDelayMs = this.parseInteger(process.env.BOT_RECONNECT_DELAY_MS, 5000);
  private readonly pathfinderThinkTimeoutMs = this.parseInteger(
    process.env.BOT_PATHFINDER_THINK_TIMEOUT_MS,
    3000,
  );
  private readonly pathfinderTickTimeoutMs = this.parseInteger(
    process.env.BOT_PATHFINDER_TICK_TIMEOUT_MS,
    15,
  );
  private readonly craftingTableAssignmentPolicy = new RandomCraftingTableAssignmentPolicy();
  private readonly microBaseAssignmentPolicy = new DeterministicMicroBaseAssignmentPolicy();
  private readonly squadWeaponReadinessTracker = new SquadWeaponReadinessTracker();
  private readonly supervisedBots = new Set<string>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectingBots = new Set<string>();
  private readonly friendlyUsernames = new Set<string>();
  private readonly connectedPathfinderBots = new Map<string, BotWithClient>();
  private readonly tradingRoleSettings: TradingRoleSettings;

  constructor(
    private readonly logger: Logger,
    tradingRoleSettingsProvider: TradingRoleSettingsProvider,
  ) {
    this.tradingRoleSettings = tradingRoleSettingsProvider.load();
  }

  prepareFleet(configurations: readonly BotConfiguration[]): void {
    this.craftingTableAssignmentPolicy.prepareFleet(configurations);
    this.microBaseAssignmentPolicy.prepareFleet(configurations);
    this.squadWeaponReadinessTracker.reset();
    this.friendlyUsernames.clear();

    for (const configuration of configurations) {
      this.friendlyUsernames.add(configuration.username);
    }

    for (const configuration of configurations) {
      const assignedUsername = this.craftingTableAssignmentPolicy.getAssignedUsername(configuration);

      if (!assignedUsername || !configuration.rallyPoint || assignedUsername !== configuration.username) {
        continue;
      }

      this.logger.info(
        `Crafting table provisioning near ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z} is assigned to "${configuration.username}".`,
      );
    }

    const microBaseLeaderUsername = this.microBaseAssignmentPolicy.getLeaderUsername();

    if (microBaseLeaderUsername) {
      this.logger.info(`Micro-base leadership is assigned to "${microBaseLeaderUsername}".`);
    }
  }

  async connect(configuration: BotConfiguration): Promise<void> {
    this.supervisedBots.add(this.getBotKey(configuration));
    await this.connectWithRetries(configuration, false);
  }

  private async connectWithRetries(
    configuration: BotConfiguration,
    isReconnectAttempt: boolean,
  ): Promise<void> {
    let attempt = 0;
    const botKey = this.getBotKey(configuration);

    this.clearReconnectTimer(botKey);

    while (attempt <= this.maxRetries) {
      try {
        await this.connectOnce(configuration);
        if (isReconnectAttempt) {
          this.logger
            .child(configuration.role)
            .info(`Bot "${configuration.username}" reconnected successfully.`);
        }

        return;
      } catch (error) {
        const isLastAttempt = attempt >= this.maxRetries;

        if (!this.isRetryableConnectionError(error) || isLastAttempt) {
          throw error;
        }

        this.logger
          .child(configuration.role)
          .warn(
            `Bot startup failed with a retryable connection error. Retrying in ${this.retryDelayMs}ms (attempt ${attempt + 2}/${this.maxRetries + 1}).`,
          );

        await this.delay(this.retryDelayMs);
      }

      attempt += 1;
    }
  }

  private async connectOnce(configuration: BotConfiguration): Promise<void> {
    const logger = this.logger.child(configuration.role);
    const bot = mineflayer.createBot({
      host: configuration.host,
      port: configuration.port,
      username: configuration.username,
      version: configuration.version,
      auth: configuration.auth,
    }) as BotWithClient;
    bot.loadPlugin(pathfinderPlugin);

    const authenticator = new LightAuthBotAuthenticator(logger);
    let autoEatController: MineflayerAutoEatController | null = null;
    let nearbyDroppedItemCollector: MineflayerNearbyDroppedItemCollector | null = null;
    let squadDefenseController: MineflayerSquadDefenseController | null = null;
    let combatService: MineflayerCombatService | null = null;
    let hasSpawned = false;
    let isAuthenticated = false;
    let startupCompleted = false;
    let reconnectScheduled = false;
    let microBaseScenarioStarted = false;
    let microBaseScenarioGeneration = 0;
    let nightlyShelterRoutineStarted = false;
    let tradingRoutineStarted = false;
    let spawnCount = 0;
    let configurationSettingsSent = false;
    let configurationFallbackTriggered = false;
    let rallyNavigationPromise: Promise<void> | null = null;
    let rallyNavigationAttempt = 0;
    const eventBus = new InMemoryEventBus<BotActivityEvent>();
    const priorityCoordinator = new BotPriorityCoordinator();
    const eventBusUnsubscribers = [
      ...new BotPriorityLifecycleSubscriber(eventBus, priorityCoordinator).subscribe(),
      ...new BotThreatPrioritySubscriber(eventBus, priorityCoordinator).subscribe(),
    ];
    const disposeEventBusSubscriptions = () => {
      while (eventBusUnsubscribers.length > 0) {
        const unsubscribe = eventBusUnsubscribers.pop();
        unsubscribe?.();
      }
    };
    const publishEvent = async (event: BotActivityEvent) => {
      await eventBus.publish(event);
    };
    const isCurrentRallyNavigationAttempt = (attempt: number) => attempt === rallyNavigationAttempt;
    const configurePathfinder = () => {
      if (!bot.pathfinder) {
        return;
      }

      bot.pathfinder.thinkTimeout = this.pathfinderThinkTimeoutMs;
      bot.pathfinder.tickTimeout = this.pathfinderTickTimeoutMs;
    };

    const sendConfigurationSettings = () => {
      if (configurationSettingsSent || bot._client.state !== 'configuration') {
        return;
      }

      bot.setSettings({});
      configurationSettingsSent = true;
      logger.info('Client settings packet sent during configuration phase.');
    };
    const stopRallyNavigation = (reason: string) => {
      if (!configuration.rallyPoint) {
        return;
      }

      rallyNavigationAttempt += 1;
      rallyNavigationPromise = null;
      bot.pathfinder?.stop();
      logger.info(`Stopped rally navigation: ${reason}.`);
    };
    const cancelScenarios = (reason: string) => {
      microBaseScenarioGeneration += 1;
      microBaseScenarioStarted = false;
      nightlyShelterRoutineStarted = false;
      tradingRoutineStarted = false;
      bot.pathfinder?.stop();
      logger.info(`Stopped active scenarios: ${reason}.`);
    };
    const scheduleReconnect = (reason: string) => {
      if (!startupCompleted || reconnectScheduled) {
        return;
      }

      reconnectScheduled = true;
      this.scheduleReconnect(configuration, logger, reason);
    };
    const getNearbyDroppedItemCollector = () => {
      if (nearbyDroppedItemCollector) {
        return nearbyDroppedItemCollector;
      }

      const pathfinderBot = this.requirePathfinderBot(bot);
      nearbyDroppedItemCollector = new MineflayerNearbyDroppedItemCollector(
        pathfinderBot,
        logger.child('pickup'),
        (target, range) => this.gotoPosition(pathfinderBot, target, range),
        () => priorityCoordinator.getCurrentTask() === 'idle',
      );
      return nearbyDroppedItemCollector;
    };
    const getAutoEatController = () => {
      if (autoEatController) {
        return autoEatController;
      }

      autoEatController = new MineflayerAutoEatController(
        this.requirePathfinderBot(bot),
        logger.child('autoeat'),
      );
      return autoEatController;
    };
    const getSquadDefenseController = () => {
      if (squadDefenseController) {
        return squadDefenseController;
      }

      const pathfinderBot = this.requirePathfinderBot(bot);
      const sharedCombatService = getCombatService();
      squadDefenseController = new MineflayerSquadDefenseController(
        pathfinderBot,
        logger.child('defense'),
        this.friendlyUsernames,
        (target, range) => this.gotoPosition(pathfinderBot, target, range),
        sharedCombatService,
        () => priorityCoordinator.canInterruptWithThreatResponse(),
        publishEvent,
      );
      return squadDefenseController;
    };
    const getCombatService = () => {
      if (combatService) {
        return combatService;
      }

      combatService = new MineflayerCombatService(this.requirePathfinderBot(bot));
      return combatService;
    };
    const createScenarioWaiter = (scenarioGeneration: number) => {
      return () =>
        priorityCoordinator.waitUntilTaskMayProceed(
          () => scenarioGeneration === microBaseScenarioGeneration,
        );
    };
    const createMicroBasePort = (scenarioGeneration: number, portLogger: Logger) => {
      const pathfinderBot = this.requirePathfinderBot(bot);
      const publishNightShelterStarted = async () => {
        if (scenarioGeneration !== microBaseScenarioGeneration) {
          return;
        }

        await publishEvent({
          type: 'bot.task.started',
          payload: {
            username: configuration.username,
            task: 'night_shelter',
          },
        });
      };
      const publishNightShelterCompleted = async () => {
        if (scenarioGeneration !== microBaseScenarioGeneration) {
          return;
        }

        await publishEvent({
          type: 'bot.task.completed',
          payload: {
            username: configuration.username,
            task: 'night_shelter',
          },
        });
      };

      return new MineflayerMicroBasePort(
        pathfinderBot,
        configuration.role,
        portLogger,
        (target, range) => this.gotoPosition(pathfinderBot, target, range),
        new MineflayerLogHarvestingPort(
          pathfinderBot,
          portLogger,
          (target, range) => this.gotoPosition(pathfinderBot, target, range),
          getNearbyDroppedItemCollector(),
          createScenarioWaiter(scenarioGeneration),
          () => priorityCoordinator.isThreatResponseActive(),
        ),
        getNearbyDroppedItemCollector(),
        getCombatService(),
        (position, minimumDistance) =>
          this.requestFriendlyBotsToClearPosition(
            configuration.username,
            position,
            minimumDistance,
            portLogger,
          ),
        () => scenarioGeneration === microBaseScenarioGeneration,
        createScenarioWaiter(scenarioGeneration),
        () => priorityCoordinator.isThreatResponseActive(),
        this.friendlyUsernames.size,
        publishNightShelterStarted,
        publishNightShelterCompleted,
      );
    };
    const startNightlyShelterRoutine = (scenarioGeneration: number, microBaseLogger: Logger) => {
      if (!configuration.rallyPoint || nightlyShelterRoutineStarted) {
        return;
      }

      nightlyShelterRoutineStarted = true;
      const microBasePort = createMicroBasePort(scenarioGeneration, microBaseLogger);

      void microBasePort
        .maintainNightlyShelterRoutine(configuration.rallyPoint)
        .catch((error) => {
          if (error instanceof MicroBaseScenarioCancelledError) {
            return;
          }

          microBaseLogger.warn(
            `Night shelter routine stopped unexpectedly: ${this.stringifyError(error)}.`,
          );
        })
        .finally(() => {
          if (scenarioGeneration === microBaseScenarioGeneration) {
            nightlyShelterRoutineStarted = false;
          }
        });
    };
    const startTradingRoutine = (scenarioGeneration: number, microBaseLogger: Logger) => {
      if (
        configuration.role !== 'trading' ||
        !configuration.rallyPoint ||
        tradingRoutineStarted
      ) {
        return;
      }

      tradingRoutineStarted = true;
      const tradingLogger = logger.child('trading-main');
      const tradingRoutine = new MineflayerTradingRoutine(
        this.requirePathfinderBot(bot),
        tradingLogger,
        configuration.rallyPoint,
        this.tradingRoleSettings,
        (target, range) => this.gotoPosition(this.requirePathfinderBot(bot), target, range),
        () => scenarioGeneration === microBaseScenarioGeneration,
        createScenarioWaiter(scenarioGeneration),
        (delayMs) => getNearbyDroppedItemCollector().pauseBackgroundCollectionFor(delayMs),
      );

      void tradingRoutine
        .maintain()
        .catch((error) => {
          if (scenarioGeneration !== microBaseScenarioGeneration) {
            return;
          }

          tradingLogger.warn(
            `Trading main routine stopped unexpectedly: ${this.stringifyError(error)}.`,
          );
        })
        .finally(() => {
          if (scenarioGeneration === microBaseScenarioGeneration) {
            tradingRoutineStarted = false;
          }
        });
    };
    const startMicroBaseScenario = () => {
      if (!configuration.rallyPoint || microBaseScenarioStarted) {
        return;
      }

      microBaseScenarioStarted = true;
      const scenarioGeneration = microBaseScenarioGeneration;
      const microBaseLogger = logger.child('microbase');
      const microBaseService = new EstablishMicroBaseService(
        this.microBaseAssignmentPolicy,
        createMicroBasePort(scenarioGeneration, microBaseLogger),
        microBaseLogger,
        eventBus,
        this.squadWeaponReadinessTracker,
        [...this.friendlyUsernames],
        () => scenarioGeneration === microBaseScenarioGeneration,
      );

      void microBaseService
        .execute(configuration)
        .then(() => {
          if (
            scenarioGeneration !== microBaseScenarioGeneration ||
            !isAuthenticated ||
            !bot.entity
          ) {
            return;
          }

          startNightlyShelterRoutine(scenarioGeneration, microBaseLogger);
          startTradingRoutine(scenarioGeneration, microBaseLogger);
        })
        .catch(async (error) => {
          if (error instanceof MicroBaseScenarioCancelledError) {
            microBaseLogger.info('Micro-base scenario was cancelled and will restart from the beginning if needed.');
            return;
          }

          if (
            scenarioGeneration === microBaseScenarioGeneration &&
            this.isRetryableRallyNavigationError(error)
          ) {
            microBaseLogger.warn(
              `Micro-base scenario was interrupted before the current step completed. Restarting from the beginning in ${this.rallyRetryDelayMs}ms: ${this.stringifyError(error)}.`,
            );
            microBaseScenarioStarted = false;
            nightlyShelterRoutineStarted = false;
            tradingRoutineStarted = false;
            await priorityCoordinator.waitUntilTaskMayProceed(
              () => scenarioGeneration === microBaseScenarioGeneration,
            );

            if (
              scenarioGeneration !== microBaseScenarioGeneration ||
              !isAuthenticated ||
              !bot.entity
            ) {
              return;
            }

            await this.delay(this.rallyRetryDelayMs);

            if (
              scenarioGeneration !== microBaseScenarioGeneration ||
              !isAuthenticated ||
              !bot.entity
            ) {
              return;
            }

            startMicroBaseScenario();
            return;
          }

          if (this.isFriendlyMissingResourceError(error)) {
            microBaseLogger.warn(this.stringifyError(error));
            return;
          }

          microBaseLogger.error('Failed to establish the micro-base scenario.', error);
        });
    };
    const runPostRallyScenario = async (isCurrentAttempt: () => boolean) => {
      this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
      logger.info('Running the post-rally scenario.');
      const pathfinderBot = this.requirePathfinderBot(bot);
      const waitUntilTaskMayProceed = async () => {
        this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
        await priorityCoordinator.waitUntilTaskMayProceed(() => isCurrentAttempt());
        this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
      };
      const logHarvestingPort = new MineflayerLogHarvestingPort(
        pathfinderBot,
        logger,
        (target, range) => this.gotoPosition(pathfinderBot, target, range),
        getNearbyDroppedItemCollector(),
        waitUntilTaskMayProceed,
        () => priorityCoordinator.isThreatResponseActive(),
      );
      const ensureCraftingTableService = new EnsureCraftingTableNearRallyPointService(
        this.craftingTableAssignmentPolicy,
        new MineflayerCraftingTablePlacementPort(pathfinderBot, logger, (target, range) =>
          this.gotoPosition(pathfinderBot, target, range),
          waitUntilTaskMayProceed,
          () => priorityCoordinator.isThreatResponseActive(),
        ),
        new MineflayerItemCraftingPort(pathfinderBot, logger),
        logHarvestingPort,
        logger,
      );

      await publishEvent({
        type: 'bot.task.started',
        payload: {
          username: configuration.username,
          task: 'microbase_setup',
        },
      });

      try {
        logger.info('Ensuring that a crafting table is available near the rally point.');
        await ensureCraftingTableService.execute(configuration);
        this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
        logger.info('Crafting table step is complete. Starting the micro-base scenario.');
      } finally {
        await publishEvent({
          type: 'bot.task.completed',
          payload: {
            username: configuration.username,
            task: 'microbase_setup',
          },
        });
      }

      this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
      startMicroBaseScenario();
    };
    const startRallyNavigation = (force = false) => {
      if (!configuration.rallyPoint) {
        return;
      }

      if (force && rallyNavigationPromise) {
        stopRallyNavigation('restarting route after respawn');
      }

      if (rallyNavigationPromise) {
        return;
      }

      const attempt = rallyNavigationAttempt + 1;
      rallyNavigationAttempt = attempt;

      const shouldMoveToRallyPoint = this.shouldMoveToRallyPoint(bot, configuration, logger);
      logger.info(`Starting the post-spawn rally scenario. Movement required: ${shouldMoveToRallyPoint}.`);

      rallyNavigationPromise = Promise.resolve()
        .then(async () => {
          const ensureCurrentAttempt = () => {
            if (!isCurrentRallyNavigationAttempt(attempt)) {
              throw new RallyNavigationCancelledError();
            }
          };

          await publishEvent({
            type: 'bot.rally.started',
            payload: {
              username: configuration.username,
            },
          });
          ensureCurrentAttempt();

          if (shouldMoveToRallyPoint) {
            await this.moveToRallyPoint(
              bot,
              configuration,
              logger,
              () => isCurrentRallyNavigationAttempt(attempt),
            );
          } else {
            logger.info('Proceeding with the post-rally scenario without movement.');
          }
          ensureCurrentAttempt();

          await publishEvent({
            type: 'bot.rally.completed',
            payload: {
              username: configuration.username,
            },
          });
          ensureCurrentAttempt();

          await runPostRallyScenario(() => isCurrentRallyNavigationAttempt(attempt));
        })
        .catch((error) => {
          if (error instanceof RallyNavigationCancelledError || attempt !== rallyNavigationAttempt) {
            return;
          }

          if (this.isFriendlyMissingResourceError(error)) {
            logger.warn(this.stringifyError(error));
            return;
          }

          logger.error('Failed to complete the post-spawn rally scenario.', error);
        })
        .finally(() => {
          if (attempt === rallyNavigationAttempt) {
            rallyNavigationPromise = null;
          }
        });
    };

    bot._client.on('connect', () => {
      logger.info('TCP connection established.');
    });

    bot.on('inject_allowed', () => {
      configurePathfinder();
      this.connectedPathfinderBots.set(configuration.username, bot);
      logger.info('Mineflayer injection allowed.');
    });

    bot.on('login', () => {
      logger.info(`Bot logged in as "${configuration.username}".`);
    });

    bot.on('spawn', () => {
      spawnCount += 1;
      hasSpawned = true;
      logger.info(spawnCount === 1 ? 'Bot spawned in the world.' : 'Bot respawned in the world.');

      if (spawnCount > 1) {
        void publishEvent({
          type: 'bot.respawned',
          payload: {
            username: configuration.username,
          },
        }).catch((error) => {
          logger.warn(`Failed to publish the respawn event: ${this.stringifyError(error)}.`);
        });
      }

      if (isAuthenticated) {
        getAutoEatController().start();
        getNearbyDroppedItemCollector().start();
        getSquadDefenseController().start();
        startRallyNavigation(true);
      }
    });

    bot.on('death', () => {
      autoEatController?.stop();
      nearbyDroppedItemCollector?.stop();
      squadDefenseController?.stop();
      this.squadWeaponReadinessTracker.clearReady(configuration.username);
      void publishEvent({
        type: 'bot.died',
        payload: {
          username: configuration.username,
        },
      }).catch((error) => {
        logger.warn(`Failed to publish the death event: ${this.stringifyError(error)}.`);
      });
      cancelScenarios('bot died');
      logger.warn('Bot died. Rally navigation will restart after respawn.');
      stopRallyNavigation('bot died');
    });

    bot.on('chat', (username, message) => {
      if (username === configuration.username) {
        return;
      }

      logger.info(`[CHAT] ${username}: ${message}`);
    });

    bot.on('messagestr', (message) => {
      logger.info(`[SERVER] ${message}`);
    });

    bot._client.on('disconnect', (packet: { reason?: unknown }) => {
      bot._client._lastDisconnectReason = String(packet.reason ?? 'unknown disconnect reason');
      logger.warn(`Disconnect packet received: ${bot._client._lastDisconnectReason}`);
    });

    bot._client.on('login', () => {
      logger.info('Low-level login packet received.');
    });

    bot._client.on('success', () => {
      logger.info('Low-level login success packet received.');
      setTimeout(sendConfigurationSettings, 0);
      setTimeout(() => {
        if (bot._client.state !== 'configuration' || configurationFallbackTriggered) {
          return;
        }

        configurationFallbackTriggered = true;
        logger.warn(
          `Client is still in configuration after ${this.configurationFallbackDelayMs}ms. Sending fallback handshake packets.`,
        );
        this.tryWriteConfigurationPacket(bot, 'finish_configuration', logger);
        this.tryWriteConfigurationPacket(bot, 'accept_code_of_conduct', logger);
      }, this.configurationFallbackDelayMs);
    });

    bot._client.on('compress', () => {
      logger.info('Compression packet received.');
    });

    // bot._client.on('keep_alive', () => {
    //   logger.info(`Keep-alive packet received in state "${String(bot._client.state)}".`);
    // });

    // bot._client.on('registry_data', () => {
    //   logger.info('Registry data packet received.');
    // });

    bot._client.on('feature_flags', () => {
      logger.info('Feature flags packet received.');
    });

    bot._client.on('code_of_conduct', () => {
      logger.info('Code of conduct packet received.');
    });

    bot._client.on('show_dialog', () => {
      logger.info('Show dialog packet received.');
    });

    bot._client.on('finish_configuration', () => {
      logger.info('Finish configuration packet received.');
    });

    const stringEventBot = bot as unknown as StringEventBot;

    // stringEventBot.on('goal_reached', () => {
    //   logger.info('Pathfinder goal reached.');
    // });

    stringEventBot.on('path_reset', (reason) => {
      if (reason === 'chunk_loaded' || reason === 'stuck') {
        return;
      }

      logger.warn(`Pathfinder reset the path: ${reason}.`);
    });

    // stringEventBot.on('path_update', (...args) => {
    //   const [result] = args as [{ status: string; path: unknown[] }];
    //   logger.info(`Pathfinder update: ${result.status}, nodes=${result.path.length}.`);
    // });

    bot.on('end', (reason) => {
      autoEatController?.stop();
      this.connectedPathfinderBots.delete(configuration.username);
      nearbyDroppedItemCollector?.stop();
      squadDefenseController?.stop();
      this.squadWeaponReadinessTracker.clearReady(configuration.username);
      void publishEvent({
        type: 'bot.died',
        payload: {
          username: configuration.username,
        },
      }).catch(() => undefined);
      disposeEventBusSubscriptions();
      cancelScenarios('connection ended');
      logger.info(`Bot connection ended: ${reason ?? 'unknown reason'}`);
      scheduleReconnect(`connection ended: ${reason ?? 'unknown reason'}`);
    });

    bot.on('kicked', (reason) => {
      autoEatController?.stop();
      this.connectedPathfinderBots.delete(configuration.username);
      nearbyDroppedItemCollector?.stop();
      squadDefenseController?.stop();
      this.squadWeaponReadinessTracker.clearReady(configuration.username);
      void publishEvent({
        type: 'bot.died',
        payload: {
          username: configuration.username,
        },
      }).catch(() => undefined);
      disposeEventBusSubscriptions();
      cancelScenarios('bot was kicked');
      logger.error(`Bot was kicked: ${String(reason)}`);
      scheduleReconnect(`bot was kicked: ${this.stringifyError(reason)}`);
    });

    bot.on('error', (error) => {
      autoEatController?.stop();
      this.connectedPathfinderBots.delete(configuration.username);
      nearbyDroppedItemCollector?.stop();
      squadDefenseController?.stop();
      this.squadWeaponReadinessTracker.clearReady(configuration.username);
      void publishEvent({
        type: 'bot.died',
        payload: {
          username: configuration.username,
        },
      }).catch(() => undefined);
      disposeEventBusSubscriptions();
      cancelScenarios('client error');
      logger.error('Mineflayer client error.', error);
      scheduleReconnect(`client error: ${error.message}`);
    });

    try {
      await this.waitForLogin(bot, configuration);

      await authenticator.authenticate(bot, configuration);
      isAuthenticated = true;

      if (!hasSpawned) {
        await this.waitForSpawn(bot, configuration);
      }

      getAutoEatController().start();
      getNearbyDroppedItemCollector().start();
      getSquadDefenseController().start();

      if (configuration.rallyPoint) {
        startupCompleted = true;
        startRallyNavigation();
        return;
      }

      startupCompleted = true;
      await this.sendGreeting(bot, logger);
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('lightauth')) {
        logger.error('LightAuth authorization failed.', error);
      }

      await this.disconnectBot(bot, logger);
      throw error;
    }
  }

  private waitForLogin(bot: BotWithClient, configuration: BotConfiguration): Promise<void> {
    return new Promise((resolve, reject) => {
      if (bot._client.state === 'play') {
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Bot "${configuration.role}" login timed out after ${this.loginTimeoutMs}ms. Current state: ${String(bot._client.state)}.${this.formatDisconnectReason(bot)}`,
          ),
        );
      }, this.loginTimeoutMs);
      const intervalId = setInterval(() => {
        if (bot._client.state === 'play') {
          cleanup();
          resolve();
        }
      }, 100);

      const cleanup = () => {
        clearTimeout(timeoutId);
        clearInterval(intervalId);
      };
    });
  }

  private waitForSpawn(bot: BotWithClient, configuration: BotConfiguration): Promise<void> {
    return new Promise((resolve, reject) => {
      if (bot.entity) {
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Bot "${configuration.role}" spawn timed out after auth.${this.formatDisconnectReason(bot)}`,
          ),
        );
      }, this.spawnTimeoutMs);

      const intervalId = setInterval(() => {
        if (bot.entity) {
          cleanup();
          resolve();
        }
      }, 100);

      const cleanup = () => {
        clearTimeout(timeoutId);
        clearInterval(intervalId);
        bot.off('spawn', handleSpawn);
      };

      const handleSpawn = () => {
        cleanup();
        resolve();
      };

      bot.once('spawn', handleSpawn);
    });
  }

  private isRetryableConnectionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();

    return (
      message.includes('connection throttled') ||
      message.includes('please wait before reconnecting') ||
      message.includes('timed out') ||
      message.includes('econnreset') ||
      message.includes('socketclosed') ||
      message.includes('keepaliveerror') ||
      message.includes('client timed out') ||
      message.includes('write econnreset') ||
      message.includes('socket closed') ||
      message.includes('enotfound') ||
      message.includes('eai_again')
    );
  }

  private isRetryableRallyNavigationError(error: unknown): boolean {
    const message = this.stringifyError(error).toLowerCase();

    return (
      message.includes('no path to the goal') ||
      message.includes('timed out') ||
      message.includes('timeout waiting for') ||
      message.includes('took to long to decide path to goal') ||
      message.includes('stuck') ||
      message.includes('goal changed') ||
      message.includes('path was stopped') ||
      message.includes('path stopped') ||
      message.includes('goal was not actually reached')
    );
  }

  private formatDisconnectReason(bot: BotWithClient): string {
    if (!bot._client._lastDisconnectReason) {
      return '';
    }

    return ` Disconnect reason: ${bot._client._lastDisconnectReason}`;
  }

  private async sendGreeting(bot: BotWithClient, logger: Logger): Promise<void> {
    bot.chat('hi');
    logger.info('Sent chat message "hi".');

    const chatWasBlocked = await this.waitForChatBlockMessage(bot, 2000);

    if (!chatWasBlocked) {
      return;
    }

    logger.warn('Chat was blocked before movement. Walking briefly and retrying greeting.');
    await this.nudgeForward(bot);
    await this.delay(400);
    bot.chat('hi');
    logger.info('Retried chat message "hi" after movement.');
  }

  private async moveToRallyPoint(
    bot: BotWithClient,
    configuration: BotConfiguration,
    logger: Logger,
    isCurrentAttempt: () => boolean,
  ): Promise<void> {
    if (!bot.pathfinder) {
      throw new Error('Pathfinder plugin is not available on the bot instance.');
    }

    if (!bot.entity) {
      logger.warn('Skipping rally movement because the bot entity is not available.');
      return;
    }

    if (!configuration.rallyPoint) {
      logger.info('No rally point configured. Bot will stay at the spawn area.');
      return;
    }

    logger.info(
      `Heading to rally point ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z}.`,
    );

    const movements = this.createRallyMovements(bot);
    let progressDeadline = Date.now() + this.rallyTimeoutMs;

    if (this.rallyStabilizationTicks > 0) {
      await bot.waitForTicks(this.rallyStabilizationTicks);
      this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
    }

    while (true) {
      this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
      bot.pathfinder.setMovements(movements);

      try {
        await this.waitForChunksForRally(bot, logger);
        this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);

        const attemptTimeoutMs = this.rallySingleAttemptTimeoutMs;
        const goal = this.createNextRallyGoal(bot, configuration);

        await Promise.race([
          bot.pathfinder.goto(goal),
          this.failAfter(
            attemptTimeoutMs,
            `Timed out after ${attemptTimeoutMs}ms while building or following a route to ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z}.`,
          ),
        ]);
        this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);

        if (!bot.entity) {
          throw new Error('Bot entity is unavailable after pathfinding completed.');
        }

        const distanceToGoal = this.calculateDistanceToGoal(bot, configuration);

        if (distanceToGoal > this.rallyGoalRange + 1.5) {
          throw new Error(
            `Goal was not actually reached. Remaining distance: ${distanceToGoal.toFixed(2)} blocks.`,
          );
        }

        logger.info(
          `Reached rally point at ${bot.entity.position.x.toFixed(2)} ${bot.entity.position.y.toFixed(2)} ${bot.entity.position.z.toFixed(2)}.`,
        );
        return;
      } catch (error) {
        if (error instanceof RallyNavigationCancelledError) {
          throw error;
        }

        if (!isCurrentAttempt()) {
          throw new RallyNavigationCancelledError();
        }

        if (!this.isRetryableRallyNavigationError(error)) {
          throw error;
        }

        if (await this.tryEnterRallyPointThroughNearbyDoor(bot, configuration, logger, isCurrentAttempt)) {
          const distanceToGoal = this.calculateDistanceToGoal(bot, configuration);

          if (distanceToGoal <= this.rallyGoalRange + 1.5) {
            logger.info(
              `Reached rally point at ${bot.entity.position.x.toFixed(2)} ${bot.entity.position.y.toFixed(2)} ${bot.entity.position.z.toFixed(2)}.`,
            );
            return;
          }
        }

        if (Date.now() + this.rallyRetryDelayMs >= progressDeadline) {
          logger.info(
            `Я еще иду к точке сбора ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z}. Продолжаю искать путь: ${this.stringifyError(error)}.`,
          );
          progressDeadline = Date.now() + this.rallyTimeoutMs;
        } else {
          logger.warn(
            `Could not reach the rally point yet. Retrying in ${this.rallyRetryDelayMs}ms: ${this.stringifyError(error)}.`,
          );
        }

        await this.delay(this.rallyRetryDelayMs);
        this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
      } finally {
        bot.pathfinder.stop();
      }
    }
  }

  private async tryEnterRallyPointThroughNearbyDoor(
    bot: BotWithClient,
    configuration: BotConfiguration,
    logger: Logger,
    isCurrentAttempt: () => boolean,
  ): Promise<boolean> {
    if (!configuration.rallyPoint || !bot.entity || !bot.pathfinder) {
      return false;
    }

    const distanceToGoal = this.calculateDistanceToGoal(bot, configuration);

    if (distanceToGoal > this.rallyMinDistanceToMove + 1) {
      return false;
    }

    const nearbyDoor = this.findNearestDoorNearRallyPoint(bot, configuration);

    if (!nearbyDoor) {
      return false;
    }

    const rallyPoint = configuration.rallyPoint;
    const xDistanceToRally = rallyPoint.x - nearbyDoor.position.x;
    const zDistanceToRally = rallyPoint.z - nearbyDoor.position.z;
    const moveAlongX = Math.abs(xDistanceToRally) >= Math.abs(zDistanceToRally);
    const step = moveAlongX
      ? new Vec3(Math.sign(xDistanceToRally) || 1, 0, 0)
      : new Vec3(0, 0, Math.sign(zDistanceToRally) || 1);
    const interiorTarget = new Vec3(
      nearbyDoor.position.x + step.x * 2,
      configuration.rallyPoint.y,
      nearbyDoor.position.z + step.z * 2,
    );
    const distanceBeforeDoorAssist = this.calculateDistanceToGoal(bot, configuration);

    try {
      this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
      await this.gotoPosition(bot as BotWithPathfinder, nearbyDoor.position, 1);
      this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);

      await this.openDoorIfNeeded(bot, nearbyDoor);

      this.assertCurrentRallyNavigationAttempt(isCurrentAttempt);
      await this.stepTowardsTarget(bot, interiorTarget, 10);
      await this.gotoPosition(bot as BotWithPathfinder, interiorTarget, 1).catch(() => undefined);
      const distanceAfterDoorAssist = this.calculateDistanceToGoal(bot, configuration);

      if (
        distanceAfterDoorAssist > this.rallyGoalRange + 1.5 &&
        distanceAfterDoorAssist >= distanceBeforeDoorAssist - 0.5
      ) {
        return false;
      }

      logger.info(
        `Entered the shelter through a nearby door at ${nearbyDoor.position.x} ${nearbyDoor.position.y} ${nearbyDoor.position.z} while approaching the rally point.`,
      );
      return true;
    } catch (error) {
      if (error instanceof RallyNavigationCancelledError) {
        throw error;
      }

      logger.info(
        `Could not use a nearby door to enter the rally point shelter yet: ${this.stringifyError(error)}.`,
      );
      return false;
    }
  }

  private async waitForChunksForRally(bot: BotWithClient, logger: Logger): Promise<void> {
    try {
      await bot.waitForChunksToLoad();
    } catch (error) {
      logger.warn(
        `Chunks are still loading near the route. Continuing with the currently available world data: ${this.stringifyError(error)}.`,
      );
    }
  }

  private calculateDistanceToGoal(bot: BotWithClient, configuration: BotConfiguration): number {
    if (!bot.entity || !configuration.rallyPoint) {
      return Number.POSITIVE_INFINITY;
    }

    const dx = bot.entity.position.x - configuration.rallyPoint.x;
    const dy = bot.entity.position.y - configuration.rallyPoint.y;
    const dz = bot.entity.position.z - configuration.rallyPoint.z;

    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private calculateHorizontalDistanceToGoal(bot: BotWithClient, configuration: BotConfiguration): number {
    if (!bot.entity || !configuration.rallyPoint) {
      return Number.POSITIVE_INFINITY;
    }

    const dx = bot.entity.position.x - configuration.rallyPoint.x;
    const dz = bot.entity.position.z - configuration.rallyPoint.z;

    return Math.sqrt(dx * dx + dz * dz);
  }

  private findNearestDoorNearRallyPoint(bot: BotWithClient, configuration: BotConfiguration): Block | null {
    if (!configuration.rallyPoint || !bot.entity) {
      return null;
    }

    const rallyCenter = new Vec3(configuration.rallyPoint.x, configuration.rallyPoint.y, configuration.rallyPoint.z);
    let nearestDoor: Block | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let dx = -this.rallyDoorSearchRadius; dx <= this.rallyDoorSearchRadius; dx += 1) {
      for (let dy = -1; dy <= 2; dy += 1) {
        for (let dz = -this.rallyDoorSearchRadius; dz <= this.rallyDoorSearchRadius; dz += 1) {
          const candidate = bot.blockAt(rallyCenter.offset(dx, dy, dz));

          if (!candidate || !this.isDoorBlock(candidate.name)) {
            continue;
          }

          const normalizedDoor = this.normalizeDoorBlock(bot, candidate);

          if (!normalizedDoor) {
            continue;
          }

          const distanceToBot = bot.entity.position.distanceTo(normalizedDoor.position);

          if (distanceToBot >= nearestDistance) {
            continue;
          }

          nearestDistance = distanceToBot;
          nearestDoor = normalizedDoor;
        }
      }
    }

    return nearestDoor;
  }

  private normalizeDoorBlock(bot: BotWithClient, block: Block): Block | null {
    if (!this.isDoorBlock(block.name)) {
      return null;
    }

    const doorProperties = block.getProperties();

    if (doorProperties.half === 'upper') {
      const lowerDoorBlock = bot.blockAt(block.position.offset(0, -1, 0));

      if (lowerDoorBlock && this.isDoorBlock(lowerDoorBlock.name)) {
        return lowerDoorBlock;
      }
    }

    return block;
  }

  private isDoorBlock(blockName: string): boolean {
    return blockName.endsWith('_door');
  }

  private isDoorOpen(block: Block): boolean {
    return block.getProperties().open === true;
  }

  private async openDoorIfNeeded(bot: BotWithClient, doorBlock: Block): Promise<void> {
    const normalizedDoor = this.normalizeDoorBlock(bot, doorBlock) ?? doorBlock;

    if (!this.isDoorOpen(normalizedDoor)) {
      await bot.lookAt(normalizedDoor.position.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
      await bot.activateBlock(normalizedDoor).catch(() => undefined);
      await bot.waitForTicks(10);
    }

    const refreshedDoor = this.normalizeDoorBlock(bot, bot.blockAt(normalizedDoor.position) ?? normalizedDoor);

    if (refreshedDoor && this.isDoorOpen(refreshedDoor)) {
      return;
    }

    const upperDoorBlock = bot.blockAt(normalizedDoor.position.offset(0, 1, 0));

    if (upperDoorBlock && this.isDoorBlock(upperDoorBlock.name)) {
      await bot.lookAt(upperDoorBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
      await bot.activateBlock(upperDoorBlock).catch(() => undefined);
      await bot.waitForTicks(10);
    }
  }

  private async stepTowardsTarget(bot: BotWithClient, target: Vec3, ticks: number): Promise<void> {
    await bot.lookAt(target.offset(0.5, 0, 0.5), true).catch(() => undefined);
    bot.setControlState('forward', true);

    try {
      await bot.waitForTicks(ticks);
    } finally {
      bot.setControlState('forward', false);
    }
  }

  private assertCurrentRallyNavigationAttempt(isCurrentAttempt: () => boolean): void {
    if (!isCurrentAttempt()) {
      throw new RallyNavigationCancelledError();
    }
  }

  private createNextRallyGoal(bot: BotWithClient, configuration: BotConfiguration): unknown {
    if (!bot.entity || !configuration.rallyPoint) {
      throw new Error('Cannot build a rally goal without an entity and rally point.');
    }

    const currentPosition = bot.entity.position;
    const target = configuration.rallyPoint;
    const horizontalDistance = this.calculateHorizontalDistanceToGoal(bot, configuration);

    if (horizontalDistance <= this.rallyStepDistance) {
      return new GoalNear(target.x, target.y, target.z, this.rallyGoalRange);
    }

    const ratio = this.rallyStepDistance / horizontalDistance;
    const stepX = currentPosition.x + (target.x - currentPosition.x) * ratio;
    const stepZ = currentPosition.z + (target.z - currentPosition.z) * ratio;

    return new GoalNearXZ(
      Math.round(stepX),
      Math.round(stepZ),
      this.rallyHorizontalGoalRange,
    );
  }

  private shouldMoveToRallyPoint(
    bot: BotWithClient,
    configuration: BotConfiguration,
    logger: Logger,
  ): boolean {
    if (!configuration.rallyPoint) {
      return false;
    }

    const distanceToGoal = this.calculateDistanceToGoal(bot, configuration);

    if (distanceToGoal > this.rallyMinDistanceToMove) {
      return true;
    }

    logger.info(
      `Bot is already within ${this.rallyMinDistanceToMove} blocks of the rally point (${distanceToGoal.toFixed(2)}). Skipping movement.`,
    );
    return false;
  }

  private waitForChatBlockMessage(bot: BotWithClient, timeoutMs: number): Promise<boolean> {
    const patterns = [
      'РЅСѓР¶РЅРѕ РЅРµРјРЅРѕРіРѕ РїСЂРѕР№С‚РёСЃСЊ',
      'РЅРµ РјРѕР¶РµС‚Рµ РІС‹РїРѕР»РЅРёС‚СЊ СЌС‚Рѕ РґРµР№СЃС‚РІРёРµ',
      'РЅРµ РјРѕР¶РµС‚Рµ РїРёСЃР°С‚СЊ РІ С‡Р°С‚',
      'muted pre-movement chat',
      'need to walk',
    ];

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const handler = (message: string) => {
        const normalized = message.replace(/\u00A7./g, '').trim().toLowerCase();

        if (!patterns.some((pattern) => normalized.includes(pattern))) {
          return;
        }

        cleanup();
        resolve(true);
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        bot.off('messagestr', handler);
      };

      bot.on('messagestr', handler);
    });
  }

  private async nudgeForward(bot: BotWithClient): Promise<void> {
    if (!bot.entity) {
      return;
    }

    const start = bot.entity.position.clone();
    const yaw = bot.entity.yaw;
    const stepDistance = 0.3;
    const movedPosition = start.offset(-Math.sin(yaw) * stepDistance, 0, -Math.cos(yaw) * stepDistance);

    this.sendPositionPacket(bot, movedPosition, true);
    await this.delay(300);
    this.sendPositionPacket(bot, start, true);
  }

  private sendPositionPacket(bot: BotWithClient, position: { x: number; y: number; z: number }, onGround: boolean): void {
    bot._client.write('position', {
      x: position.x,
      y: position.y,
      z: position.z,
      onGround,
      flags: {
        onGround,
        hasHorizontalCollision: undefined,
      },
    });
  }

  private createRallyMovements(bot: BotWithClient): PathfinderMovements {
    if (!bot.pathfinder) {
      throw new Error('Pathfinder plugin is not available while creating rally movements.');
    }

    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.canOpenDoors = true;
    movements.maxDropDown = 4;
    return movements;
  }

  private async requestFriendlyBotsToClearPosition(
    requestingUsername: string,
    position: Vec3,
    minimumDistance: number,
    logger: Logger,
  ): Promise<void> {
    for (const [username, bot] of this.connectedPathfinderBots.entries()) {
      if (username === requestingUsername || !this.isFriendlyBotBlockingPosition(bot, position)) {
        continue;
      }

      const clearanceTarget = this.findFriendlyClearanceTarget(bot, position, minimumDistance);

      if (!clearanceTarget) {
        logger.warn(
          `Could not find a safe nearby point to clear "${username}" away from ${position.x} ${position.y} ${position.z}.`,
        );
        continue;
      }

      logger.info(
        `Asking "${username}" to clear the build position at ${position.x} ${position.y} ${position.z}.`,
      );

      try {
        await this.gotoPosition(this.requirePathfinderBot(bot), clearanceTarget, 1);
      } catch (error) {
        logger.warn(
          `Could not move "${username}" away from the build position: ${this.stringifyError(error)}.`,
        );
      }
    }
  }

  private isFriendlyBotBlockingPosition(bot: BotWithClient, position: Vec3): boolean {
    if (!bot.entity) {
      return false;
    }

    const entityPosition = bot.entity.position;
    const targetCenter = position.offset(0.5, 0.5, 0.5);

    return (
      Math.abs(entityPosition.y - position.y) < 2 &&
      entityPosition.distanceTo(targetCenter) < 0.95
    );
  }

  private findFriendlyClearanceTarget(
    bot: BotWithClient,
    blockedPosition: Vec3,
    minimumDistance: number,
  ): Vec3 | null {
    if (!bot.entity) {
      return null;
    }

    const candidateOffsets = [
      new Vec3(minimumDistance, 0, 0),
      new Vec3(-minimumDistance, 0, 0),
      new Vec3(0, 0, minimumDistance),
      new Vec3(0, 0, -minimumDistance),
      new Vec3(minimumDistance + 1, 0, 0),
      new Vec3(-minimumDistance - 1, 0, 0),
      new Vec3(0, 0, minimumDistance + 1),
      new Vec3(0, 0, -minimumDistance - 1),
    ];
    const botY = Math.floor(bot.entity.position.y);

    const candidates = candidateOffsets
      .map((offset) => new Vec3(blockedPosition.x + offset.x, botY, blockedPosition.z + offset.z))
      .filter((candidate) => !this.isFriendlyPositionOccupied(candidate, bot.username));

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort(
      (left, right) =>
        bot.entity!.position.distanceTo(left) - bot.entity!.position.distanceTo(right),
    );

    return candidates[0] ?? null;
  }

  private isFriendlyPositionOccupied(position: Vec3, ignoredUsername: string): boolean {
    for (const [username, bot] of this.connectedPathfinderBots.entries()) {
      if (username === ignoredUsername || !bot.entity) {
        continue;
      }

      const targetCenter = position.offset(0.5, 0.5, 0.5);

      if (Math.abs(bot.entity.position.y - position.y) < 2 && bot.entity.position.distanceTo(targetCenter) < 0.95) {
        return true;
      }
    }

    return false;
  }

  private async gotoPosition(bot: BotWithPathfinder, target: { x: number; y: number; z: number }, range: number): Promise<void> {
    bot.pathfinder.setMovements(this.createRallyMovements(bot));
    await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, range));
    bot.pathfinder.stop();
  }

  private requirePathfinderBot(bot: BotWithClient): BotWithPathfinder {
    if (!bot.pathfinder) {
      throw new Error('Pathfinder plugin is not available on the bot instance.');
    }

    return bot as BotWithPathfinder;
  }

  private getBotKey(configuration: BotConfiguration): string {
    return `${configuration.role}:${configuration.username}`;
  }

  private clearReconnectTimer(botKey: string): void {
    const timer = this.reconnectTimers.get(botKey);

    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.reconnectTimers.delete(botKey);
  }

  private scheduleReconnect(configuration: BotConfiguration, logger: Logger, reason: string): void {
    const botKey = this.getBotKey(configuration);

    if (!this.supervisedBots.has(botKey) || this.reconnectTimers.has(botKey) || this.reconnectingBots.has(botKey)) {
      return;
    }

    logger.warn(
      `Bot "${configuration.username}" will reconnect in ${this.reconnectDelayMs}ms because ${reason}.`,
    );

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(botKey);
      this.reconnectingBots.add(botKey);

      void this.connectWithRetries(configuration, true)
        .catch((error) => {
          logger.error(`Reconnect attempt failed for "${configuration.username}".`, error);
          this.scheduleReconnect(configuration, logger, 'the previous reconnect attempt failed');
        })
        .finally(() => {
          this.reconnectingBots.delete(botKey);
        });
    }, this.reconnectDelayMs);

    this.reconnectTimers.set(botKey, timer);
  }

  private tryWriteConfigurationPacket(
    bot: BotWithClient,
    packetName: 'finish_configuration' | 'accept_code_of_conduct',
    logger: Logger,
  ): void {
    try {
      bot._client.write(packetName, {});
      logger.info(`Fallback packet sent: ${packetName}.`);
    } catch (error) {
      logger.warn(
        `Failed to send fallback packet "${packetName}" while in state "${String(bot._client.state)}": ${this.stringifyError(error)}`,
      );
    }
  }

  private parseInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return parsed;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async failAfter(timeoutMs: number, message: string): Promise<never> {
    await this.delay(timeoutMs);
    throw new Error(message);
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private isFriendlyMissingResourceError(error: unknown): boolean {
    return this.stringifyError(error).startsWith('Ой, не могу найти ');
  }

  private async disconnectBot(bot: BotWithClient, logger: Logger): Promise<void> {
    if (bot._client.ended || bot._client.socket.destroyed) {
      return;
    }

    logger.info('Disconnecting bot after failed startup attempt.');

    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, 2000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        bot.off('end', handleEnd);
      };

      const handleEnd = () => {
        cleanup();
        resolve();
      };

      bot.once('end', handleEnd);
      bot.end();
    });
  }
}
