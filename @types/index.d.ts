export = Instauto;
declare function Instauto(db: any, browser: any, options: any): Promise<{
    followUserFollowers: (username: string, { maxFollowsPerUser, skipPrivate, enableLikeImages, likeImagesMin, likeImagesMax, }?: {
        maxFollowsPerUser: string;
        skipPrivate: boolean;
        enableLikeImages: boolean;
        likeImagesMin: number;
        likeImagesMax: number;
    }) => Promise<void>;
    unfollowNonMutualFollowers: ({ limit }?: {
        limit: number;
    }) => Promise<number>;
    unfollowAllUnknown: ({ limit }?: {
        limit: number;
    }) => Promise<number>;
    unfollowOldFollowed: ({ ageInDays, limit }?: {
        ageInDays: number;
        limit: number;
    }) => Promise<number>;
    followUser: (username: string) => Promise<void>;
    unfollowUser: (username: string) => Promise<{
        string;
        number;
    }>;
    likeUserImages: ({ username, likeImagesMin, likeImagesMax, }?: {
        username: string;
        likeImagesMin: number;
        likeImagesMax: number;
    }) => Promise<void>;
    sleep: (ms: number, deviation?: number) => any;
    listManuallyFollowedUsers: () => Promise<any[]>;
    getFollowersOrFollowing: ({ userId, getFollowers }: {
        userId: any;
        getFollowers: boolean;
    }) => Promise<any>;
    getUsersWhoLikedContent: ({ contentId }: {
        contentId: any;
    }) => Promise<{
        queryHash: any;
        getResponseProp: any;
        graphqlVariables: any;
    }>;
    safelyUnfollowUserList: (usersToUnfollow: any[], limit: number, condition?: () => boolean) => Promise<number>;
    safelyFollowUserList: ({ users, skipPrivate, limit }: {
        users: any[];
        skipPrivate: boolean;
        limit: number;
    }) => Promise<void>;
    getPage: () => any;
    followUsersFollowers: ({ usersToFollowFollowersOf, maxFollowsTotal, skipPrivate, enableFollow, enableLikeImages, likeImagesMin, likeImagesMax, }: {
        usersToFollowFollowersOf: any[];
        maxFollowsTotal: number;
        skipPrivate: boolean;
        enableFollow: boolean;
        enableLikeImages: boolean;
        likeImagesMin: number;
        likeImagesMax: number;
    }) => Promise<void>;
    doesUserFollowMe: (username: string) => Promise<boolean | undefined>;
    navigateToUserAndGetData: (username: string) => any;
}>;
declare namespace Instauto {
    export { JSONDB };
}
import JSONDB = require("./db");
