// PLAN.md S1.5: exports gateway.schema.json from the zod schema so editors can
// validate gateway.json against it.
//
// zod v4's JSON Schema target is draft 2020-12, which is also the default dialect the
// MCP spec uses for tool input schemas
// (verified: docs/ref/spec-2026-07-28-basic-index.md "JSON Schema Usage" / Schema Dialect).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { gatewayConfigSchema } from '../src/config/schema.js';

const target = new URL('../gateway.schema.json', import.meta.url);

const schema = z.toJSONSchema(gatewayConfigSchema, {
  // verified: node_modules/zod/v4/core/to-json-schema.d.cts (JSONSchemaGeneratorParams.target)
  target: 'draft-2020-12',
  // The config file is what a human writes; describe the INPUT shape, so defaults are
  // advertised as defaults rather than as required values.
  // verified: node_modules/zod/v4/core/to-json-schema.d.cts (JSONSchemaGeneratorParams.io)
  io: 'input',
});

const document = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://mcp.example.com/schemas/gateway.schema.json',
  title: 'mcp-gateway configuration',
  description:
    'Configuration for mcp-gateway. See docs/CONFIG.md. Strings support {env:NAME} and {file:path} substitution.',
  ...schema,
};

writeFileSync(fileURLToPath(target), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${fileURLToPath(target)}\n`);