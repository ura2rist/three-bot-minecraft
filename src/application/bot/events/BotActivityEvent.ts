import { ApplicationEvent } from '../../shared/events/EventBus';

export type BotTaskName = 'rally' | 'escort' | 'resource_gathering' | 'microbase_setup';

export type BotActivityEvent =
  | ApplicationEvent<'bot.rally.started', { username: string }>
  | ApplicationEvent<'bot.rally.completed', { username: string }>
  | ApplicationEvent<'bot.respawned', { username: string }>
  | ApplicationEvent<'bot.died', { username: string }>
  | ApplicationEvent<'bot.task.started', { username: string; task: BotTaskName }>
  | ApplicationEvent<'bot.task.completed', { username: string; task: BotTaskName }>
  | ApplicationEvent<'bot.threat.engaged', { username: string; threatName: string }>
  | ApplicationEvent<'bot.threat.resolved', { username: string; threatName: string }>;
