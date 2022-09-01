import { DeltaSet } from '@proc7ts/delta-set';
import { OnEvent, onEventBy, sendEventsTo, shareOn } from '@proc7ts/fun-events';
import { Supply } from '@proc7ts/supply';
import { BigIntStats, Dirent, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Directory changes event entry.
 *
 * Corresponds to a file in the tracked directory.
 */
export interface DirChangeEntry {
  /**
   * File name relative to the watched directory.
   */
  readonly name: string;

  /**
   * File stats.
   */
  readonly stats: BigIntStats;
}

/**
 * Directory changes tracking options.
 */
export interface DirChangeOptions {
  /**
   * Checks whether the file should be tracked.
   *
   * All files are tracked by default.
   *
   * @param entry - A file entry to check.
   *
   * @returns `true` if the file should be tracked, or `false` otherwise.
   */
  filter?(this: void, entry: Dirent): boolean;

  /**
   * Checks whether a new file is modified.
   *
   * If a file entry is not modified since already reported one, it won't be reported as added.
   *
   * Compares file modification times by default.
   *
   * @param newEntry - The tracked file entry to check.
   * @param oldEntry - The already reported file entry with the same name.
   */
  isModified?(this: void, newEntry: DirChangeEntry, oldEntry: DirChangeEntry): boolean;
}

/**
 * Create an `OnEvent` sender of tracked directory changes.
 *
 * @param path - Tracked directory path.
 * @param options - Directory tracking options.
 *
 * @returns An `OnEvent` sender of `DeltaSet` of tracked directory file entries.
 */
export function onDirChange(
  path: string,
  options: DirChangeOptions = {},
): OnEvent<[DeltaSet<DirChangeEntry>]> {
  const { filter = onDirChange$allowAll, isModified = onDirChange$mTimeChanged } = options;
  const store: DirChangeStore = {
    path,
    byName: new Map<string, DirChangeEntry>(),
  } as DirChangeStore;

  return onDirChange$track(store, { filter, isModified }).do(shareOn, onDirChange$share(store));
}

function onDirChange$track(
  store: DirChangeStore,
  options: Required<DirChangeOptions>,
): OnEvent<[DeltaSet<DirChangeEntry>]> {
  return onEventBy(receiver => {
    const dispatch = sendEventsTo(receiver);

    store.send = fileSet => {
      dispatch(fileSet);
      store.isSent = true;
    };
    receiver.supply.whenOff(() => {
      store.byName.clear();
      store.isSent = false;
    });

    const loadDir = onDirChange$debounce(
      onDirChange$load(store, options, receiver.supply),
      receiver.supply,
    );

    const watcher = watch(store.path, loadDir);

    watcher.on('error', receiver.supply.off.bind(receiver.supply));
    watcher.on('close', () => receiver.supply.off());
    receiver.supply.whenOff(() => watcher.close());

    loadDir();
  });
}

interface DirChangeStore {
  readonly path: string;
  readonly byName: Map<string, DirChangeEntry>;
  isSent: boolean;

  send(this: void, entries: DeltaSet<DirChangeEntry>): void;
}

function onDirChange$debounce(load: () => Promise<void>, supply: Supply): () => void {
  let whenReady: Promise<void>;

  return () => {
    const canLoad = (whenReady = Promise.resolve());

    canLoad
      .then(() => (canLoad === whenReady ? load() : /* istanbul ignore next */ Promise.resolve()))
      .catch(supply.off.bind(supply));
  };
}

function onDirChange$load(
  { path, byName, send }: DirChangeStore,
  { filter, isModified }: Required<DirChangeOptions>,
  supply: Supply,
): () => Promise<void> {
  let statEntries = (dirEntries: Dirent[]): Promise<DirChangeEntry[]> => Promise.all(
      dirEntries
        .filter(filter)
        .map(({ name }) => stat(join(path, name), { bigint: true }).then(
            (stats): DirChangeEntry => ({ name, stats }),
          )),
    );
  let sendEntries = (entries: DirChangeEntry[]): void => {
    const removedNames = new Set(byName.keys());
    const result = new DeltaSet(byName.values()).undelta();

    for (const entry of entries) {
      const { name } = entry;
      const oldEntry = byName.get(name);

      if (oldEntry) {
        removedNames.delete(name);
        if (isModified(entry, oldEntry)) {
          // Entry modified.
          byName.set(name, entry);
          result.delete(oldEntry);
          result.add(entry);
        }
      } else {
        // New entry.
        byName.set(name, entry);
        result.add(entry);
      }
    }

    removedNames.forEach(name => {
      const removedEntry = byName.get(name)!;

      byName.delete(name);
      result.delete(removedEntry);
    });

    send(result);
  };
  let load = (): Promise<void> => readdir(path, { withFileTypes: true })
      .then(entries => statEntries(entries))
      .then(entries => sendEntries(entries));

  supply.whenOff(() => {
    load = onDirChange$dontLoad;
    statEntries = onDirChange$dontStatEntries;
    sendEntries = onDirChange$dontSendEntries;
  });

  return load;
}

// istanbul ignore next
function onDirChange$dontLoad(): Promise<void> {
  return Promise.resolve();
}

function onDirChange$dontStatEntries(_dirEntries: Dirent[]): Promise<DirChangeEntry[]> {
  return Promise.resolve([]);
}

function onDirChange$dontSendEntries(_entries: DirChangeEntry[]): void {
  // Do not send entries
}

function onDirChange$allowAll(_entry: Dirent): boolean {
  return true;
}

function onDirChange$mTimeChanged(newEntry: DirChangeEntry, oldEntry: DirChangeEntry): boolean {
  return newEntry.stats.mtimeNs !== oldEntry.stats.mtimeNs;
}

function onDirChange$share(
  store: DirChangeStore,
): (source: OnEvent<[DeltaSet<DirChangeEntry>]>) => OnEvent<[DeltaSet<DirChangeEntry>]> {
  return source => onEventBy(receiver => {
      const { supply, receive } = receiver;
      let set: Set<DirChangeEntry>;

      if (store.isSent) {
        set = new Set(store.byName.values());
        sendEventsTo(receiver)(new DeltaSet(set));
      } else {
        set = new Set();
      }

      source({
        supply,
        receive(_ctx, received) {
          const result = new DeltaSet(set).undelta();

          received.redelta(set);
          received.redelta(result);

          receive(_ctx, result);
        },
      });
    });
}
