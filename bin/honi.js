#!/usr/bin/env node
// Honi CLI
const { execSync } = require('child_process');
const { mkdirSync, writeFileSync } = require('fs');

const command = process.argv[2];

const commands = {
  'dev': () => {
    console.log('Starting Honi dev server...');
    execSync('wrangler dev', { stdio: 'inherit' });
  },
  'deploy': () => {
    console.log('Deploying Honi agent...');
    execSync('wrangler deploy', { stdio: 'inherit' });
  },
  'new': () => {
    const name = process.argv[3] || 'my-agent';
    createProject(name);
  },
  'help': () => printHelp(),
};

function printHelp() {
  console.log(`
Honi — Edge-first AI agents for Cloudflare Workers

Usage: honi <command>

Commands:
  new <name>    Create a new Honi agent project
  dev           Start local dev server (wraps wrangler dev)
  deploy        Deploy to Cloudflare Workers (wraps wrangler deploy)
  help          Show this help

Examples:
  honi new my-sales-coach
  honi dev
  honi deploy
`);
}

function createProject(name) {
  console.log(`Creating Honi project: ${name}`);
  mkdirSync(name, { recursive: true });

  // package.json
  writeFileSync(`${name}/package.json`, JSON.stringify({
    name,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'wrangler dev',
      deploy: 'wrangler deploy',
      typecheck: 'tsc --noEmit',
    },
    dependencies: { 'honidev': 'latest' },
    devDependencies: { '@cloudflare/workers-types': 'latest', typescript: 'latest', wrangler: 'latest' },
  }, null, 2));

  // wrangler.toml
  writeFileSync(`${name}/wrangler.toml`, `name = "${name}"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[durable_objects]
bindings = [{ name = "AGENT_DO", class_name = "AgentDO" }]

[[migrations]]
tag = "v1"
new_classes = ["AgentDO"]
`);

  // tsconfig.json
  writeFileSync(`${name}/tsconfig.json`, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      types: ['@cloudflare/workers-types'],
      strict: true,
    },
  }, null, 2));

  // src/index.ts
  mkdirSync(`${name}/src`, { recursive: true });
  writeFileSync(`${name}/src/index.ts`, `import { createAgent } from 'honidev';

const agent = createAgent({
  name: '${name}',
  model: 'claude-sonnet-4-5',
  memory: { enabled: true },
  system: 'You are a helpful assistant.',
});

export default { fetch: agent.fetch };
export const AgentDO = agent.DurableObject;
`);

  console.log(`
\u2705 Created ${name}/

Next steps:
  cd ${name}
  npm install
  honi dev
`);
}

if (!command || command === 'help') {
  printHelp();
} else if (commands[command]) {
  commands[command]();
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
