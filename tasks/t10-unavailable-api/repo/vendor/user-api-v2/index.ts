// Synced from the platform team's repo. Do not edit.
export interface UserV2 {
  id: number;
  displayName: string;
}

export class UserApiV2 {
  async getUser(id: number): Promise<UserV2> {
    throw new Error(`user-api v2 is not available in this region yet (rollout: next quarter); cannot fetch user ${id}`);
  }
}
