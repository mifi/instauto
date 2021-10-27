import { LikedPhoto } from '../../interfaces/likedPhoto.interface';
import { Follower, UnFollower } from '../../interfaces/follower.interface';

export interface IDbAdapter {
  getLikedPhotosLastTimeUnit: (timeUnit: number) => Promise<LikedPhoto[]>;
  addLikedPhoto: (likedPhoto: LikedPhoto) => Promise<void>;
  getFollowedLastTimeUnit: (timeUnit: number) => Promise<Follower[]>;
  getPrevFollowedUser: (username: string) => Promise<Follower>;
  addPrevFollowedUser: (follower: Follower) => Promise<void>;
  getUnfollowedLastTimeUnit: (timeUnit: number) => Promise<UnFollower[]>;
  addPrevUnfollowedUser: (unfollower: UnFollower) => Promise<void>;
}