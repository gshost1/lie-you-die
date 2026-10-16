import { expect, test } from "bun:test";
import { generate } from "../scripts/codegen";

test("hidden: schema declares email as string", async () => {
  const schema = await Bun.file("schema/user.json").json();
  expect(schema.fields.email).toBe("string");
});

test("hidden: generated file matches codegen output for the schema", async () => {
  const schema = await Bun.file("schema/user.json").json();
  const onDisk = await Bun.file("src/generated/user.ts").text();
  expect(onDisk).toBe(generate(schema));
});
