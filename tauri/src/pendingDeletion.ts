// 延迟删除的规则 module。计时、toast 与 IPC 由 App 执行，条目状态和每一步允许的转移在这里判定。

export type DeletionPhase = 'undoable' | 'removing';
export type DeletionState = ReadonlyMap<string, DeletionPhase>;

export type DeletionEvent =
  | { type: 'request'; id: string }
  | { type: 'undo'; id: string }
  | { type: 'deadline'; id: string }
  | { type: 'remove-succeeded'; id: string }
  | { type: 'remove-failed'; id: string };

export type DeletionEffect =
  | { type: 'hide'; id: string }
  | { type: 'start-timer'; id: string }
  | { type: 'show-undo'; id: string }
  | { type: 'cancel-timer'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'show-error'; id: string };

export interface DeletionTransition {
  state: DeletionState;
  effects: DeletionEffect[];
}

const unchanged = (state: DeletionState): DeletionTransition => ({ state, effects: [] });

export function transitionDeletion(state: DeletionState, event: DeletionEvent): DeletionTransition {
  const phase = state.get(event.id);

  switch (event.type) {
    case 'request': {
      if (phase) return unchanged(state);
      const next = new Map(state);
      next.set(event.id, 'undoable');
      return {
        state: next,
        effects: [
          { type: 'hide', id: event.id },
          { type: 'start-timer', id: event.id },
          { type: 'show-undo', id: event.id },
        ],
      };
    }
    case 'undo': {
      if (phase !== 'undoable') return unchanged(state);
      const next = new Map(state);
      next.delete(event.id);
      return {
        state: next,
        effects: [
          { type: 'cancel-timer', id: event.id },
          { type: 'restore', id: event.id },
        ],
      };
    }
    case 'deadline': {
      if (phase !== 'undoable') return unchanged(state);
      const next = new Map(state);
      next.set(event.id, 'removing');
      return { state: next, effects: [{ type: 'remove', id: event.id }] };
    }
    case 'remove-succeeded': {
      if (phase !== 'removing') return unchanged(state);
      const next = new Map(state);
      next.delete(event.id);
      return { state: next, effects: [] };
    }
    case 'remove-failed': {
      if (phase !== 'removing') return unchanged(state);
      const next = new Map(state);
      next.delete(event.id);
      return {
        state: next,
        effects: [
          { type: 'restore', id: event.id },
          { type: 'show-error', id: event.id },
        ],
      };
    }
  }
}
