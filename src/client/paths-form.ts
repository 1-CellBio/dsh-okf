/** One settings-namespace snapshot the paths form reads. */
export type PathScopeSnapshot = {
  status: "loading" | "ready" | "unavailable";
  writable: boolean;
  value?: Record<string, unknown>;
  base?: Record<string, unknown>;
  user?: Record<string, unknown>;
};

/** Host settings scope subset the card needs. */
export type PathSettingsScope = {
  getSnapshot: () => PathScopeSnapshot;
  subscribe: (listener: () => void) => () => void;
  set: (field: string, value: unknown) => Promise<void>;
  unset: (field: string) => Promise<void>;
};

export type PathFieldName = "okfDir" | "pdfDir" | "exportDir";

export type PathFieldState = {
  text: string;
  overridden: boolean;
};

export type PathsCardState = {
  available: boolean;
  writable: boolean;
  dirty: boolean;
  saving: boolean;
  failed: boolean;
  okfDir: PathFieldState;
  pdfDir: PathFieldState;
  exportDir: PathFieldState;
};

type Staged = { text: string; clear: boolean };

const FIELDS: readonly PathFieldName[] = ["okfDir", "pdfDir", "exportDir"];

/**
 * Staged path-directory form over the `okf` settings namespace.
 * Save is the only write; empty text clears the user layer.
 */
export class PathsForm {
  private readonly staged = new Map<PathFieldName, Staged>();
  private readonly listeners = new Set<() => void>();
  private saving = false;
  private failed = false;

  constructor(private readonly scope: PathSettingsScope) {
    scope.subscribe(() => {
      this.publish();
    });
  }

  snapshot(): PathsCardState {
    return {
      available: this.scope.getSnapshot().status === "ready",
      writable: this.scope.getSnapshot().writable,
      dirty: this.staged.size > 0,
      saving: this.saving,
      failed: this.failed,
      okfDir: this.field("okfDir"),
      pdfDir: this.field("pdfDir"),
      exportDir: this.field("exportDir"),
    };
  }

  bindStore(): {
    getSnapshot: () => PathsCardState;
    subscribe: (listener: () => void) => () => void;
  } {
    let current = this.snapshot();
    const outer = new Set<() => void>();
    this.listeners.add(() => {
      current = this.snapshot();
      for (const listener of outer) listener();
    });
    return {
      getSnapshot: () => current,
      subscribe: (listener) => {
        outer.add(listener);
        return () => {
          outer.delete(listener);
        };
      },
    };
  }

  actions(): {
    edit: (field: PathFieldName, text: string) => void;
    resetField: (field: PathFieldName) => void;
    save: () => void;
    discard: () => void;
  } {
    return {
      edit: (field, text) => {
        this.staged.set(field, { text, clear: false });
        this.failed = false;
        this.publish();
      },
      resetField: (field) => {
        this.staged.set(field, { text: this.baseText(field), clear: true });
        this.failed = false;
        this.publish();
      },
      save: () => {
        void this.save();
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) {
          return;
        }
        this.staged.clear();
        this.failed = false;
        this.publish();
      },
    };
  }

  async save(): Promise<void> {
    if (this.saving || this.staged.size === 0) {
      return;
    }
    this.saving = true;
    this.failed = false;
    this.publish();
    let landed = true;
    try {
      for (const field of FIELDS) {
        const staged = this.staged.get(field);
        if (staged === undefined) {
          continue;
        }
        const ok = staged.clear || staged.text.trim() === ""
          ? await this.clear(field)
          : await this.store(field, staged.text.trim());
        landed = ok && landed;
      }
    } catch {
      // A rejected set/unset must not leave the form stuck in "saving" with an
      // unhandled rejection: surface the failure and keep the staged values so
      // the user can retry.
      landed = false;
    }
    if (landed) {
      this.staged.clear();
    }
    this.saving = false;
    this.failed = !landed;
    this.publish();
  }

  private field(name: PathFieldName): PathFieldState {
    const staged = this.staged.get(name);
    if (staged === undefined) {
      return { text: this.sectionText(name), overridden: this.stored(name) };
    }
    if (staged.clear) {
      return { text: staged.text, overridden: false };
    }
    return { text: staged.text, overridden: staged.text.trim() !== "" };
  }

  private sectionText(name: PathFieldName): string {
    const value = this.scope.getSnapshot().value?.[name];
    return typeof value === "string" ? value : "";
  }

  private baseText(name: PathFieldName): string {
    const value = this.scope.getSnapshot().base?.[name];
    return typeof value === "string" ? value : "";
  }

  private stored(name: PathFieldName): boolean {
    const user = this.scope.getSnapshot().user;
    return user !== undefined && Object.hasOwn(user, name);
  }

  private async clear(field: PathFieldName): Promise<boolean> {
    await this.scope.unset(field);
    return !this.stored(field);
  }

  private async store(field: PathFieldName, value: string): Promise<boolean> {
    await this.scope.set(field, value);
    return this.scope.getSnapshot().user?.[field] === value;
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
