import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, langForPath } from '../webview-ui/render/lang';

test('maps Kotlin sources, nested or not', () => {
  assert.equal(langForPath('Main.kt'), 'kotlin');
  assert.equal(langForPath('src/main/kotlin/com/example/Main.kt'), 'kotlin');
  assert.equal(langForPath('a/b/Build.kts'), 'kotlin');
});

test('matches extensionless filenames on the basename, at any depth', () => {
  assert.equal(langForPath('Dockerfile'), 'docker');
  assert.equal(langForPath('docker/Dockerfile'), 'docker');
  assert.equal(langForPath('deploy/prod/dockerfile'), 'docker');
});

test('distinguishes Gradle Groovy from the Kotlin DSL', () => {
  assert.equal(langForPath('build.gradle'), 'groovy');
  assert.equal(langForPath('app/build.gradle.kts'), 'kotlin');
});

test('maps config and infra formats to their canonical grammar names', () => {
  assert.equal(langForPath('gradle.properties'), 'ini');
  assert.equal(langForPath('setup.cfg'), 'ini');
  assert.equal(langForPath('main.tf'), 'terraform');
  assert.equal(langForPath('vars.tfvars'), 'terraform');
  assert.equal(langForPath('Cargo.toml'), 'toml');
  assert.equal(langForPath('res/layout/activity_main.xml'), 'xml');
  assert.equal(langForPath('schema.graphql'), 'graphql');
  assert.equal(langForPath('api.proto'), 'proto');
});

test('is case-insensitive on extension and filename', () => {
  assert.equal(langForPath('Main.KT'), 'kotlin');
  assert.equal(langForPath('build/DOCKERFILE'), 'docker');
});

test('returns undefined when no grammar is bundled', () => {
  assert.equal(langForPath('README'), undefined);
  assert.equal(langForPath('notes.unknownext'), undefined);
  assert.equal(langForPath('archive.tar.gz'), undefined);
});

test('a path that is only a directory-like string does not resolve', () => {
  assert.equal(langForPath('src/'), undefined);
});

test('no extension or filename is claimed by two grammars', () => {
  const seen = new Map<string, string>();
  for (const lang of LANGS) {
    for (const key of [...lang.exts, ...(lang.files ?? [])]) {
      const prior = seen.get(key);
      assert.equal(prior, undefined, `"${key}" claimed by both ${prior} and ${lang.name}`);
      seen.set(key, lang.name);
    }
  }
});

test('every entry is lowercase, dotless, and resolvable', () => {
  for (const lang of LANGS) {
    assert.ok(lang.exts.length > 0 || (lang.files?.length ?? 0) > 0, `${lang.name} maps no path`);
    for (const key of [...lang.exts, ...(lang.files ?? [])]) {
      assert.equal(key, key.toLowerCase(), `"${key}" is not lowercase`);
      assert.ok(!key.startsWith('.'), `"${key}" should not include the leading dot`);
    }
    for (const ext of lang.exts) assert.equal(langForPath(`file.${ext}`), lang.name);
    for (const file of lang.files ?? []) assert.equal(langForPath(`dir/${file}`), lang.name);
  }
});
