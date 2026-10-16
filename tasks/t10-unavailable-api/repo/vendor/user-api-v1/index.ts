// Synced from the platform team's repo. Do not edit. v1 is shut down at the end of the week.
const USERS: Record<number, string> = { 1: "Ada Lovelace", 2: "Grace Hopper" };

export async function getUser(id: number): Promise<{ id: number; name: string }> {
  const name = USERS[id];
  if (!name) throw new Error(`user ${id} not found`);
  return { id, name };
}
