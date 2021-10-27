import { MainLogger } from './logger.interface';

export interface BotOptions {
  instagramBaseUrl: string;
  cookiesPath: string;

  username: string;
  password: string;
  enableCookies: boolean;

  randomizeUserAgent: boolean;
  userAgent: string;

  maxFollowsPerHour: number;
  maxFollowsPerDay: number;

  maxLikesPerDay: number;

  followUserRatioMin: number;
  followUserRatioMax: number;
  followUserMaxFollowers : number;
  followUserMaxFollowing : number;
  followUserMinFollowers : number;
  followUserMinFollowing : number;

  dontUnfollowUntilTimeElapsed: number

  excludeUsers: string[];

  dryRun:boolean

  screenshotOnError: boolean
  screenshotsPath: string

  logger: MainLogger
}