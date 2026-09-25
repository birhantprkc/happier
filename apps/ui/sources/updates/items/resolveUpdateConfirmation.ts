import type { UpdateItem } from './updateItem';

/**
 * Which question a row's action asks first, through the established confirmation owner:
 * a vendor's own updater (K6 `native`), or any action on another machine — Update and Retry alike,
 * since both restart that machine's daemon. Local actions run inline.
 */
export function resolveUpdateConfirmation(item: UpdateItem, thisMachineId: string | null): 'vendor' | 'remote' | null {
    if (item.action.kind !== 'run') return null;
    if (item.vendorUpdater) return 'vendor';
    if (item.machineId != null && item.machineId !== thisMachineId) return 'remote';
    return null;
}
