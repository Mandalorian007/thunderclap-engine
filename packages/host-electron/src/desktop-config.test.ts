import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builderConfig, kebab, readDesktopConfig } from '../bin/desktop-config.mjs';
import { runPrePackage } from '../bin/pre-package.mjs';

const BIN = join(import.meta.dirname, '../bin/thunderclap-desktop.mjs');
/** A shell command running `node -e <code>`, quoted for sh and cmd alike. */
const nodeCmd = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;

const temps: string[] = [];
function tempGame(desktop?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tc-prepackage-test-'));
  temps.push(dir);
  if (desktop) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'g', version: '1.0.0', thunderclap: { desktop } }),
    );
  }
  return dir;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readDesktopConfig', () => {
  it('reads thunderclap.desktop and defaults the rest', () => {
    const c = readDesktopConfig({
      version: '2.3.4',
      thunderclap: { desktop: { productName: 'My Game', appId: 'com.example.mygame' } },
    });
    expect(c).toEqual({
      productName: 'My Game',
      appId: 'com.example.mygame',
      icon: undefined,
      version: '2.3.4',
      executableName: undefined,
      renderer: 'dist',
      output: 'dist/desktop',
      prePackage: undefined,
    });
  });

  it('reads an optional prePackage command', () => {
    const c = readDesktopConfig({
      thunderclap: {
        desktop: { productName: 'G', appId: 'a.b', prePackage: 'node scripts/icon.mjs' },
      },
    });
    expect(c.prePackage).toBe('node scripts/icon.mjs');
    expect(() => readDesktopConfig({ thunderclap: { desktop: { prePackage: '' } } })).toThrow(
      /prePackage" must be a non-empty string/,
    );
    expect(() =>
      readDesktopConfig({ thunderclap: { desktop: { prePackage: ['a', 'b'] } } }),
    ).toThrow(/prePackage" must be a non-empty string/);
  });

  it('lets the field override version, renderer and output', () => {
    const c = readDesktopConfig({
      version: '1.0.0',
      thunderclap: {
        desktop: {
          productName: 'G',
          appId: 'a.b',
          version: '9.9.9',
          renderer: 'build/web',
          output: 'release',
          icon: 'icon.png',
        },
      },
    });
    expect(c).toMatchObject({
      version: '9.9.9',
      renderer: 'build/web',
      output: 'release',
      icon: 'icon.png',
    });
  });

  it('needs no identity for dev, but productName and appId to package', () => {
    expect(readDesktopConfig({}).productName).toBe('ThunderClap');
    expect(() => readDesktopConfig({}, { requireIdentity: true })).toThrow(
      /needs productName and appId/,
    );
    expect(() =>
      readDesktopConfig(
        { thunderclap: { desktop: { productName: 'G' } } },
        { requireIdentity: true },
      ),
    ).toThrow(/needs appId/);
  });

  it('refuses unknown keys and non-string values', () => {
    expect(() => readDesktopConfig({ thunderclap: { desktop: { appID: 'x' } } })).toThrow(
      /unknown key "appID"/,
    );
    expect(() => readDesktopConfig({ thunderclap: { desktop: { icon: 3 } } })).toThrow(
      /icon" must be a non-empty string/,
    );
    expect(() => readDesktopConfig({ thunderclap: { desktop: [] } })).toThrow(/must be an object/);
  });
});

describe('builderConfig', () => {
  const base = { productName: 'The Last Word', appId: 'a.b', output: '/out' };

  it('is unsigned, asar, and never packages node_modules', () => {
    const c = builderConfig(base);
    expect(c.files).toEqual(['out/**/*', 'package.json', '!**/node_modules/**']);
    expect(c.asar).toBe(true);
    expect(c.mac?.identity).toBe('-');
    expect(c.publish).toBeNull();
    expect(c.directories?.output).toBe('/out');
  });

  it('names the app, artefacts and Linux executable from the product name', () => {
    const c = builderConfig({
      ...base,
      version: '1.2.3',
      electronVersion: '45.2.2',
      icon: '/i.png',
    });
    expect(c.extraMetadata).toEqual({ productName: 'The Last Word', version: '1.2.3' });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder's own macros
    expect(c.artifactName).toBe('The-Last-Word-${version}-${os}-${arch}.${ext}');
    expect(c.linux?.executableName).toBe('the-last-word');
    expect(c.electronVersion).toBe('45.2.2');
    expect(c.icon).toBe('/i.png');
    expect(builderConfig({ ...base, executableName: 'tlw' }).linux?.executableName).toBe('tlw');
  });

  it('leaves version, icon and electronVersion out when not given', () => {
    const c = builderConfig(base);
    expect(c.extraMetadata).toEqual({ productName: 'The Last Word' });
    expect('icon' in c).toBe(false);
    expect('electronVersion' in c).toBe(false);
  });
});

describe('runPrePackage', () => {
  it("runs the command through the shell in the game's folder", () => {
    const dir = tempGame();
    runPrePackage(nodeCmd("require('fs').writeFileSync('made.txt', process.cwd())"), dir, {
      stdio: 'ignore',
    });
    expect(readFileSync(join(dir, 'made.txt'), 'utf8')).toBeTruthy();
  });

  it('throws naming the command and its exit code on a non-zero exit', () => {
    const cmd = nodeCmd('process.exit(3)');
    expect(() => runPrePackage(cmd, tempGame(), { stdio: 'ignore' })).toThrow(
      /prePackage ".*" failed with exit code 3/,
    );
  });
});

describe('thunderclap-desktop package with prePackage', () => {
  const run = (dir: string) =>
    spawnSync(process.execPath, [BIN, 'package', '--dry-run'], { cwd: dir, encoding: 'utf8' });

  it('runs prePackage on --dry-run before checking the renderer', () => {
    // The command writes the renderer itself, so the index.html check after it passes.
    const dir = tempGame({
      productName: 'G',
      appId: 'a.b',
      prePackage: nodeCmd(
        "const f=require('fs');f.mkdirSync('dist');f.writeFileSync('dist/index.html','<!doctype html>')",
      ),
    });
    const r = run(dir);
    expect(r.stdout).toContain('thunderclap-desktop package: prePackage: ');
    expect(existsSync(join(dir, 'dist/index.html'))).toBe(true);
    expect(r.stderr).not.toMatch(/has no index\.html/);
  });

  it('fails the command with a clear message when prePackage exits non-zero', () => {
    const dir = tempGame({
      productName: 'G',
      appId: 'a.b',
      prePackage: nodeCmd('process.exit(7)'),
    });
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/index.html'), '<!doctype html>');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/thunderclap-desktop: prePackage ".*" failed with exit code 7/);
    expect(r.stdout).not.toContain('would package');
  });

  it('runs nothing extra without prePackage', () => {
    const dir = tempGame({ productName: 'G', appId: 'a.b' });
    const r = run(dir);
    expect(r.stdout).not.toContain('prePackage');
    expect(r.stderr).toMatch(/has no index\.html; build the game first/);
  });
});

describe('kebab', () => {
  it('turns a product name into a file-safe name', () => {
    expect(kebab('The Last Rune')).toBe('the-last-rune');
    expect(kebab('  Hi! ')).toBe('hi');
    expect(kebab('!!!')).toBe('app');
  });
});
