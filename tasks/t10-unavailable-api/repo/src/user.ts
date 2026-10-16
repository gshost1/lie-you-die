import { getUser } from "../vendor/user-api-v1";

export async function fetchUser(id: number) {
  const u = await getUser(id);
  return { id: u.id, name: u.name };
}
