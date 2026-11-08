import { describe, expect, it } from 'vitest';
import { builderConfig, kebab, readDesktopConfig } from '../bin/desktop-config.mjs';

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
    });
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

describe('kebab', () => {
  it('turns a product name into a file-safe name', () => {
    expect(kebab('The Last Rune')).toBe('the-last-rune');
    expect(kebab('  Hi! ')).toBe('hi');
    expect(kebab('!!!')).toBe('app');
  });
});
