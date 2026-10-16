import type { User } from "./generated/user";

export function displayUser(u: User): string {
  return u.name;
}
