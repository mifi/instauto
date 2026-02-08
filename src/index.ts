import assert from 'node:assert';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import UserAgent from 'user-agents';
import type { ElementHandle, Page, WaitForSelectorOptions } from 'puppeteer';
import { type FollowedUser, type JSONDBInstance } from './db.ts'; // eslint-disable-line import/extensions


type Logger = Pick<Console, 'log' | 'info' | 'debug' | 'error' | 'trace' | 'warn'>;

declare global {
  // override window:
  interface Window {
    instautoSleep: (ms: number) => Promise<void>,
    instautoLog: (...args: unknown[]) => void
    instautoOnImageLiked: (href: string) => void
    _sharedData?: { config?: { viewer?: { username?: string } } };
  }
}

type LikeMediaType = 'image' | 'video' | 'unknown';

interface LikeMediaData {
  mediaType: LikeMediaType;
  mediaDesc: string;
  src?: string | undefined;
  alt?: string | undefined;
  poster?: string | undefined;
}

type ShouldLikeMedia = (data: LikeMediaData) => boolean;

interface ShouldFollowUserData {
  username: string;
  isVerified: boolean;
  isBusinessAccount: boolean;
  isProfessionalAccount: boolean;
  fullName: string;
  biography: string;
  profilePicUrlHd: string;
  externalUrl: string | null;
  businessCategoryName: string | null;
  categoryName: string | null;
}

type ShouldFollowUser = (data: ShouldFollowUserData) => boolean;

export interface InstautoOptions {
  instagramBaseUrl?: string;
  cookiesPath: string;
  username?: string;
  password?: string;
  enableCookies?: boolean;
  randomizeUserAgent?: boolean;
  userAgent?: string;
  maxFollowsPerHour?: number;
  maxFollowsPerDay?: number;
  maxLikesPerDay?: number;
  followUserRatioMin?: number;
  followUserRatioMax?: number;
  followUserMaxFollowers?: number | null;
  followUserMaxFollowing?: number | null;
  followUserMinFollowers?: number | null;
  followUserMinFollowing?: number | null;
  shouldFollowUser?: ShouldFollowUser | null;
  shouldLikeMedia?: ShouldLikeMedia | null;
  dontUnfollowUntilTimeElapsed?: number;
  excludeUsers?: string[];
  dryRun?: boolean;
  screenshotOnError?: boolean;
  screenshotsPath?: string;
  logger?: Logger;
}

interface LikeUserImagesOptions {
  username?: string | undefined;
  likeImagesMin?: number | undefined;
  likeImagesMax?: number | undefined;
}

interface ProcessUserFollowersOptions {
  maxFollowsPerUser?: number | undefined;
  skipPrivate?: boolean | undefined;
  enableLikeImages?: boolean | undefined;
  likeImagesMin?: number | undefined;
  likeImagesMax?: number | undefined;
}

interface ProcessUsersFollowersOptions {
  usersToFollowFollowersOf: string[];
  maxFollowsTotal?: number | undefined;
  skipPrivate?: boolean | undefined;
  enableFollow?: boolean | undefined;
  enableLikeImages?: boolean | undefined;
  likeImagesMin?: number | undefined;
  likeImagesMax?: number | undefined;
}

interface UnfollowOptions {
  limit?: number | undefined;
}

interface UnfollowOldOptions {
  ageInDays?: number | undefined;
  limit?: number | undefined;
}

interface FollowUserRestrictions {
  username: string;
  skipPrivate?: boolean | undefined;
}

interface SafelyFollowUserListOptions {
  users: string[];
  skipPrivate?: boolean | undefined;
  limit?: number | undefined;
}

interface GraphqlPageInfo { end_cursor: string | null; has_next_page: boolean }
interface GraphqlEdge { node: { username: string } }
interface GraphqlUserList { edges: GraphqlEdge[]; page_info: GraphqlPageInfo }

interface GraphqlJson {
  data: {
    user?: {
      edge_followed_by?: GraphqlUserList;
      edge_follow?: GraphqlUserList;
    };
    shortcode_media?: {
      edge_liked_by?: GraphqlUserList;
    };
  };
}

interface GraphqlVariables {
  first?: number;
  after?: string | null;
  [key: string]: string | number | boolean | null | undefined;
}

interface GraphqlQueryUsersOptions {
  queryHash: string;
  getResponseProp: (json: GraphqlJson) => GraphqlUserList | undefined;
  graphqlVariables: GraphqlVariables;
}

interface InstagramUser {
  id: string;
  username?: string;
  edge_followed_by: { count: number };
  edge_follow: { count: number };
  is_private: boolean;
  is_verified: boolean;
  is_business_account: boolean;
  is_professional_account: boolean;
  full_name: string;
  biography: string;
  profile_pic_url_hd: string;
  external_url: string | null;
  business_category_name: string | null;
  category_name: string | null;
}

export interface InstautoApi {
  init: () => Promise<void>;
  followUserFollowers: (username: string, options?: ProcessUserFollowersOptions) => Promise<void>;
  unfollowNonMutualFollowers: (options?: UnfollowOptions) => Promise<number>;
  unfollowAllUnknown: (options?: UnfollowOptions) => Promise<number>;
  unfollowOldFollowed: (options: UnfollowOldOptions) => Promise<number>;
  followUser: (username: string) => Promise<void>;
  unfollowUser: (username: string) => Promise<FollowedUser>;
  likeUserImages: (options?: LikeUserImagesOptions) => Promise<void>;
  sleep: (ms: number, deviation?: number) => Promise<void>;
  listManuallyFollowedUsers: () => Promise<string[]>;
  getFollowersOrFollowing: (options: { userId: string; getFollowers?: boolean }) => Promise<string[]>;
  getUsersWhoLikedContent: (options: { contentId: string }) => AsyncGenerator<string[], string[], void>;
  safelyUnfollowUserList: (usersToUnfollow: AsyncIterable<string | string[]> | Iterable<string | string[]>, limit?: number, condition?: (username: string) => boolean | Promise<boolean>) => Promise<number>;
  safelyFollowUserList: (options: SafelyFollowUserListOptions) => Promise<void>;
  followUsersFollowers: (options: ProcessUsersFollowersOptions) => Promise<void>;
  doesUserFollowMe: (username: string) => Promise<boolean | undefined>;
  navigateToUserAndGetData: (username: string) => Promise<InstagramUser | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInstagramUser(value: unknown): value is InstagramUser {
  if (!isRecord(value)) return false;
  const { id, edge_followed_by: edgeFollowedBy, edge_follow: edgeFollow, is_private: isPrivate, is_verified: isVerified } = value;
  return typeof id === 'string'
    && isRecord(edgeFollowedBy)
    && isRecord(edgeFollow)
    && typeof isPrivate === 'boolean'
    && typeof isVerified === 'boolean';
}

// NOTE duplicated inside puppeteer page
function shuffleArray<T>(arrayIn: T[]): T[] {
  const array = [...arrayIn];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = array[i];
    if (temp === undefined || array[j] === undefined) {
      throw new Error('Invalid shuffle index');
    }
    array[i] = array[j]; // eslint-disable-line no-param-reassign
    array[j] = temp; // eslint-disable-line no-param-reassign
  }
  return array;
}

// https://stackoverflow.com/questions/14822153/escape-single-quote-in-xpath-with-nokogiri
// example str: "That's mine", he said.
function escapeXpathStr(str: string): string {
  const parts = str.split("'").map((token: string) => `'${token}'`);
  if (parts.length === 1) return `${parts[0]}`;
  const str2 = parts.join(', "\'", ');
  return `concat(${str2})`;
}

const botWorkShiftHours = 16;

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

function Instauto(db: JSONDBInstance, page: Page, options: InstautoOptions): InstautoApi {
  const {
    instagramBaseUrl = 'https://www.instagram.com',
    cookiesPath,

    username: myUsernameIn,
    password,
    enableCookies = true,

    randomizeUserAgent = true,
    userAgent,

    maxFollowsPerHour = 20,
    maxFollowsPerDay = 150,

    maxLikesPerDay = 50,

    followUserRatioMin = 0.2,
    followUserRatioMax = 4,
    followUserMaxFollowers = null,
    followUserMaxFollowing = null,
    followUserMinFollowers = null,
    followUserMinFollowing = null,

    shouldFollowUser = null,
    shouldLikeMedia = null,

    dontUnfollowUntilTimeElapsed = 3 * 24 * 60 * 60 * 1000,

    excludeUsers = [],

    dryRun = true,

    screenshotOnError = false,
    screenshotsPath = '.',

    logger = console,
  } = options;

  let myUsername = myUsernameIn;
  const userDataCache: Record<string, InstagramUser> = {};

  assert(cookiesPath);
  assert(db);

  assert(maxFollowsPerHour * botWorkShiftHours >= maxFollowsPerDay, 'Max follows per hour too low compared to max follows per day');

  const {
    addPrevFollowedUser, getPrevFollowedUser, addPrevUnfollowedUser, getLikedPhotosLastTimeUnit,
    getPrevUnfollowedUsers, getPrevFollowedUsers, addLikedPhoto,
  } = db;

  const getNumLikesThisTimeUnit = (time: number) => getLikedPhotosLastTimeUnit(time).length;

  // State
  let myUserId: string | undefined;

  async function takeScreenshot() {
    if (!screenshotOnError) return;
    try {
      const fileName = `${Date.now()}.jpg`;
      logger.log('Taking screenshot', fileName);
      await page.screenshot({ path: join(screenshotsPath, fileName), type: 'jpeg', quality: 30 });
    } catch (err) {
      logger.error('Failed to take screenshot', err);
    }
  }

  async function tryLoadCookies() {
    try {
      const cookies = JSON.parse(await readFile(cookiesPath, 'utf8'));
      for (const cookie of cookies) {
        if (cookie.name !== 'ig_lang') await page.setCookie(cookie);
      }
    } catch {
      logger.error('No cookies found');
    }
  }

  async function trySaveCookies() {
    try {
      logger.log('Saving cookies');
      const cookies = await page.cookies();

      await writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
    } catch {
      logger.error('Failed to save cookies');
    }
  }

  async function tryDeleteCookies() {
    try {
      logger.log('Deleting cookies');
      await unlink(cookiesPath);
    } catch {
      logger.error('No cookies to delete');
    }
  }

  const sleepFixed = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const sleep = (ms: number, deviation = 1) => {
    let msWithDev = ((Math.random() * deviation) + 1) * ms;
    if (dryRun) msWithDev = Math.min(3000, msWithDev); // for dryRun, no need to wait so long
    logger.log('Waiting', (msWithDev / 1000).toFixed(2), 'sec');
    return sleepFixed(msWithDev);
  };

  async function onImageLiked({ username, href }: { username: string; href: string }) {
    await addLikedPhoto({ username, href, time: Date.now() });
  }

  function getNumFollowedUsersThisTimeUnit(timeUnit: number) {
    const now = Date.now();

    return getPrevFollowedUsers().filter((u) => now - u.time < timeUnit).length
      + getPrevUnfollowedUsers().filter((u) => !u.noActionTaken && now - u.time < timeUnit).length;
  }

  async function checkReachedFollowedUserDayLimit() {
    if (getNumFollowedUsersThisTimeUnit(dayMs) >= maxFollowsPerDay) {
      logger.log('Have reached daily follow/unfollow limit, waiting 10 min');
      await sleep(10 * 60 * 1000);
    }
  }

  async function checkReachedFollowedUserHourLimit() {
    if (getNumFollowedUsersThisTimeUnit(hourMs) >= maxFollowsPerHour) {
      logger.log('Have reached hourly follow rate limit, pausing 10 min');
      await sleep(10 * 60 * 1000);
    }
  }

  async function checkReachedLikedUserDayLimit() {
    if (getNumLikesThisTimeUnit(dayMs) >= maxLikesPerDay) {
      logger.log('Have reached daily like rate limit, pausing 10 min');
      await sleep(10 * 60 * 1000);
    }
  }

  async function throttle() {
    await checkReachedFollowedUserDayLimit();
    await checkReachedFollowedUserHourLimit();
    await checkReachedLikedUserDayLimit();
  }

  function haveRecentlyFollowedUser(username: string) {
    const followedUserEntry = getPrevFollowedUser(username);
    if (!followedUserEntry) return false; // We did not previously follow this user, so don't know
    return Date.now() - followedUserEntry.time < dontUnfollowUntilTimeElapsed;
  }

  // See https://github.com/mifi/SimpleInstaBot/issues/140#issuecomment-1149105387
  const gotoUrl = async (url: string) => page.goto(url, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'] });

  async function gotoWithRetry(url: string) {
    const maxAttempts = 3;
    for (let attempt = 0; ; attempt += 1) {
      logger.log(`Goto ${url}`);
      const response = await gotoUrl(url);
      if (!response) throw new Error('Navigation did not return a response');
      const status = response.status();
      logger.log('Page loaded');
      await sleep(2000);

      // https://www.reddit.com/r/Instagram/comments/kwrt0s/error_560/
      // https://github.com/mifi/instauto/issues/60
      if (![560, 429].includes(status)) return status;

      if (attempt > maxAttempts) {
        throw new Error(`Navigate to user failed after ${maxAttempts} attempts, last status: ${status}`);
      }

      logger.info(`Got ${status} - Retrying request later...`);
      if (status === 429) logger.warn('429 Too Many Requests could mean that Instagram suspects you\'re using a bot. You could try to use the Instagram Mobile app from the same IP for a few days first');
      await sleep((attempt + 1) * 30 * 60 * 1000);
    }
  }

  const getUserPageUrl = (username: string) => `${instagramBaseUrl}/${encodeURIComponent(username)}`;

  function isAlreadyOnUserPage(username: string) {
    const url = getUserPageUrl(username);
    // optimization: already on URL? (ignore trailing slash)
    return (page.url().replace(/\/$/, '') === url.replace(/\/$/, ''));
  }

  // How to test xpaths in the browser:
  // document.evaluate("your xpath", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null ).singleNodeValue
  async function getXpathElement(xpath: string, opts?: WaitForSelectorOptions): Promise<ElementHandle | null> {
    try {
      return await page.waitForSelector(`::-p-xpath(${xpath})`, opts);
    } catch {
      logger.debug(`Element not found for xpath: ${xpath}`);
      return null;
    }
  }

  async function navigateToUser(username: string) {
    if (isAlreadyOnUserPage(username)) return true;

    // logger.log('navigating from', page.url(), 'to', url);
    logger.log(`Navigating to user ${username}`);

    const url = getUserPageUrl(username);
    const status = await gotoWithRetry(url);
    if (status === 404) {
      logger.warn('User page returned 404');
      return false;
    }

    if (status === 200) {
      // logger.log('Page returned 200 ☑️');
      // some pages return 200 but nothing there (I think deleted accounts)
      // https://github.com/mifi/SimpleInstaBot/issues/48
      // example: https://www.instagram.com/victorialarson__/
      // so we check if the page has the user's name on it
      const elementHandle = await getXpathElement(`//body//main//*[contains(text(),${escapeXpathStr(username)})]`, { timeout: 1000 });
      const foundUsernameOnPage = elementHandle != null;
      if (!foundUsernameOnPage) logger.warn(`Cannot find text "${username}" on page`);
      return foundUsernameOnPage;
    }

    throw new Error(`Navigate to user failed with status ${status}`);
  }

  async function navigateToUserWithCheck(username: string) {
    if (!(await navigateToUser(username))) throw new Error('User not found');
  }

  async function navigateToUserAndGetData(username: string): Promise<InstagramUser | undefined> {
    const cachedUserData = userDataCache[username];

    if (isAlreadyOnUserPage(username) && cachedUserData) {
      // assume we have data
      return cachedUserData;
    }

    if (cachedUserData != null) {
      // if we already have userData, just navigate
      await navigateToUserWithCheck(username);
      return cachedUserData;
    }

    async function getUserDataFromPage(): Promise<InstagramUser | undefined> {
      // https://github.com/mifi/instauto/issues/115#issuecomment-1199335650
      // to test in browser: document.getElementsByTagName('html')[0].innerHTML.split('\n');
      try {
        const body = await page.content();
        for (let q of body.split(/\r?\n/)) {
          if (q.includes('edge_followed_by')) {
            // eslint-disable-next-line prefer-destructuring
            q = q.split(',[],[')[1] ?? '';
            // eslint-disable-next-line prefer-destructuring
            q = q.split(']]]')[0] ?? '';
            if (!q) return undefined;
            const outerParsed: unknown = JSON.parse(q);
            // eslint-disable-next-line no-underscore-dangle
            if (!isRecord(outerParsed)) return undefined;
            const { data } = outerParsed;
            if (!isRecord(data)) return undefined;
            const bbox = data['__bbox'];
            if (!isRecord(bbox)) return undefined;
            const { result } = bbox;
            if (!isRecord(result)) return undefined;
            const { response } = result;
            if (typeof response !== 'string') return undefined;
            q = response;
            q = q.replaceAll('\\', '');
            const innerParsed: unknown = JSON.parse(q);
            if (!isRecord(innerParsed)) return undefined;
            const innerData = innerParsed['data'];
            if (!isRecord(innerData)) return undefined;
            const innerUser = innerData['user'];
            if (!isInstagramUser(innerUser)) return undefined;
            return innerUser;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.warn(`Unable to get user data from page (${message}) - This is normal`);
      }
      return undefined;
    }

    // intercept special XHR network request that fetches user's data and store it in a cache
    // TODO fallback to DOM to get user ID if this request fails?
    // https://github.com/mifi/SimpleInstaBot/issues/125#issuecomment-1145354294
    async function getUserDataFromInterceptedRequest(): Promise<InstagramUser | undefined> {
      const t = setTimeout(async () => {
        logger.log('Unable to intercept request, will send manually');
        try {
          await page.evaluate(async (username2: string) => {
            const response = await window.fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username2.toLowerCase())}`, { mode: 'cors', credentials: 'include', headers: { 'x-ig-app-id': '936619743392459' } });
            await response.json(); // else it will not finish the request
          }, username);
          // todo `https://i.instagram.com/api/v1/users/${userId}/info/`
          // https://www.javafixing.com/2022/07/fixed-can-get-instagram-profile-picture.html?m=1
        } catch (err) {
          logger.error('Failed to manually send request', err);
        }
      }, 5000);

      try {
        const [foundResponse] = await Promise.all([
          page.waitForResponse((response) => {
            const request = response.request();
            return request.method() === 'GET' && new RegExp(`https:\\/\\/i\\.instagram\\.com\\/api\\/v1\\/users\\/web_profile_info\\/\\?username=${encodeURIComponent(username.toLowerCase())}`).test(request.url());
          }, { timeout: 30000 }),
          navigateToUserWithCheck(username),
          // page.waitForNavigation({ waitUntil: 'networkidle0' }),
        ]);

        const jsonText = await foundResponse.text();
        const jsonParsed: unknown = JSON.parse(jsonText);
        if (!isRecord(jsonParsed)) return undefined;
        const { data } = jsonParsed;
        if (!isRecord(data)) return undefined;
        const { user } = data;
        if (!isInstagramUser(user)) return undefined;
        return user;
      } finally {
        clearTimeout(t);
      }
    }

    logger.log('Trying to get user data from HTML');

    await navigateToUserWithCheck(username);
    let userData = await getUserDataFromPage();
    if (userData) {
      userDataCache[username] = userData;
      return userData;
    }

    logger.log('Need to intercept network request to get user data');

    // works for old accounts only:
    userData = await getUserDataFromInterceptedRequest();
    if (userData) {
      userDataCache[username] = userData;
      return userData;
    }

    return undefined;
  }

  async function getPageJson(): Promise<GraphqlJson> {
    const pre = await page.$('pre');
    assert(pre);
    const textContentHandle = await pre.getProperty('textContent');
    const textContentValue = await textContentHandle.jsonValue();
    assert(typeof textContentValue === 'string');
    return JSON.parse(textContentValue) as GraphqlJson;
  }

  async function isActionBlocked() {
    if (!(await getXpathElement('//*[contains(text(), "Action Blocked")]', { timeout: 1000 }))) return true;
    if (!(await getXpathElement('//*[contains(text(), "Try Again Later")]', { timeout: 1000 }))) return true;
    return false;
  }

  async function checkActionBlocked() {
    if (await isActionBlocked()) {
      const hours = 3;
      logger.error(`Action Blocked, waiting ${hours} hours...`);
      await tryDeleteCookies();
      await sleep(hours * 60 * 60 * 1000);
      throw new Error('Aborted operation due to action blocked');
    }
  }

  async function findButtonWithText(text: string) {
    // todo escape text?

    // button seems to look like this now:
    // <button class="..."><div class="...">Follow</div></button>
    // https://sqa.stackexchange.com/questions/36918/xpath-text-buy-now-is-working-but-not-containstext-buy-now
    // https://github.com/mifi/SimpleInstaBot/issues/106
    let elementHandle = await getXpathElement(`//header//button[contains(.,'${text}')]`, { timeout: 1000 });
    if (elementHandle != null) return elementHandle;

    // old button:
    elementHandle = await getXpathElement(`//header//button[text()='${text}']`, { timeout: 1000 });
    if (elementHandle != null) return elementHandle;

    return undefined;
  }

  async function findFollowButton() {
    let button = await findButtonWithText('Follow');
    if (button) return button;

    button = await findButtonWithText('Follow Back');
    if (button) return button;

    return undefined;
  }

  async function findUnfollowButton() {
    let button = await findButtonWithText('Following');
    if (button) return button;

    button = await findButtonWithText('Requested');
    if (button) return button;

    let elementHandle = await getXpathElement("//header//button[*//span[@aria-label='Following']]", { timeout: 1000 });
    if (elementHandle != null) return elementHandle;

    elementHandle = await getXpathElement("//header//button[*//span[@aria-label='Requested']]", { timeout: 1000 });
    if (elementHandle != null) return elementHandle;

    elementHandle = await getXpathElement("//header//button[*//*[name()='svg'][@aria-label='Following']]", { timeout: 1000 });
    if (elementHandle != null) return elementHandle;

    elementHandle = await getXpathElement("//header//button[*//*[name()='svg'][@aria-label='Requested']]", { timeout: 1000 });
    if (elementHandle != null) return elementHandle;

    return undefined;
  }

  async function findUnfollowConfirmButton() {
    let elementHandle = await getXpathElement("//button[text()='Unfollow']", { timeout: 1000 });
    if (elementHandle != null) return elementHandle;

    // https://github.com/mifi/SimpleInstaBot/issues/191
    elementHandle = await getXpathElement("//*[@role='button'][contains(.,'Unfollow')]", { timeout: 1000 });
    return elementHandle;
  }

  async function followUser(username: string) {
    await navigateToUserAndGetData(username);
    const elementHandle = await findFollowButton();

    if (!elementHandle) {
      if (await findUnfollowButton()) {
        logger.log('We are already following this user');
        await sleep(5000);
        return;
      }

      throw new Error('Follow button not found');
    }

    logger.log(`Following user ${username}`);

    if (!dryRun) {
      await elementHandle.click();
      await sleep(5000);

      await checkActionBlocked();

      const elementHandle2 = await findUnfollowButton();

      // Don't want to retry this user over and over in case there is an issue https://github.com/mifi/instauto/issues/33#issuecomment-723217177
      const entry: FollowedUser = { username, time: Date.now(), ...(elementHandle2 ? {} : { failed: true }) };

      await addPrevFollowedUser(entry);

      if (!elementHandle2) {
        logger.log('Button did not change state - Sleeping 1 min');
        await sleep(60000);
        throw new Error('Button did not change state');
      }
    }

    await sleep(1000);
  }

  // See https://github.com/timgrossmann/InstaPy/pull/2345
  // https://github.com/timgrossmann/InstaPy/issues/2355
  async function unfollowUser(username: string) {
    await navigateToUserAndGetData(username);
    logger.log(`Unfollowing user ${username}`);

    const res: FollowedUser = { username, time: Date.now() };

    const elementHandle = await findUnfollowButton();
    if (!elementHandle) {
      const elementHandle2 = await findFollowButton();
      if (elementHandle2) {
        logger.log('User has been unfollowed already');
        res.noActionTaken = true;
      } else {
        logger.log('Failed to find unfollow button');
        res.noActionTaken = true;
      }
    }

    if (!dryRun) {
      if (elementHandle) {
        await elementHandle.click();
        await sleep(1000);
        const confirmHandle = await findUnfollowConfirmButton();
        if (confirmHandle) await confirmHandle.click();

        await sleep(5000);

        await checkActionBlocked();

        const elementHandle2 = await findFollowButton();
        if (!elementHandle2) throw new Error('Unfollow button did not change state');
      }

      await addPrevUnfollowedUser(res);
    }

    await sleep(1000);

    return res;
  }

  const isLoggedIn = async () => await getXpathElement('//*[@aria-label="Home"]', { timeout: 1000 }) != null;

  async function* graphqlQueryUsers({ queryHash, getResponseProp, graphqlVariables: graphqlVariablesIn }: GraphqlQueryUsersOptions): AsyncGenerator<string[], string[], void> {
    const graphqlUrl = `${instagramBaseUrl}/graphql/query/?query_hash=${queryHash}`;

    const graphqlVariables: GraphqlVariables = {
      ...graphqlVariablesIn,
      first: graphqlVariablesIn.first ?? 50,
    };

    const outUsers: string[] = [];

    let hasNextPage = true;
    let i = 0;

    while (hasNextPage) {
      const url = `${graphqlUrl}&variables=${JSON.stringify(graphqlVariables)}`;
      // logger.log(url);
      await page.goto(url);
      const json = await getPageJson();

      const subProp = getResponseProp(json);
      assert(subProp);
      const pageInfo = subProp.page_info;
      const { edges } = subProp;

      const ret: string[] = [];
      edges.forEach((e) => ret.push(e.node.username));

      graphqlVariables.after = pageInfo.end_cursor;
      hasNextPage = pageInfo.has_next_page;
      i += 1;

      if (hasNextPage) {
        logger.log(`Has more pages (current ${i})`);
        // await sleep(300);
      }

      yield ret;
    }

    return outUsers;
  }

  function getFollowersOrFollowingGenerator({ userId, getFollowers = false }: { userId: string; getFollowers?: boolean }) {
    return graphqlQueryUsers({
      getResponseProp: (json) => json.data.user?.[getFollowers ? 'edge_followed_by' : 'edge_follow'],
      graphqlVariables: { id: userId },
      queryHash: getFollowers ? '37479f2b8209594dde7facb0d904896a' : '58712303d941c6855d4e888c5f0cd22f',
    });
  }

  async function getFollowersOrFollowing({ userId, getFollowers = false }: { userId: string; getFollowers?: boolean }) {
    let users: string[] = [];
    for await (const usersBatch of getFollowersOrFollowingGenerator({ userId, getFollowers })) {
      users = [...users, ...usersBatch];
    }
    return users;
  }

  function getUsersWhoLikedContent({ contentId }: { contentId: string }) {
    return graphqlQueryUsers({
      getResponseProp: (json) => json.data.shortcode_media?.edge_liked_by,
      graphqlVariables: {
        shortcode: contentId,
        include_reel: true,
      },
      queryHash: 'd5d763b1e2acf209d62d22d184488e57',
    });
  }

  /* eslint-disable no-undef */
  async function likeCurrentUserImagesPageCode({ dryRun: dryRunIn, likeImagesMin, likeImagesMax, shouldLikeMedia: shouldLikeMediaIn }: { dryRun: boolean; likeImagesMin: number; likeImagesMax: number; shouldLikeMedia: ShouldLikeMedia | null }) {
    const allImages = [...document.getElementsByTagName('a')].filter((el) => typeof el.href === 'string' && /instagram.com\/p\//.test(el.href));

    // eslint-disable-next-line no-shadow
    function shuffleArray<T>(arrayIn: T[]): T[] {
      const array = [...arrayIn];
      for (let i = array.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = array[i];
        if (temp === undefined || array[j] === undefined) {
          throw new Error('Invalid shuffle index');
        }
        array[i] = array[j]; // eslint-disable-line no-param-reassign
        array[j] = temp; // eslint-disable-line no-param-reassign
      }
      return array;
    }

    const imagesShuffled = shuffleArray(allImages);

    const numImagesToLike = Math.floor((Math.random() * ((likeImagesMax + 1) - likeImagesMin)) + likeImagesMin);

    window.instautoLog(`Liking ${numImagesToLike} image(s)`);

    const images = imagesShuffled.slice(0, numImagesToLike);

    if (images.length === 0) {
      window.instautoLog('No images to like');
      return;
    }

    for (const image of images) {
      image.click?.();

      await window.instautoSleep(3000);

      const dialog = document.querySelector('*[role=dialog]');

      if (!dialog) throw new Error('Dialog not found');

      const section = [...dialog.querySelectorAll('section')].find((s) => s.querySelectorAll('*[aria-label="Like"]')[0] && s.querySelectorAll('*[aria-label="Comment"]')[0]);

      if (!section) throw new Error('Like button section not found');

      const likeButtonChild = section.querySelectorAll('*[aria-label="Like"]')[0];

      if (!likeButtonChild) throw new Error('Like button not found (aria-label)');

      // eslint-disable-next-line no-inner-declarations
      function findClickableParent(el: Element | null) {
        let elAt: Element | undefined = el ?? undefined;
        while (elAt) {
          if ('click' in elAt && typeof elAt.click === 'function') {
            return elAt as HTMLElement;
          }
          elAt = elAt.parentElement ?? undefined;
        }
        return undefined;
      }

      const foundClickable = findClickableParent(likeButtonChild);

      if (!foundClickable) throw new Error('Like button not found');

      const instautoLog2 = window.instautoLog;

      // eslint-disable-next-line no-inner-declarations
      function likeImage() {
        const dialogResolved = dialog;
        if (!dialogResolved) throw new Error('Dialog not found');
        if (shouldLikeMediaIn !== null && (typeof shouldLikeMediaIn === 'function')) {
          const presentation = dialogResolved.querySelector('article[role=presentation]');
          if (!presentation) {
            instautoLog2('Presentation element not found');
            return;
          }
          const img = presentation.querySelector('img[alt^="Photo by "]') as HTMLImageElement | null;
          const video = presentation.querySelector('video[type="video/mp4"]') as HTMLVideoElement | null;
          const menuItem = presentation.querySelector('[role=menuitem] h2 ~ div');
          const mediaDesc = menuItem?.textContent ?? '';
          let mediaType: LikeMediaType = 'unknown';
          let src: string | undefined;
          let alt: string | undefined;
          let poster: string | undefined;
          if (img) {
            mediaType = 'image';
            src = img.src;
            alt = img.alt;
          } else if (video) {
            mediaType = 'video';
            poster = video.poster;
            src = video.src;
          } else {
            instautoLog2('Could not determin mediaType');
          }

          if (!shouldLikeMediaIn({ mediaType, mediaDesc, src, alt, poster })) {
            instautoLog2(`shouldLikeMedia returned false for ${image.href}, skipping`);
            return;
          }
        }

        foundClickable?.click?.();
        if (image.href) window.instautoOnImageLiked(image.href);
      }

      if (!dryRunIn) {
        likeImage();
      }

      await window.instautoSleep(3000);

      const closeButtonChild = document.querySelector('svg[aria-label="Close"]');

      if (!closeButtonChild) throw new Error('Close button not found (aria-label)');

      const closeButton = findClickableParent(closeButtonChild);

      if (!closeButton) throw new Error('Close button not found');

      closeButton?.click?.();

      await window.instautoSleep(5000);
    }

    window.instautoLog('Done liking images');
  }
  /* eslint-enable no-undef */


  async function likeUserImages({ username, likeImagesMin, likeImagesMax }: LikeUserImagesOptions = {}) {
    if (!username) throw new Error('Username is required');
    if (likeImagesMin == null || likeImagesMax == null || likeImagesMax < likeImagesMin || likeImagesMin < 1) throw new Error('Invalid arguments');
    await navigateToUserAndGetData(username);

    logger.log(`Liking ${likeImagesMin}-${likeImagesMax} user images`);
    try {
      await page.exposeFunction('instautoSleep', (...args: Parameters<typeof window['instautoSleep']>) => sleep(...args));
      await page.exposeFunction('instautoLog', (...args: Parameters<typeof window['instautoLog']>) => console.log(...args));
      await page.exposeFunction('instautoOnImageLiked', (href: Parameters<typeof window['instautoOnImageLiked']>[0]) => onImageLiked({ username, href }));
    } catch {
      // Ignore already exists error
    }

    await page.evaluate(likeCurrentUserImagesPageCode, { dryRun, likeImagesMin, likeImagesMax, shouldLikeMedia });
  }

  async function followUserRespectingRestrictions({ username, skipPrivate = false }: FollowUserRestrictions) {
    if (getPrevFollowedUser(username)) {
      logger.log('Skipping already followed user', username);
      return false;
    }

    const graphqlUser = await navigateToUserAndGetData(username);
    if (!graphqlUser) return false;

    const { edge_followed_by: { count: followedByCount }, edge_follow: { count: followsCount }, is_private: isPrivate, is_verified: isVerified, is_business_account: isBusinessAccount, is_professional_account: isProfessionalAccount, full_name: fullName, biography, profile_pic_url_hd: profilePicUrlHd, external_url: externalUrl, business_category_name: businessCategoryName, category_name: categoryName } = graphqlUser;

    // logger.log('followedByCount:', followedByCount, 'followsCount:', followsCount);

    const ratio = followedByCount / (followsCount || 1);

    if (isPrivate && skipPrivate) {
      logger.log('User is private, skipping');
      return false;
    }
    if (
      (followUserMaxFollowers != null && followedByCount > followUserMaxFollowers)
      || (followUserMaxFollowing != null && followsCount > followUserMaxFollowing)
      || (followUserMinFollowers != null && followedByCount < followUserMinFollowers)
      || (followUserMinFollowing != null && followsCount < followUserMinFollowing)
    ) {
      logger.log('User has too many or too few followers or following, skipping.', 'followedByCount:', followedByCount, 'followsCount:', followsCount);
      return false;
    }
    if (
      (followUserRatioMax != null && ratio > followUserRatioMax)
      || (followUserRatioMin != null && ratio < followUserRatioMin)
    ) {
      logger.log('User has too many followers compared to follows or opposite, skipping');
      return false;
    }
    if (shouldFollowUser !== null && (typeof shouldFollowUser === 'function' && shouldFollowUser({ username, isVerified, isBusinessAccount, isProfessionalAccount, fullName, biography, profilePicUrlHd, externalUrl, businessCategoryName, categoryName }) !== true)) {
      logger.log(`Custom follow logic returned false for ${username}, skipping`);
      return false;
    }

    await followUser(username);

    await sleep(30000);
    await throttle();

    return true;
  }

  async function processUserFollowers(username: string, {
    maxFollowsPerUser = 5, skipPrivate = false, enableLikeImages, likeImagesMin, likeImagesMax,
  }: ProcessUserFollowersOptions = {}) {
    const enableFollow = maxFollowsPerUser > 0;

    if (enableFollow) logger.log(`Following up to ${maxFollowsPerUser} followers of ${username}`);
    if (enableLikeImages) logger.log(`Liking images of up to ${likeImagesMax} followers of ${username}`);

    await throttle();

    let numFollowedForThisUser = 0;

    const userData = await navigateToUserAndGetData(username);
    if (!userData) return;
    const { id: userId } = userData;

    for await (const followersBatch of getFollowersOrFollowingGenerator({ userId, getFollowers: true })) {
      logger.log('User followers batch', followersBatch);

      for (const follower of followersBatch) {
        await throttle();

        try {
          if (enableFollow && numFollowedForThisUser >= maxFollowsPerUser) {
            logger.log('Have reached followed limit for this user, stopping');
            return;
          }

          let didActuallyFollow = false;
          if (enableFollow) didActuallyFollow = await followUserRespectingRestrictions({ username: follower, skipPrivate });
          if (didActuallyFollow) numFollowedForThisUser += 1;

          const didFailToFollow = enableFollow && !didActuallyFollow;

          if (enableLikeImages && !didFailToFollow) {
            // Note: throws error if user isPrivate
            await likeUserImages({ username: follower, likeImagesMin, likeImagesMax });
          }
        } catch (err) {
          logger.error(`Failed to process follower ${follower}`, err);
          await takeScreenshot();
          await sleep(20000);
        }
      }
    }
  }

  async function processUsersFollowers({ usersToFollowFollowersOf, maxFollowsTotal = 150, skipPrivate, enableFollow = true, enableLikeImages = false, likeImagesMin = 1, likeImagesMax = 2 }: ProcessUsersFollowersOptions) {
    // If maxFollowsTotal turns out to be lower than the user list size, slice off the user list
    const usersToFollowFollowersOfSliced = shuffleArray(usersToFollowFollowersOf).slice(0, maxFollowsTotal);

    const maxFollowsPerUser = enableFollow && usersToFollowFollowersOfSliced.length > 0 ? Math.floor(maxFollowsTotal / usersToFollowFollowersOfSliced.length) : 0;

    if (maxFollowsPerUser === 0 && (!enableLikeImages || likeImagesMin < 1 || likeImagesMax < 1)) {
      logger.warn('Nothing to follow or like');
      return;
    }

    for (const username of usersToFollowFollowersOfSliced) {
      try {
        await processUserFollowers(username, { maxFollowsPerUser, skipPrivate, enableLikeImages, likeImagesMin, likeImagesMax });

        await sleep(10 * 60 * 1000);
        await throttle();
      } catch (err) {
        logger.error('Failed to process user followers, continuing', username, err);
        await takeScreenshot();
        await sleep(60 * 1000);
      }
    }
  }

  async function safelyUnfollowUserList(usersToUnfollow: AsyncIterable<string | string[]> | Iterable<string | string[]>, limit?: number, condition: (username: string) => boolean | Promise<boolean> = () => true) {
    logger.log('Unfollowing users, up to limit', limit);

    let i = 0; // Number of people processed
    let j = 0; // Number of people actually unfollowed (button pressed)

    for await (const listOrUsername of usersToUnfollow) {
      // backward compatible:
      const list = Array.isArray(listOrUsername) ? listOrUsername : [listOrUsername];

      for (const username of list) {
        if (await condition(username)) {
          try {
            const userFound = await navigateToUser(username);

            if (!userFound) {
              // to avoid repeatedly unfollowing failed users, flag them as already unfollowed
              logger.log('User not found for unfollow');
              await addPrevUnfollowedUser({ username, time: Date.now(), noActionTaken: true });
              await sleep(3000);
            } else {
              const { noActionTaken } = await unfollowUser(username);

              if (noActionTaken) {
                await sleep(3000);
              } else {
                await sleep(15000);
                j += 1;

                if (j % 10 === 0) {
                  logger.log('Have unfollowed 10 users since last break. Taking a break');
                  await sleep(10 * 60 * 1000, 0.1);
                }
              }
            }

            i += 1;
            logger.log(`Have now unfollowed (or tried to unfollow) ${i} users`);

            if (limit && j >= limit) {
              logger.log(`Have unfollowed limit of ${limit}, stopping`);
              return j;
            }

            await throttle();
          } catch (err) {
            logger.error('Failed to unfollow, continuing with next', err);
          }
        }
      }
    }

    logger.log('Done with unfollowing', i, j);

    return j;
  }

  async function safelyFollowUserList({ users, skipPrivate, limit }: SafelyFollowUserListOptions) {
    logger.log('Following users, up to limit', limit);

    for (const username of users) {
      await throttle();

      try {
        await followUserRespectingRestrictions({ username, skipPrivate });
      } catch (err) {
        logger.error(`Failed to follow user ${username}, continuing`, err);
        await takeScreenshot();
        await sleep(20000);
      }
    }
  }

  const goHome = async () => gotoUrl(`${instagramBaseUrl}/?hl=en`);

  // https://github.com/mifi/SimpleInstaBot/issues/28
  async function setLang(short: string, long: string, assumeLoggedIn = false) {
    logger.log(`Setting language to ${long} (${short})`);

    try {
      await sleep(1000);

      // when logged in, we need to go to account in order to be able to check/set language
      // (need to see the footer)
      await (assumeLoggedIn ? gotoUrl(`${instagramBaseUrl}/accounts/edit/`) : goHome());
      await sleep(3000);
      const selectElement = await getXpathElement(`//select[//option[@value='${short}' and text()='${long}']]`, { timeout: 1000 });
      if (!selectElement) throw new Error('Language selector not found');
      logger.log('Found language selector');

      // https://stackoverflow.com/questions/45864516/how-to-select-an-option-from-dropdown-select
      const alreadyEnglish = await page.evaluate((selectElem, short2: string) => {
        const optionElem = selectElem.querySelector?.(`option[value='${short2}']`) as HTMLOptionElement | null;
        if (!optionElem) return false;
        if (optionElem.selected) return true; // already selected?
        optionElem.selected = true;
        // eslint-disable-next-line no-undef
        const event = new Event('change', { bubbles: true });
        selectElem.dispatchEvent?.(event);
        return false;
      }, selectElement, short);

      if (alreadyEnglish) {
        logger.log('Already English language');
        if (!assumeLoggedIn) {
          await goHome(); // because we were on the settings page
          await sleep(1000);
        }
        return;
      }

      logger.log('Selected language');
      await sleep(3000);
      await goHome();
      await sleep(1000);
    } catch (err) {
      logger.error('Failed to set language, trying fallback (cookie)', err);
      // This doesn't seem to always work, hence why it's just a fallback now
      await goHome();
      await sleep(1000);

      await page.setCookie({
        name: 'ig_lang',
        value: short,
        path: '/',
      });
      await sleep(1000);
      await goHome();
      await sleep(3000);
    }
  }

  const setEnglishLang = async (assumeLoggedIn: boolean) => setLang('en', 'English', assumeLoggedIn);
  // const setEnglishLang = async (assumeLoggedIn) => setLang('de', 'Deutsch', assumeLoggedIn);

  async function tryPressButton(elementHandle: ElementHandle | null, name: string, sleepMs = 3000) {
    try {
      if (elementHandle != null) {
        logger.log(`Pressing button: ${name}`);
        elementHandle.click();
        await sleep(sleepMs);
      }
    } catch {
      logger.warn(`Failed to press button: ${name}`);
    }
  }

  async function init() {
    // https://github.com/mifi/SimpleInstaBot/issues/118#issuecomment-1067883091
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en' });

    if (randomizeUserAgent) {
      const userAgentGenerated = new UserAgent({ deviceCategory: 'desktop' });
      await page.setUserAgent({ userAgent: userAgentGenerated.toString() });
    }
    if (userAgent) await page.setUserAgent({ userAgent });

    if (enableCookies) await tryLoadCookies();

    await setEnglishLang(false);

    await tryPressButton(await getXpathElement('//button[contains(text(), "Accept")]', { timeout: 1000 }), 'Accept cookies dialog', 10000);
    await tryPressButton(await getXpathElement('//button[contains(text(), "Only allow essential cookies")]', { timeout: 100 }), 'Accept cookies dialog 2 button 1', 10000);
    await tryPressButton(await getXpathElement('//button[contains(text(), "Allow essential and optional cookies")]', { timeout: 100 }), 'Accept cookies dialog 2 button 2', 10000);

    if (!(await isLoggedIn())) {
      if (!myUsername || !password) {
        await tryDeleteCookies();
        throw new Error('No longer logged in. Deleting cookies and aborting. Need to provide username/password');
      }

      try {
        await page.click('a[href="/accounts/login/?source=auth_switcher"]');
        await sleep(1000);
      } catch {
        logger.info('No login page button, assuming we are on login form');
      }

      // Mobile version https://github.com/mifi/SimpleInstaBot/issues/7
      await tryPressButton(await getXpathElement('//button[contains(text(), "Log In")]', { timeout: 1000 }), 'Login form button');

      // Instagram changed their login form - the input fields no longer have name attributes
      // We need to use type selectors instead
      const usernameInput = await page.waitForSelector('input[type="text"]', { timeout: 5000 });
      if (!usernameInput) throw new Error('Username input field not found');
      await usernameInput.type(myUsername, { delay: 50 });
      await sleep(1000);
      
      const passwordInput = await page.waitForSelector('input[type="password"]', { timeout: 5000 });
      if (!passwordInput) throw new Error('Password input field not found');
      await passwordInput.type(password, { delay: 50 });
      await sleep(500);
      
      // Focus password field and press Enter to submit login
      await passwordInput.focus();
      await page.keyboard.press('Enter');

      await sleepFixed(10000);

      // Sometimes login button gets stuck with a spinner
      // https://github.com/mifi/SimpleInstaBot/issues/25
      if (!(await isLoggedIn())) {
        logger.log('Still not logged in, trying to reload loading page');
        await page.reload();
        await sleep(5000);
      }

      let warnedAboutLoginFail = false;
      while (!(await isLoggedIn())) {
        if (!warnedAboutLoginFail) logger.warn('WARNING: Login has not succeeded. This could be because of an incorrect username/password, or a "suspicious login attempt"-message. You need to manually complete the process, or if really logged in, click the Instagram logo in the top left to go to the Home page.');
        warnedAboutLoginFail = true;
        await sleep(5000);
      }

      // In case language gets reset after logging in
      // https://github.com/mifi/SimpleInstaBot/issues/118
      await setEnglishLang(true);

      // Mobile version https://github.com/mifi/SimpleInstaBot/issues/7
      await tryPressButton(await getXpathElement('//button[contains(text(), "Save Info")]', { timeout: 1000 }), 'Login info dialog: Save Info');
      // May sometimes be "Save info" too? https://github.com/mifi/instauto/pull/70
      await tryPressButton(await getXpathElement('//button[contains(text(), "Save info")]', { timeout: 1000 }), 'Login info dialog: Save info');
    }

    await tryPressButton(await getXpathElement('//button[contains(text(), "Not Now")]', { timeout: 1000 }), 'Turn on Notifications dialog');

    await trySaveCookies();

    logger.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(hourMs)} in the last hour`);
    logger.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(dayMs)} in the last 24 hours`);
    logger.log(`Have liked ${getNumLikesThisTimeUnit(dayMs)} images in the last 24 hours`);

    try {
      // eslint-disable-next-line no-underscore-dangle
      const detectedUsername = await page.evaluate(() => window._sharedData?.config?.viewer?.username);
      if (detectedUsername) myUsername = detectedUsername;
    } catch (err) {
      logger.error('Failed to detect username', err);
    }

    if (!myUsername) {
      throw new Error('Don\'t know what\'s my username');
    }

    const me = await navigateToUserAndGetData(myUsername);
    if (!me) throw new Error('Failed to load my user data');
    ({ id: myUserId } = me);
  }

  // --- END OF INITIALIZATION

  async function doesUserFollowMe(username: string) {
    try {
      logger.info('Checking if user', username, 'follows us');
      const userData = await navigateToUserAndGetData(username);
      if (!userData) throw new Error('Unable to resolve user id');
      const { id: userId } = userData;

      const elementHandle = await getXpathElement("//a[contains(.,' following')][contains(@href,'/following')]", { timeout: 1000 });
      if (elementHandle == null) throw new Error('Following button not found');

      if (!userId) throw new Error('Unable to resolve user id');
      const [foundResponse] = await Promise.all([
        page.waitForResponse((response) => {
          const request = response.request();
          return request.method() === 'GET' && new RegExp(`instagram.com/api/v1/friendships/${userId}/following/`).test(request.url());
        }),
        elementHandle.click(),
        // page.waitForNavigation({ waitUntil: 'networkidle0' }),
      ]);

      const responseText = await foundResponse.text();
      const parsed: unknown = JSON.parse(responseText);
      if (!isRecord(parsed) || !Array.isArray(parsed['users'])) throw new Error('Invalid follow response');
      const { users } = parsed;
      if (users.length < 2) throw new Error('Unable to find user follows list');
      // console.log(users, myUserId);
      return users.some((user) => isRecord(user) && (String(user['pk']) === String(myUserId) || user['username'] === myUsername)); // If they follow us, we will show at the top of the list
    } catch (err) {
      logger.error('Failed to check if user follows us', err);
      return undefined;
    }
  }

  async function unfollowNonMutualFollowers({ limit }: UnfollowOptions = {}) {
    logger.log(`Unfollowing non-mutual followers (limit ${limit})...`);

    /* const allFollowers = await getFollowersOrFollowing({
      userId: myUserId,
      getFollowers: true,
    }); */
    assert(myUserId);
    const allFollowingGenerator = getFollowersOrFollowingGenerator({
      userId: myUserId,
      getFollowers: false,
    });

    async function condition(username: string) {
      // if (allFollowers.includes(u)) return false; // Follows us
      if (excludeUsers.includes(username)) return false; // User is excluded by exclude list
      if (haveRecentlyFollowedUser(username)) {
        logger.log(`Have recently followed user ${username}, skipping`);
        return false;
      }

      const followsMe = await doesUserFollowMe(username);
      logger.info('User follows us?', followsMe);
      return followsMe === false;
    }

    return safelyUnfollowUserList(allFollowingGenerator, limit, condition);
  }

  async function unfollowAllUnknown({ limit }: UnfollowOptions = {}) {
    logger.log('Unfollowing all except excludes and auto followed');

    assert(myUserId);
    const unfollowUsersGenerator = getFollowersOrFollowingGenerator({
      userId: myUserId,
      getFollowers: false,
    });

    function condition(username: string) {
      if (getPrevFollowedUser(username)) return false; // we followed this user, so it's not unknown
      if (excludeUsers.includes(username)) return false; // User is excluded by exclude list
      return true;
    }

    return safelyUnfollowUserList(unfollowUsersGenerator, limit, condition);
  }

  async function unfollowOldFollowed({ ageInDays, limit }: UnfollowOldOptions = {}) {
    assert(ageInDays != null, 'Age in days is required');

    const ageInDaysResolved = ageInDays;
    logger.log(`Unfollowing currently followed users who were auto-followed more than ${ageInDaysResolved} days ago (limit ${limit})...`);

    assert(myUserId);
    const followingUsersGenerator = getFollowersOrFollowingGenerator({
      userId: myUserId,
      getFollowers: false,
    });

    function condition(username: string) {
      const previous = getPrevFollowedUser(username);
      if (!previous) return false;
      if (excludeUsers.includes(username)) return false;
      return (Date.now() - previous.time) / (1000 * 60 * 60 * 24) > ageInDaysResolved;
    }

    return safelyUnfollowUserList(followingUsersGenerator, limit, condition);
  }

  async function listManuallyFollowedUsers() {
    assert(myUserId);
    const allFollowing = await getFollowersOrFollowing({
      userId: myUserId,
      getFollowers: false,
    });

    return allFollowing.filter((u) => !getPrevFollowedUser(u) && !excludeUsers.includes(u));
  }

  return {
    init,
    followUserFollowers: processUserFollowers,
    unfollowNonMutualFollowers,
    unfollowAllUnknown,
    unfollowOldFollowed,
    followUser,
    unfollowUser,
    likeUserImages,
    sleep,
    listManuallyFollowedUsers,
    getFollowersOrFollowing,
    getUsersWhoLikedContent,
    safelyUnfollowUserList,
    safelyFollowUserList,
    followUsersFollowers: processUsersFollowers,
    doesUserFollowMe,
    navigateToUserAndGetData,
  };
}

export default Instauto;

export { default as JSONDB } from './db.ts';
