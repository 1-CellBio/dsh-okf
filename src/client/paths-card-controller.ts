import { PathsForm, type PathSettingsScope, type PathsCardState } from "./paths-form.ts";

export type PathsCardFace = {
  hooks: {
    kgPaths: {
      getSnapshot: () => PathsCardState;
      subscribe: (listener: () => void) => () => void;
    };
  };
  edit: (field: "okfDir" | "pdfDir" | "exportDir", text: string) => void;
  resetField: (field: "okfDir" | "pdfDir" | "exportDir") => void;
  save: () => void;
  discard: () => void;
};

/** Bridges the `okf` settings scope onto the path card. */
export class PathsCardController {
  private readonly form: PathsForm;
  private readonly store: PathsCardFace["hooks"]["kgPaths"];

  constructor(scope: PathSettingsScope) {
    this.form = new PathsForm(scope);
    this.store = this.form.bindStore();
  }

  inject(): PathsCardFace {
    return { hooks: { kgPaths: this.store }, ...this.form.actions() };
  }
}
