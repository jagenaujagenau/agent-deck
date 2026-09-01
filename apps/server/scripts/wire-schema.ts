#!/usr/bin/env bun
/**
 * Writes `docs/bridge-v1.schema.json` from the schemas the routes decode with.
 *
 * Run it after changing a wire shape in `Domain.ts`; `WireSchema.test.ts`
 * fails until you do.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireSchemaDocument, WIRE_SCHEMA_PATH } from "../src/effect/WireSchema";

const target = join(import.meta.dir, "../../..", WIRE_SCHEMA_PATH);
writeFileSync(target, `${JSON.stringify(wireSchemaDocument(), null, 2)}\n`);
console.log(`wrote ${WIRE_SCHEMA_PATH}`);
