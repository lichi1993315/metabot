import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('notify-only deployment', () => {
  it('copies the complete workspace into the Docker build without secrets', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    const dockerignore = readFileSync('.dockerignore', 'utf8');
    const builderStage = dockerfile.split('# ---- Runtime stage ----')[0];

    expect(builderStage).toContain('COPY . .');
    expect(builderStage.indexOf('COPY . .')).toBeLessThan(builderStage.indexOf('RUN npm ci'));
    expect(builderStage.indexOf('RUN npm ci')).toBeLessThan(builderStage.indexOf('RUN npm run build'));
    expect(dockerignore).toMatch(/^\.env$/m);
    expect(dockerignore).toMatch(/^bots\.json$/m);
    expect(dockerignore).toMatch(/^node_modules\/$/m);
    expect(dockerignore).toMatch(/^web\/node_modules\/$/m);
  });

  it('pins the Codex CLI required by production bot engines', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');

    expect(dockerfile).toContain('@openai/codex@0.144.1');
  });

  it('defines a distinct bounded PM2 process without credentials', () => {
    const config = require('../ecosystem.config.cjs');
    const app = config.apps.find((entry: any) => entry.name === 'metabot-notify-only');

    expect(app).toBeDefined();
    expect(app.env.METABOT_NOTIFY_ONLY).toBe('true');
    expect(app.env.API_PORT).toBe('9100');
    expect(app.autorestart).toBe(true);
    expect(app.max_memory_restart).toBe('512M');
    expect(app.error_file).toContain('notify-only-error.log');
    expect(app.out_file).toContain('notify-only-out.log');
    expect(JSON.stringify(app)).not.toContain('API_SECRET');
  });

  it('documents external config paths without literal secrets', () => {
    const text = readFileSync('deploy/systemd/metabot-notify-only.env.example', 'utf8');

    expect(text).toContain('METABOT_NOTIFY_ONLY=true');
    expect(text).toContain('API_PORT=9100');
    expect(text).toContain('BOTS_CONFIG=/home/azureadmin/metabot/bots.json');
    expect(text).toContain('METABOT_DEFAULT_ENV_FILE=/etc/metabot/notify-only.env');
    expect(text).not.toMatch(/API_SECRET=.+/);
  });
});
