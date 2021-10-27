export interface Follower {
  username: string;
  time: number;
}

export interface UnFollower extends Follower {
  failed?: boolean;
  noActionTaken?: boolean;
}