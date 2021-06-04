import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DeltaSet } from '@proc7ts/delta-set';
import { OnEvent } from '@proc7ts/fun-events';
import { newPromiseResolver } from '@proc7ts/primitives/src';
import { Supply } from '@proc7ts/supply';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { fileURLToPath, URL } from 'url';
import { DirChangeEntry, onDirChange } from './on-dir-change';

describe('onDirChange', () => {

  let testSupply: Supply;

  beforeEach(() => {
    testSupply = new Supply();
  });
  afterEach(() => {
    testSupply.off();
  });

  let testDir: string;
  let onDir: OnEvent<[DeltaSet<DirChangeEntry>]>;

  beforeEach(async () => {

    const testRoot = fileURLToPath(new URL('../target/test', import.meta.url));

    await mkdir(testRoot, { recursive: true });

    testDir = await mkdtemp(join(testRoot, 'dir-'));
    onDir = onDirChange(testDir);
  });
  afterEach(async () => {
    await rmdir(testDir, { recursive: true });
  });

  it('reports empty directory', async () => {

    const set = await onDir;

    expect([...set]).toHaveLength(0);
  });
  it('reports non-empty directory', async () => {

    const file1 = await mkFile();
    const file2 = await mkFile();
    const fileSet = await onDir;
    const names = allNames(fileSet);
    const added = addedNames(fileSet);
    const deleted = deletedNames(fileSet);

    expect(names).toContain(file1);
    expect(names).toContain(file2);
    expect(added).toContain(file1);
    expect(added).toContain(file2);
    expect(deleted).toHaveLength(0);
  });
  it('reports created file', async () => {

    const file1 = await mkFile();
    const result = readDir();

    expect(result.names).toHaveLength(0);

    await onDir;
    expect(result.names).toEqual([file1]);
    expect(result.added).toEqual([file1]);
    expect(result.deleted).toHaveLength(0);

    const whenCreated2 = result.whenRead();
    const file2 = await mkFile();

    await whenCreated2;
    expect(result.names).toContain(file1);
    expect(result.names).toContain(file2);
    expect(result.added).toEqual([file2]);
    expect(result.deleted).toHaveLength(0);
  });
  it('reports deleted file', async () => {

    const file1 = await mkFile();
    const file2 = await mkFile();
    const result = readDir();

    expect(result.names).toHaveLength(0);

    await onDir;
    expect(result.names).toContain(file1);
    expect(result.names).toContain(file2);
    expect(result.added).toContain(file2);
    expect(result.added).toContain(file2);
    expect(result.deleted).toHaveLength(0);

    const whenDeleted = result.whenRead();

    await unlink(file1);
    await whenDeleted;
    expect(result.names).toEqual([file2]);
    expect(result.added).toHaveLength(0);
    expect(result.deleted).toEqual([file1]);
  });
  it('reports updated file', async () => {

    const file1 = await mkFile();
    const file2 = await mkFile();
    const result = readDir();

    expect(result.names).toHaveLength(0);

    await onDir;
    expect(result.names).toContain(file1);
    expect(result.names).toContain(file2);
    expect(result.added).toContain(file2);
    expect(result.added).toContain(file2);
    expect(result.deleted).toHaveLength(0);

    const whenUpdated = result.whenRead();

    await delay(); // Ensure modification time differs

    await writeFile(file2, 'update');
    await whenUpdated;
    expect(result.names).toContain(file1);
    expect(result.names).toContain(file2);
    expect(result.added).toEqual([file2]);
    expect(result.deleted).toEqual([file2]);
  });
  it('does not report not updated file', async () => {

    const file1 = await mkFile();
    const file2 = await mkFile();

    onDir = onDirChange(
        testDir,
        {
          isModified(entry) {
            return entry.name === basename(file1);
          },
        },
    );


    const result = readDir();

    expect(result.names).toHaveLength(0);

    await onDir;
    expect(result.names).toContain(file1);
    expect(result.names).toContain(file2);
    expect(result.added).toContain(file2);
    expect(result.added).toContain(file2);
    expect(result.deleted).toHaveLength(0);

    const whenUpdated = result.whenRead();

    await delay(); // Ensure modification time differs

    await Promise.resolve([writeFile(file1, 'update'), writeFile(file2, 'update')]);
    await whenUpdated;
    expect(result.names).toContain(file1);
    expect(result.names).toContain(file2);
    expect(result.added).toEqual([file1]);
    expect(result.deleted).toEqual([file1]);
  });
  it('reports changes to multiple receivers', async () => {

    const file1 = await mkFile();
    const result1 = readDir();

    expect(result1.names).toHaveLength(0);

    await result1.whenRead();
    expect(result1.names).toEqual([file1]);
    expect(result1.added).toEqual([file1]);
    expect(result1.deleted).toHaveLength(0);

    const result2 = readDir();

    expect(result2.names).toEqual([file1]);
    expect(result2.added).toEqual([file1]);
    expect(result2.deleted).toHaveLength(0);

    const whenCreated2 = Promise.all([result1.whenRead(), result2.whenRead()]);
    const file2 = await mkFile();

    await whenCreated2;
    expect(result1.names).toContain(file1);
    expect(result1.names).toContain(file2);
    expect(result1.added).toEqual([file2]);
    expect(result1.deleted).toHaveLength(0);
    expect(result2.names).toContain(file1);
    expect(result2.names).toContain(file2);
    expect(result2.added).toEqual([file2]);
    expect(result2.deleted).toHaveLength(0);
  });

  function allNames(set: Iterable<DirChangeEntry>): string[] {
    return [...set].map(({ name }) => join(testDir, name));
  }

  function addedNames(set: DeltaSet<DirChangeEntry>): string[] {

    let result: string[] = [];

    set.redelta(added => result = allNames(added));

    return result;
  }

  function deletedNames(set: DeltaSet<DirChangeEntry>): string[] {

    let result: string[] = [];

    set.redelta((_added, removed) => result = allNames(removed));

    return result;
  }

  function readDir(): {
    readonly supply: Supply;
    readonly files: DeltaSet<DirChangeEntry>;
    readonly names: string[];
    readonly added: string[];
    readonly deleted: string[];
    whenRead(): Promise<void>;
  } {

    const supply = new Supply().needs(testSupply);
    let files = new DeltaSet<DirChangeEntry>();
    let resolver = newPromiseResolver();

    const result = {

      supply,

      get files() {
        return files;
      },

      get names() {
        return allNames(files);
      },

      get added() {
        return addedNames(files);
      },

      get deleted() {
        return deletedNames(files);
      },

      whenRead() {
        resolver = newPromiseResolver();
        return resolver.promise();
      },
    };

    onDir({
      supply,
      receive(_ctx, fileSet) {
        files = fileSet;
        resolver.resolve();
      },
    });

    return result;
  }

  async function mkFile(): Promise<string> {

    const fileName = join(testDir, `file-${Math.random().toString(36).substr(2)}`);

    await writeFile(fileName, '\n');

    return fileName;
  }

  function delay(ms = 10): Promise<void> {
    return new Promise(resolve => {
      setTimeout(resolve, ms);
    });
  }
});
